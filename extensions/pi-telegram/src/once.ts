/**
 * Per-instance idempotency guard for extension activation.
 *
 * pi-agent-kit (the meta-package) invokes this package's factory, and a
 * standalone install makes Pi invoke it again — sometimes against the SAME
 * `pi`. We must dedupe that. But Pi rebuilds the extension runtime on /new,
 * /resume, /fork, and /reload, handing the factory a BRAND-NEW `pi`; that
 * must re-register.
 *
 * Keying the registry on the `pi` instance satisfies both: same instance =>
 * skip, new instance => run. The registry lives on globalThis because jiti
 * (`moduleCache: false`) re-evaluates this module on every load pass, so a
 * module-scoped WeakMap would not be shared between the aggregator pass and
 * the standalone pass within a single session.
 */
export function once(pi: object, key: string, fn: () => void): void {
	const g = globalThis as { __piOnce?: WeakMap<object, Set<string>> };
	const registry = (g.__piOnce ??= new WeakMap<object, Set<string>>());
	let loaded = registry.get(pi);
	if (!loaded) {
		loaded = new Set<string>();
		registry.set(pi, loaded);
	}
	if (loaded.has(key)) return;
	loaded.add(key);
	fn();
}
