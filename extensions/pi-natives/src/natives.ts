/**
 * Shared graceful loader for @oh-my-pi/pi-natives.
 *
 * The native addon ships as platform-scoped npm optionalDependencies; if it
 * is unavailable (unsupported platform, pruned install), consumers get null
 * and must fall back to their JS implementations. The result is cached so
 * every consumer in the process shares one load attempt.
 */

type Natives = typeof import("@oh-my-pi/pi-natives");

let cached: Natives | null | undefined;
let loadError: string | null = null;

export async function loadNatives(): Promise<Natives | null> {
	if (cached !== undefined) return cached;
	try {
		cached = (await import("@oh-my-pi/pi-natives")) as Natives;
	} catch (error) {
		cached = null;
		loadError = error instanceof Error ? error.message : String(error);
	}
	return cached;
}

/** Why the native module is unavailable, if it is. */
export function nativesLoadError(): string | null {
	return loadError;
}