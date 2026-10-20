/**
 * Pure suggestion-text processing: model-output parsing and filtering.
 * No imports from the extension runtime — fully unit-testable.
 */

export type SuggestFilterResult = { suggestion: string | null; reason: string | null };

export function filterSuggestion(raw: string | null): { suggestion: string | null; reason: string | null } {
  if (typeof raw !== "string" || !raw) return { suggestion: null, reason: "model returned empty output" };
  const suggestion = raw.trim();
  if (!suggestion) return { suggestion: null, reason: "model returned blank output" };

  const lower = suggestion.toLowerCase();
  const wordCount = suggestion.split(/\s+/).length;

  if (wordCount < 2 && !suggestion.startsWith("/")) {
    const allowed = new Set([
      // affirmatives
      "yes", "yeah", "yep", "yea", "yup", "sure",
      // negation
      "no",
      // neutral
      "ok", "okay",
      // common one-word actions
      "continue", "commit", "push", "deploy", "stop", "check", "exit", "quit",
    ]);
    if (!allowed.has(lower)) return { suggestion: null, reason: "single-word suggestion not allowlisted" };
  }

  if (wordCount > 12) return { suggestion: null, reason: "suggestion exceeded 12 words" };
  if (suggestion.length >= 100) return { suggestion: null, reason: "suggestion exceeded 100 characters" };
  if (/^\w+:\s/.test(suggestion)) return { suggestion: null, reason: "suggestion looked like a labeled response" };
  if (/^\(.*\)$|^\[.*\]$/.test(suggestion)) return { suggestion: null, reason: "suggestion was wrapped in brackets" };
  if (/[\n*]/.test(suggestion)) return { suggestion: null, reason: "suggestion contained newline or markdown bullets" };
  if (/[.!?]\s+[A-ZÁÉÍÓÚÑÜ]/.test(suggestion)) return { suggestion: null, reason: "suggestion looked like multiple sentences" };
  if (/^(let me|i'll|i can|here('| i)?s|you should|you could|sure,|of course|certainly)/i.test(suggestion)) {
    return { suggestion: null, reason: "suggestion used assistant voice" };
  }
  if (/(thanks|thank you|looks good|sounds good|perfect|awesome|great)[!?.]*$/i.test(lower)) {
    return { suggestion: null, reason: "suggestion ended with evaluative filler" };
  }
  if (/^(nothing found|no suggestion|stay silent|silence)$/i.test(lower)) {
    return { suggestion: null, reason: "model explicitly declined to suggest" };
  }

  return { suggestion, reason: null };
}

export function parseSuggestionArray(raw: string | null): { suggestions: string[]; reason: string | null } {
  if (!raw) return { suggestions: [], reason: "model returned empty output" };

  const candidate = extractJsonArrayText(raw.trim());
  if (!candidate) return { suggestions: [], reason: "model did not return a JSON array" };

  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return { suggestions: [], reason: "model did not return a JSON array" };

    const seen = new Set<string>();
    const suggestions: string[] = [];
    let lastReason: string | null = null;

    for (const item of parsed) {
      if (typeof item !== "string") {
        lastReason = "JSON array contained non-string items";
        continue;
      }
      const filtered = filterSuggestion(item);
      if (!filtered.suggestion) {
        lastReason = filtered.reason;
        continue;
      }
      const key = filtered.suggestion.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(filtered.suggestion);
      if (suggestions.length >= 3) break;
    }

    return {
      suggestions,
      reason: suggestions.length > 0 ? null : (lastReason ?? "all suggestions were filtered"),
    };
  } catch {
    return { suggestions: [], reason: "model returned invalid JSON" };
  }
}

export function extractJsonArrayText(raw: string): string | null {
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = fenced ? fenced[1].trim() : raw;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}
