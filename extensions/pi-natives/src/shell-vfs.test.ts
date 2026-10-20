import { describe, expect, test } from "bun:test";
import {
	buildShellFilesystem,
	clearVfsSchemes,
	hasVfsSchemes,
	registerVfsScheme,
	type ShellFsRequest,
	schemeOf,
} from "./shell-vfs.ts";
import { loadNatives } from "./natives.ts";
import { createNativeShellOperations } from "./shell-ops.ts";

// ─── Registry unit tests (no addon needed) ───────────────────────────

test("schemeOf extracts lowercase schemes and rejects plain paths", () => {
	expect(schemeOf("mem://docs/hello.txt")).toBe("mem");
	expect(schemeOf("MEM://x")).toBe("mem");
	expect(schemeOf("/home/aldo/x")).toBeNull();
	expect(schemeOf("C://x")).toBeNull(); // drive path, ≥2-char rule
	expect(schemeOf(undefined)).toBeNull();
	expect(schemeOf("a://x")).toBeNull(); // 1-char scheme rejected (pi-vfs rule)
});

test("registerVfsScheme validates schemes and unregister works", () => {
	expect(() => registerVfsScheme("x", async () => ({}))).toThrow(/Invalid VFS scheme/);
	const unregister = registerVfsScheme("unit-test", async () => ({}));
	expect(hasVfsSchemes()).toBe(true);
	unregister();
	expect(hasVfsSchemes()).toBe(false);
});

test("buildShellFilesystem returns undefined with no schemes", () => {
	clearVfsSchemes();
	expect(buildShellFilesystem()).toBeUndefined();
});

test("router: unknown scheme answers ENOENT naming registered schemes", async () => {
	clearVfsSchemes();
	registerVfsScheme("known", async () => ({}));
	const fs = buildShellFilesystem()!;
	const response = await fs.handler(null, { op: "metadata", path: "unknown://x" } as ShellFsRequest);
	expect(response.error?.code).toBe("ENOENT");
	expect(response.error?.message).toContain("known://");
});

test("router: handler throw becomes an EIO data error", async () => {
	clearVfsSchemes();
	registerVfsScheme("boom", async () => {
		throw new Error("provider exploded");
	});
	const fs = buildShellFilesystem()!;
	const response = await fs.handler(null, { op: "metadata", path: "boom://x" } as ShellFsRequest);
	expect(response.error?.code).toBe("EIO");
	expect(response.error?.message).toContain("provider exploded");
});

test("router: open handles are remapped and handle ops route back to the provider", async () => {
	clearVfsSchemes();
	const seen: string[] = [];
	registerVfsScheme("mem", async (request) => {
		const op = String(request.op);
		seen.push(`${op}:${request.handle ?? request.path}`);
		if (op === "open") return { handle: 7 }; // provider-local handle
		if (op === "read") return { data: new Uint8Array(Buffer.from("ok")) };
		return {};
	});
	const fs = buildShellFilesystem()!;
	const opened = await fs.handler(null, { op: "open", path: "mem://x", open: { read: true, write: false, append: false, truncate: false, create: false, createNew: false } } as ShellFsRequest);
	expect(opened.handle).toBeDefined();
	expect(opened.handle).not.toBe(7); // remapped, no collision with provider space
	const read = await fs.handler(null, { op: "read", handle: opened.handle, offset: 0n, length: 4 } as ShellFsRequest);
	expect(Buffer.from(read.data!).toString()).toBe("ok");
	// The provider saw its own handle, not the remapped one.
	expect(seen).toContain(`read:7`);
});

// ─── End-to-end through the real brush shell ─────────────────────────

const natives = await loadNatives();
const d = natives?.Shell ? describe : describe.skip;

