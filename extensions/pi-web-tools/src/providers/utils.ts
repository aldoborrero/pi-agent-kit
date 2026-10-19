import { execSync } from "node:child_process";
import { convert } from "html-to-text";
import type { SearchResult, WebBackendConfig } from "../search-registry.ts";

const credentialCache = new Map<string, string | undefined>();

/** Default outbound request timeout for web-search backends. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** Default outbound request timeout for content fetches (pages can be slow/large). */
export const FETCH_TIMEOUT_MS = 60_000;

/**
 * Combine a caller-provided abort signal with a bounded timeout so an outbound
 * request always terminates even if the caller signal never fires. The caller
 * signal is still honored (whichever aborts first wins).
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signals = [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[];
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/**
 * Turn an unsuccessful HTTP response into a compact, safe error message.
 * Upstream bodies can be large or contain injected/control content, so we
 * truncate to a short prefix and strip control characters before surfacing
 * them to the caller (and, ultimately, the LLM).
 */
export function scrubUpstreamBody(body: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars from untrusted upstream bodies
  return body.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function describeHttpError(label: string, response: Response): Promise<string> {
  let detail = "";
  try {
    const body = scrubUpstreamBody(await response.text());
    if (body) detail = `: ${truncate(body, 200).text}`;
  } catch {
    // ignore body read failures; status/statusText is enough
  }
  return `${label} (${response.status} ${response.statusText})${detail}`;
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\*\./, "");
}

function hostnameMatches(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = normalizeDomain(domain);
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export function filterByDomains(results: SearchResult[], includeDomains?: string[], excludeDomains?: string[]): SearchResult[] {
  return results.filter((result) => {
    try {
      const hostname = new URL(result.url).hostname;
      if (includeDomains?.length && !includeDomains.some((domain) => hostnameMatches(hostname, domain))) {
        return false;
      }
      if (excludeDomains?.length && excludeDomains.some((domain) => hostnameMatches(hostname, domain))) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
}

export function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    deduped.push(result);
  }
  return deduped;
}

export function stripHtmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
    ],
  }).replace(/\n{3,}/g, "\n\n").trim();
}

/** Decode HTML entities and strip tags (lightweight, for snippets). */
export function decodeHtml(text: string): string {
  return convert(text, {
    wordwrap: false,
    selectors: [{ selector: "a", options: { ignoreHref: true } }],
  }).replace(/\s+/g, " ").trim();
}

function resolveCredentialReference(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const trimmed = reference.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined" || trimmed === "none") return undefined;

  if (trimmed.startsWith("!")) {
    const cached = credentialCache.get(trimmed);
    if (cached !== undefined) return cached || undefined;
    const value = execSync(trimmed.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    credentialCache.set(trimmed, value);
    return value || undefined;
  }

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    return process.env[trimmed]?.trim() || undefined;
  }

  return trimmed;
}

export function resolveApiKey(config: WebBackendConfig | undefined, envNames: string[]): string | undefined {
  const configured = resolveCredentialReference(config?.apiKey);
  if (configured) return configured;
  for (const envName of envNames) {
    const value = process.env[envName]?.trim();
    if (value) return value;
  }
  return undefined;
}
