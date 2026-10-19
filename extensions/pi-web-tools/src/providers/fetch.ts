import type { WebFetchProvider } from "../fetch-registry.ts";
import { FETCH_TIMEOUT_MS, stripHtmlToText, withTimeout } from "./utils.ts";

const JINA_BASE = "https://r.jina.ai";

export async function fetchJina(url: URL, signal?: AbortSignal): Promise<{ text: string; source: string }> {
  const response = await fetch(`${JINA_BASE}/${url.toString()}`, {
    headers: { Accept: "text/markdown" },
    signal: withTimeout(signal, FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Jina fetch failed: ${response.status} ${response.statusText}`);
  }
  return { text: await response.text(), source: "jina" };
}

export async function fetchNative(url: URL, signal?: AbortSignal): Promise<{ text: string; source: string }> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "pi-agent-kit/1.0 web-tools native-fetch",
    },
    redirect: "follow",
    signal: withTimeout(signal, FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${url.toString()}`);
  }
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
  return {
    text: isHtml ? stripHtmlToText(raw) : raw,
    source: "native",
  };
}
