/**
 * VFS registry for the native shell — Fase 3.
 *
 * Extensions can mount their own `scheme://` filesystems inside the embedded
 * brush shell. The addon's `ShellFilesystem` bridge routes only URL paths to
 * the JS handler (`nativeLocalPaths: true`); every ordinary host path keeps
 * running natively, so providers can never intercept the real filesystem.
 *
 * Wire contract (from the addon's index.d.ts):
 * - requests carry `op` (35 ops) plus op-specific fields; errors travel as
 *   data (`{ error: { code: "ENOENT", message } }`) so errno identity
 *   survives the JS boundary;
 * - `open` returns a numeric `handle`; subsequent `read`/`write`/`close`
 *   reference it;
 * - two-path ops (rename, hardlink, symlink) arrive with `path` + `target`;
 *   the provider of `path` owns the whole op (cross-backend → `EXDEV`).
 *
 * `registerVfsScheme` returns an unregister function. The merged filesystem
 * is built once per shell run by shell-ops via `buildShellFilesystem()`.
 */

export type ShellFsRequest = import("@oh-my-pi/pi-natives").ShellFsRequest;
export type ShellFsResponse = import("@oh-my-pi/pi-natives").ShellFsResponse;
export type ShellFilesystem = import("@oh-my-pi/pi-natives").ShellFilesystem;

/** Simplified handler: registry routes to you, you answer the request. */
export type VfsHandler = (request: ShellFsRequest) => Promise<ShellFsResponse>;

const schemes = new Map<string, VfsHandler>();

/** RFC 3986 scheme with `://` authority (pi-vfs rule: ≥2 chars, so `C://` stays a drive path). */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,}):\/\//;

/** Extract the scheme of a path, lowercase, or null for plain paths. */
export function schemeOf(path: string | undefined): string | null {
	if (!path) return null;
	const match = SCHEME_RE.exec(path);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Mount a handler for a `scheme://` namespace inside the embedded shell.
 * Returns an unregister function. Re-registering a scheme replaces the
 * previous handler.
 */
export function registerVfsScheme(scheme: string, handler: VfsHandler): () => void {
	const normalized = scheme.replace(/:\/\/*$/, "").toLowerCase();
	if (!SCHEME_RE.test(`${normalized}://`) || normalized.length < 2) {
		throw new Error(`Invalid VFS scheme: '${scheme}' (expected RFC 3986 scheme, ≥2 chars)`);
	}
	schemes.set(normalized, handler);
	return () => {
		if (schemes.get(normalized) === handler) schemes.delete(normalized);
	};
}

export function hasVfsSchemes(): boolean {
	return schemes.size > 0;
}

/** List registered schemes (diagnostics). */
export function registeredVfsSchemes(): string[] {
	return [...schemes.keys()].sort();
}

function err(code: string, message: string): ShellFsResponse {
	return { error: { code, message } };
}

/** Ops that address an open handle (no `path` — routing goes by handle). */
const HANDLE_OPS = new Set(["read", "write", "flush", "close", "fileMetadata", "isLocked", "setLen", "sync"]);

/**
 * Handle ownership. Providers return their own handle numbers, which can
 * collide across providers, so the registry remaps every `open` answer to a
 * globally-unique handle and translates back on handle-addressed ops. Live
 * across runs: a provider handle issued in one command stays routable until
 * its `close` (including post-abort `cleanup` requests).
 */
let nextVfsHandle = 1;
const handleRoutes = new Map<number, { handler: VfsHandler; providerHandle: number }>();

/**
 * Build the `ShellFilesystem` to pass into shell runs, or `undefined` when
 * no schemes are mounted (shells then run on the plain native filesystem).
 */
export function buildShellFilesystem(): ShellFilesystem | undefined {
	if (schemes.size === 0) return undefined;
	return {
		nativeLocalPaths: true,
		handler: async (error, request) => {
			if (error) return err("EIO", error.message);
			const op = String(request.op);

			// Handle-addressed ops: route through the handle table.
			if (HANDLE_OPS.has(op)) {
				const route = handleRoutes.get(Number(request.handle ?? -1));
				if (!route) {
					return err("EBADF", `VFS: unknown or already-closed handle ${request.handle ?? "(none)"}`);
				}
				try {
					const response = await route.handler({ ...request, handle: route.providerHandle });
					if (op === "close") handleRoutes.delete(Number(request.handle));
					return response;
				} catch (cause) {
					return err("EIO", cause instanceof Error ? cause.message : String(cause));
				}
			}

			const scheme = schemeOf(request.path);
			if (!scheme) {
				return err("EIO", `VFS request without path or handle: op ${op}`);
			}
			const handler = schemes.get(scheme);
			if (!handler) {
				return err("ENOENT", `No VFS provider mounted for scheme '${scheme}://' (registered: ${registeredVfsSchemes().join(", ") || "none"})`);
			}
			try {
				const response = await handler(request);
				// Remap provider handles to registry-unique ids.
				if (op === "open" && response.handle !== undefined) {
					const vfsHandle = nextVfsHandle++;
					handleRoutes.set(vfsHandle, { handler, providerHandle: response.handle });
					return { ...response, handle: vfsHandle };
				}
				return response;
			} catch (cause) {
				return err("EIO", cause instanceof Error ? cause.message : String(cause));
			}
		},
	};
}

/** Drop every registered scheme and handle route (pi `session_shutdown` hook). */
export function clearVfsSchemes(): void {
	schemes.clear();
	handleRoutes.clear();
}