/** Minimal read-only in-memory FS provider for mem:// — demo of the wire contract. */
function mountMemFs(files: Record<string, string>, dirs: string[] = []): void {
	type Node = { kind: "dir" } | { kind: "file"; data: Buffer };
	const tree = new Map<string, Node>();
	const norm = (p: string) => {
		const rest = p.replace(/^mem:\/\/\/?/, "");
		return `mem://${rest.replace(/\/+$/, "")}`;
	};
	for (const [name, content] of Object.entries(files)) {
		tree.set(norm(name), { kind: "file", data: Buffer.from(content, "utf8") });
		const parts = name.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			tree.set(norm(parts.slice(0, i).join("/")), { kind: "dir" });
		}
	}
	for (const dir of dirs) tree.set(norm(dir), { kind: "dir" });

	const nodeAt = (path: string): Node | undefined => tree.get(norm(path));
	const childrenOf = (path: string): string[] => {
		const base = norm(path);
		const prefix = base === "mem://" ? "mem:///" : `${base}/`;
		const names = new Set<string>();
		for (const key of tree.keys()) {
			if (key.startsWith(prefix) && key !== base) {
				names.add(key.slice(prefix.length).split("/")[0]);
			}
		}
		return [...names];
	};

	// Open handles: read requests carry only the handle, not the path.
	let nextHandle = 1;
	const handles = new Map<number, { node: { kind: "file"; data: Buffer } }>();

	registerVfsScheme("mem", async (request) => {
		const op = String(request.op);
		const path = request.path ?? "";
		const node = nodeAt(path);
		switch (op) {
			case "metadata":
			case "symlinkMetadata": {
				if (!node) return { error: { code: "ENOENT", message: `mem: not found: ${path}` } };
				return {
					metadata:
						node.kind === "dir"
							? { fileType: "dir", size: 0, mode: 0o755 }
							: { fileType: "file", size: node.data.length, mode: 0o644 },
				};
			}
			case "access":
				return { access: { read: Boolean(node), write: false, execute: false } };
			case "readDir":
				if (!node || node.kind !== "dir") return { error: { code: "ENOTDIR", message: `mem: not a dir: ${path}` } };
				return {
					entries: childrenOf(path).map((name) => {
						const child = nodeAt(`${path.replace(/\/$/, "")}/${name}`);
						return { name, fileType: child?.kind === "dir" ? "dir" : "file" } as const;
					}),
				};
			case "open": {
				const flags = request.open as { read?: boolean; write?: boolean; append?: boolean; truncate?: boolean; create?: boolean; createNew?: boolean };
				// Read-only FS: refuse write-ish opens before even looking (a
				// `>` redirect opens with create|write|truncate on a new path).
				if (flags?.write || flags?.append || flags?.truncate || flags?.create || flags?.createNew) {
					return { error: { code: "EROFS", message: "mem:// is read-only" } };
				}
				if (!node || node.kind !== "file") return { error: { code: "ENOENT", message: `mem: not a file: ${path}` } };
				const handle = nextHandle++;
				handles.set(handle, { node });
				return { handle };
			}
			case "read": {
				const opened = handles.get(Number(request.handle ?? -1));
				if (!opened) return { error: { code: "EBADF", message: "mem: bad handle" } };
				const offset = Number(request.offset ?? 0);
				const length = request.length ?? opened.node.data.length;
				return { data: new Uint8Array(opened.node.data.subarray(offset, offset + length)) };
			}
			case "close": {
				handles.delete(Number(request.handle ?? -1));
				return {};
			}
			case "backingPath":
				return {}; // nothing on the host backs mem://
			default:
				return { error: { code: "EROFS", message: `mem:// is read-only (op ${op})` } };
		}
	});
}

d("mem:// VFS through the real brush shell", () => {
	test("globs expand over VFS readDir (echo * in a mem:// cwd)", async () => {
		clearVfsSchemes();
		mountMemFs({ "docs/hello.txt": "hi" }, ["docs/sub"]);
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		const result = await ops.exec("cd mem://docs && echo *", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).toBe(0);
		const out = Buffer.concat(chunks).toString();
		expect(out).toContain("hello.txt");
		expect(out).toContain("sub");
	});

	test("builtins read VFS files via redirection", async () => {
		clearVfsSchemes();
		mountMemFs({ "greeting.txt": "hola desde mem://\n" });
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		const result = await ops.exec(
			'IFS= read -r line < mem://greeting.txt; echo "got:$line"',
			process.cwd(),
			{ onData: (data) => chunks.push(data) },
		);
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("got:hola desde mem://");
	});

	test("writes fail read-only (EROFS surfaces as command failure)", async () => {
		clearVfsSchemes();
		mountMemFs({ "a.txt": "x" });
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		const result = await ops.exec("echo nope > mem://blocked.txt", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).not.toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("Read-only file system");
	});

	test("unmounted schemes fail with a helpful error", async () => {
		clearVfsSchemes();
		mountMemFs({ "a.txt": "x" });
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		const result = await ops.exec("echo hi > nope://x.txt", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).not.toBe(0);
	});
});