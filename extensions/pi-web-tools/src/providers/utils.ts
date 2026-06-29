import { execSync } from "node:child_process";
import type { SearchResult, WebBackendConfig } from "../search-registry.ts";

const credentialCache = new Map<string, string | undefined>();

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
