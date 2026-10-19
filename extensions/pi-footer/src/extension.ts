/**
 * Custom Footer Extension - shows working directory, git branch, model, context usage, and extension statuses
 * URL: https://github.com/Mic92/dotfiles/blob/main/home/.pi/agent/extensions/custom-footer.ts
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { once } from "./once.ts";
import {
  createUiColors,
  DEFAULT_ERROR_PERCENT,
  DEFAULT_WARNING_PERCENT,
} from "@aldoborrero/pi-common";

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const MIN_LEFT_SPACE = 12;
// Below this a shortened branch name no longer identifies the branch.
const MIN_BRANCH_WIDTH = 10;
const GIT_CACHE_TTL_MS = 1_500;
const RENDER_DEBOUNCE_MS = 75;
const TPS_RENDER_DEBOUNCE_MS = 200;
// Width reserved for the live rate when deciding where statuses go.
const TPS_PLACEHOLDER = "000 t/s";
const GIT_ICON = "󰊢";

const execFileAsync = promisify(execFile);

type StatusPriority = "error" | "warning" | "info";

type FooterStatus = {
  key: string;
  raw: string;
  text: string;
  priority: StatusPriority;
};

type FooterColorName =
  | "primary"
  | "meta"
  | "success"
  | "warning"
  | "danger"
  | "subtle"
  | "text"
  | "model"
  | ThemeColor;

type CustomFooterItem = {
  id: string;
  statusKey: string;
  position: "left" | "right";
  prefix?: string;
  color?: FooterColorName;
  hideWhenMissing: boolean;
  excludeFromStatuses: boolean;
};

type RenderedCustomStatus = {
  text: string;
  color?: FooterColorName;
};

type FooterConfig = {
  customItems: CustomFooterItem[];
};

type GitStatus = {
  dirty: boolean;
  staged: number;
  untracked: number;
  unstaged: number;
  ahead: number;
  behind: number;
};

type SessionTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type UsageEntryLike = {
  type: string;
  usage?: UsageLike;
  message?: {
    role?: string;
    usage?: UsageLike;
    stopReason?: string;
    model?: string;
    thinkingLevel?: string;
  };
};

/** The physical model a virtual model sent the latest response to. */
type RoutedModel = {
  id: string;
  thinking?: string;
};

/** `tokens` and `percent` are null while Pi cannot know them, e.g. right after compaction. */
type ContextUsageState = {
  tokens: number | null;
  window: number;
  percent: number | null;
};

type FooterDensity = "wide" | "full" | "comfortable" | "compact" | "minimal";

type AdaptiveLayout = {
  density: FooterDensity;
  contextMode: "full" | "compact" | "percent";
  cwdMode: "full" | "basename";
  showSessionName: boolean;
  showBranch: boolean;
  showGitMarkers: boolean;
  showCustomItems: boolean;
  showSessionTokens: boolean;
  showCost: boolean;
  showThinking: boolean;
  showAutoCompact: boolean;
  showProvider: boolean;
  maxModelWidth: number;
};

export type FooterState = {
  workspace: {
    shortCwd: string;
    branch: string;
    git: GitStatus | null;
  };
  context: ContextUsageState;
  /** Whether Pi compacts the context on its own; undefined when Pi does not say. */
  autoCompact?: boolean;
  model: {
    id: string;
    thinking: string;
    /** Set only when several providers are available, as in Pi's own footer. */
    provider?: string;
    routed?: RoutedModel;
  };
  session: {
    name?: string;
    totals: SessionTotals;
    /** Share of the latest prompt served from cache, in percent. */
    cacheHitRate?: number;
  };
  cost: {
    totalUsd: number;
    /** The active provider bills a subscription, so the cost is only nominal. */
    subscription?: boolean;
  };
  statuses: FooterStatus[];
  customLeft: RenderedCustomStatus[];
  customRight: RenderedCustomStatus[];
};

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function shortenMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);

  const keep = maxWidth - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}

function basenamePath(path: string): string {
  if (!path || path === "/" || path === "~") return path || ".";
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const parts = trimmed.split("/").filter(Boolean);
  const last = parts.at(-1) ?? trimmed;
  return trimmed.startsWith("~/") ? `~/${last}` : last;
}

function normalizeModelId(rawId: string): string {
  const withoutProvider = rawId
    .replace(/^models\//, "")
    .split("/")
    .filter(Boolean)
    .at(-1) ?? rawId;
  const id = withoutProvider
    .replace(/^models\//, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");

  const claude35 = id.match(/^claude-(\d+)-(\d+)-(haiku|sonnet|opus)(?:-.+)?$/);
  if (claude35) return `${claude35[3]}-${claude35[1]}.${claude35[2]}`;

  const claude4 = id.match(/^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?(?:-.+)?$/);
  if (claude4) return `${claude4[1]}-${claude4[2]}${claude4[3] ? `.${claude4[3]}` : ""}`;

  return id
    .replace(/^gpt-5-chat-latest$/, "gpt-5-chat")
    .replace(/^gpt-4\.1-/, "gpt-4.1-")
    .replace(/^gemini-2\.5-pro-preview-.+$/, "gemini-2.5-pro")
    .replace(/^gemini-2\.5-flash-preview-.+$/, "gemini-2.5-flash");
}

function baseDensityForWidth(width: number): FooterDensity {
  if (width >= 140) return "wide";
  if (width >= 112) return "full";
  if (width >= 88) return "comfortable";
  if (width >= 64) return "compact";
  return "minimal";
}

function layoutForDensity(density: FooterDensity, width: number): AdaptiveLayout {
  switch (density) {
    // The details borrowed from Pi's own footer cost about twenty columns. Below
    // this width they would take them from the branch name and git markers.
    case "wide":
      return {
        density,
        contextMode: "full",
        cwdMode: "full",
        showSessionName: true,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: true,
        showCost: true,
        showThinking: true,
        showAutoCompact: true,
        showProvider: true,
        maxModelWidth: 32,
      };
    case "full":
      return {
        density,
        contextMode: "full",
        cwdMode: "full",
        showSessionName: true,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: true,
        showCost: true,
        showThinking: true,
        showAutoCompact: false,
        showProvider: false,
        maxModelWidth: 32,
      };
    case "comfortable":
      return {
        density,
        contextMode: "full",
        cwdMode: "full",
        showSessionName: false,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: true,
        showCost: true,
        showThinking: true,
        showAutoCompact: false,
        showProvider: false,
        maxModelWidth: 24,
      };
    case "compact":
      return {
        density,
        contextMode: "compact",
        cwdMode: "basename",
        showSessionName: false,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: false,
        showCost: false,
        showThinking: true,
        showAutoCompact: false,
        showProvider: false,
        maxModelWidth: 18,
      };
    case "minimal":
      return {
        density,
        contextMode: "percent",
        cwdMode: "basename",
        showSessionName: false,
        showBranch: width >= 48,
        showGitMarkers: false,
        showCustomItems: false,
        showSessionTokens: false,
        showCost: false,
        showThinking: false,
        showAutoCompact: false,
        showProvider: false,
        maxModelWidth: 14,
      };
  }
}

function nextNarrowerDensity(density: FooterDensity): FooterDensity | null {
  if (density === "wide") return "full";
  if (density === "full") return "comfortable";
  if (density === "comfortable") return "compact";
  if (density === "compact") return "minimal";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value)
      ? mergeSettings(existing, value)
      : value;
  }
  return merged;
}

function readSettings(cwd: string): Record<string, unknown> {
  const globalPath = join(homedir(), ".pi", "agent", "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  return mergeSettings(readJsonObject(globalPath), readJsonObject(projectPath));
}

function parseCustomFooterItem(raw: unknown, idOverride?: string): CustomFooterItem | null {
  if (!isRecord(raw)) return null;
  const id = typeof idOverride === "string"
    ? idOverride
    : typeof raw.id === "string"
      ? raw.id
      : "";
  const normalizedId = id.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(normalizedId)) return null;

  const statusKey = typeof raw.statusKey === "string" && raw.statusKey.trim()
    ? raw.statusKey.trim()
    : normalizedId;
  const position = raw.position === "right" ? "right" : "left";
  const prefix = typeof raw.prefix === "string" && raw.prefix.trim()
    ? raw.prefix.trim()
    : undefined;
  const color = typeof raw.color === "string" && raw.color.trim()
    ? raw.color.trim() as FooterColorName
    : undefined;

  return {
    id: normalizedId,
    statusKey,
    position,
    prefix,
    color,
    hideWhenMissing: raw.hideWhenMissing !== false,
    excludeFromStatuses: raw.excludeFromStatuses !== false,
  };
}

function parseCustomFooterItems(raw: unknown): CustomFooterItem[] {
  const items: CustomFooterItem[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const item = parseCustomFooterItem(entry);
      if (item) items.push(item);
    }
  } else if (isRecord(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const item = parseCustomFooterItem(entry, id);
      if (item) items.push(item);
    }
  }

  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function parseFooterConfig(settings: Record<string, unknown>): FooterConfig {
  const raw = isRecord(settings.footer)
    ? settings.footer
    : isRecord(settings.piFooter)
      ? settings.piFooter
      : {};
  return {
    customItems: parseCustomFooterItems(raw.customItems),
  };
}

function classifyStatus(text: string): StatusPriority {
  const normalized = text.toLowerCase();
  // Match whole words so substrings don't misclassify (e.g. "locked" inside
  // the healthy "unlocked" state must not read as an error).
  if (/\b(error|missing|unconfigured|locked|off)\b/.test(normalized)) {
    return "error";
  }
  if (/\b(warning|no-key|setup|blocked|restricted)\b/.test(normalized)) {
    return "warning";
  }
  return "info";
}

function styleStatus(
  status: FooterStatus,
  colors: ReturnType<typeof createUiColors>,
): string {
  if (status.priority === "error") return colors.danger(status.text);
  if (status.priority === "warning") return colors.warning(status.text);
  return colors.meta(status.text);
}

function applyFooterColor(
  text: string,
  color: FooterColorName | undefined,
  colors: ReturnType<typeof createUiColors>,
): string {
  switch (color) {
    case "primary":
      return colors.primary(text);
    case "meta":
      return colors.meta(text);
    case "success":
      return colors.success(text);
    case "warning":
      return colors.warning(text);
    case "danger":
      return colors.danger(text);
    case "subtle":
      return colors.subtle(text);
    case "text":
      return colors.text(text);
    case "model":
      return colors.model(text);
    case undefined:
      return colors.meta(text);
    default:
      try {
        return colors.apply(color, text);
      } catch {
        return colors.meta(text);
      }
  }
}

function formatCustomStatuses(
  statuses: RenderedCustomStatus[],
  maxWidth: number,
  separator: string,
  colors: ReturnType<typeof createUiColors>,
): string {
  if (statuses.length === 0 || maxWidth <= 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const status of statuses) {
    const text = applyFooterColor(status.text, status.color, colors);
    const next = (parts.length === 0 ? "" : separator) + text;
    const nextWidth = visibleWidth(next);
    if (used + nextWidth > maxWidth) break;
    parts.push(next);
    used += nextWidth;
  }
  return parts.join("");
}

function formatStatuses(
  statuses: FooterStatus[],
  maxWidth: number,
  separator: string,
  overflow: (text: string) => string,
  colors: ReturnType<typeof createUiColors>,
): string {
  if (statuses.length === 0 || maxWidth <= 0) return "";

  const ordered = [...statuses].sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } satisfies Record<StatusPriority, number>;
    return rank[a.priority] - rank[b.priority] || a.text.localeCompare(b.text);
  });

  const parts: string[] = [];
  let used = 0;

  for (let i = 0; i < ordered.length; i++) {
    const next = (parts.length === 0 ? "" : separator) + styleStatus(ordered[i], colors);
    const nextWidth = visibleWidth(next);
    const remaining = ordered.length - (i + 1);
    const overflowText = remaining > 0
      ? `${parts.length > 0 ? separator : ""}${overflow(`+${remaining}`)}`
      : "";
    const overflowWidth = remaining > 0 ? visibleWidth(overflowText) : 0;

    if (used + nextWidth + overflowWidth > maxWidth) {
      const hidden = ordered.length - i;
      if (hidden > 0) {
        const compact = `${parts.length > 0 ? separator : ""}${overflow(`+${hidden}`)}`;
        if (used + visibleWidth(compact) <= maxWidth) {
          parts.push(compact);
        }
      }
      break;
    }

    parts.push(next);
    used += nextWidth;
  }

  return parts.join("");
}

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function formatSessionTokens(totals: SessionTotals, cacheHitRate?: number): string {
  const parts = [`↑${formatTokenCount(totals.input)}`, `↓${formatTokenCount(totals.output)}`];
  if (totals.cacheRead > 0) parts.push(`R${formatTokenCount(totals.cacheRead)}`);
  if (totals.cacheWrite > 0) parts.push(`W${formatTokenCount(totals.cacheWrite)}`);
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && cacheHitRate !== undefined) {
    parts.push(`CH${Math.round(cacheHitRate)}%`);
  }
  return parts.join(" ");
}

function abbreviateThinking(level: string): string {
  const map: Record<string, string> = {
    minimal: "min",
    medium: "med",
    high: "high",
    low: "low",
    xhigh: "xhigh",
    off: "off",
  };
  return map[level] ?? level.slice(0, 5);
}

function renderGitMarkers(git: GitStatus | null, colors: ReturnType<typeof createUiColors>): string {
  if (!git) return "";
  const markers: string[] = [];
  if (git.staged > 0) markers.push(colors.success(`+${git.staged}`));
  if (git.unstaged > 0) markers.push(colors.danger(`✗${git.unstaged}`));
  if (git.untracked > 0) markers.push(colors.warning(`?${git.untracked}`));
  if (git.ahead > 0) markers.push(colors.primary(`⇡${git.ahead}`));
  if (git.behind > 0) markers.push(colors.primary(`⇣${git.behind}`));
  return markers.join(" ");
}

async function getGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    // This runs in the background while the agent works: without
    // --no-optional-locks it can hold index.lock and make the agent's own git
    // commands fail.
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
      { cwd, timeout: 2_000, maxBuffer: 1024 * 1024 },
    );
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let ahead = 0;
    let behind = 0;
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      if (line.startsWith("## ")) {
        const match = line.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
        if (match) {
          if (match[1]) ahead = Number.parseInt(match[1], 10);
          if (match[2]) behind = Number.parseInt(match[2], 10);
          if (match[3]) behind = Number.parseInt(match[3], 10);
        }
        continue;
      }
      if (line.startsWith("??")) {
        untracked += 1;
        continue;
      }
      const indexStatus = line[0];
      const worktreeStatus = line[1];
      if (indexStatus && indexStatus !== " " && indexStatus !== "?") staged += 1;
      if (worktreeStatus && worktreeStatus !== " " && worktreeStatus !== "?") unstaged += 1;
    }
    return {
      dirty: unstaged + untracked > 0,
      staged,
      untracked,
      unstaged,
      ahead,
      behind,
    };
  } catch {
    return null;
  }
}

function addUsage(totals: SessionTotals, usage: UsageLike | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

/**
 * What the session has spent so far, counted the way Pi's own footer does:
 * every entry of the session (not only the active branch), including aborted
 * responses, tool-result usage, standalone usage entries, and the model calls
 * made for compaction and branch summaries.
 */
export function sumSessionUsage(entries: readonly UsageEntryLike[]): SessionTotals {
  const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    if (entry.type === "message") {
      const role = entry.message?.role;
      if (role === "assistant" || role === "toolResult") addUsage(totals, entry.message?.usage);
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(totals, entry.usage);
    }
  }
  return totals;
}

/**
 * How much of the latest request's prompt came from the provider's cache, in
 * percent. Undefined before the first response or when that prompt was empty.
 */
export function latestCacheHitRate(entries: readonly UsageEntryLike[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    return promptTokens > 0 ? ((usage?.cacheRead ?? 0) / promptTokens) * 100 : undefined;
  }
  return undefined;
}

// Pi does not export its virtual-model helpers; this is the `api` it gives them.
const VIRTUAL_MODEL_API = "pi-virtual";

/**
 * A virtual model picks a physical model per request. Like Pi's own footer,
 * report the one that produced the latest usable response on this branch.
 */
export function resolveRoutedModel(
  model: { api?: string } | undefined,
  branch: readonly UsageEntryLike[],
): RoutedModel | undefined {
  if (model?.api !== VIRTUAL_MODEL_API) return undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branch[i].type === "message" ? branch[i].message : undefined;
    if (message?.role !== "assistant" || !message.model) continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    return { id: normalizeModelId(message.model), thinking: message.thinkingLevel };
  }
  return undefined;
}

type ContextUsageSource = {
  getContextUsage?: () => unknown;
  sessionManager: { getBranch(): UsageEntryLike[] };
  model?: { contextWindow?: number };
};

/**
 * Context usage as Pi reports it. Pi answers `tokens: null` right after a
 * compaction, until the next response arrives; that stays unknown here rather
 * than being replaced by the pre-compaction size of the last message.
 */
export function resolveContextUsage(ctx: ContextUsageSource): ContextUsageState {
  if (typeof ctx.getContextUsage === "function") {
    let usage: unknown;
    try {
      usage = ctx.getContextUsage();
    } catch {
      usage = undefined;
    }
    if (isRecord(usage) && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      const window = usage.contextWindow;
      const tokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
      if (tokens === null) return { tokens: null, window, percent: null };
      const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
        ? usage.percent
        : (tokens / window) * 100;
      return { tokens, window, percent };
    }
  }

  // Pi could not report usage at all: estimate from the last response.
  const lastUsage = ctx.sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .at(-1)?.message?.usage;
  const tokens = (lastUsage?.input ?? 0) + (lastUsage?.output ?? 0) +
    (lastUsage?.cacheRead ?? 0) + (lastUsage?.cacheWrite ?? 0);
  const window = ctx.model?.contextWindow ?? 0;
  return { tokens, window, percent: window > 0 ? (tokens / window) * 100 : 0 };
}

function buildFooterState(
  ctx: {
    cwd?: string;
    sessionManager: {
      getSessionName(): string | undefined;
    };
    model?: { id?: string; provider?: string };
  },
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    getAvailableProviderCount(): number;
  },
  options: {
    gitStatus: GitStatus | null;
    thinkingLevel: string;
    config: FooterConfig;
    totals: SessionTotals;
    context: ContextUsageState;
    cacheHitRate?: number;
    routed?: RoutedModel;
    autoCompact?: boolean;
    subscription: boolean;
  },
): FooterState {
  const { totals } = options;

  const cwd = ctx.cwd ?? process.cwd();
  const home = process.env.HOME || "";
  const shortCwd = home && cwd.startsWith(home)
    ? "~" + cwd.slice(home.length)
    : cwd;

  const gitBranch = footerData.getGitBranch();
  const branch = gitBranch && options.gitStatus?.dirty ? `${gitBranch}*` : gitBranch ?? "";

  const extensionStatuses = footerData.getExtensionStatuses();
  const hiddenStatusKeys = new Set(
    options.config.customItems
      .filter((item) => item.excludeFromStatuses)
      .map((item) => item.statusKey),
  );
  const statuses = Array.from(extensionStatuses.entries())
    .filter(([key]) => !hiddenStatusKeys.has(key))
    .map(([key, raw]) => {
      const text = sanitizeStatusText(stripAnsi(raw));
      return { key, raw, text, priority: classifyStatus(text) } satisfies FooterStatus;
    })
    .filter((status) => status.text.length > 0);

  const customLeft: RenderedCustomStatus[] = [];
  const customRight: RenderedCustomStatus[] = [];
  for (const item of options.config.customItems) {
    const raw = extensionStatuses.get(item.statusKey);
    const value = raw ? sanitizeStatusText(stripAnsi(raw)) : "";
    if (!value && item.hideWhenMissing) continue;
    const text = item.prefix
      ? value
        ? `${item.prefix}: ${value}`
        : item.prefix
      : value || item.id;
    const target = item.position === "right" ? customRight : customLeft;
    target.push({ text, color: item.color });
  }

  return {
    workspace: { shortCwd, branch, git: options.gitStatus },
    context: options.context,
    autoCompact: options.autoCompact,
    model: {
      id: normalizeModelId(ctx.model?.id || "no-model"),
      thinking: options.thinkingLevel,
      // With a single provider its name says nothing the model id does not.
      provider: footerData.getAvailableProviderCount() > 1 ? ctx.model?.provider : undefined,
      routed: options.routed,
    },
    session: { name: ctx.sessionManager.getSessionName(), totals, cacheHitRate: options.cacheHitRate },
    cost: { totalUsd: totals.cost, subscription: options.subscription },
    statuses,
    customLeft,
    customRight,
  };
}

function renderContextUsage(
  state: FooterState,
  colors: ReturnType<typeof createUiColors>,
  mode: AdaptiveLayout["contextMode"],
): string {
  const { tokens, percent } = state.context;
  if (tokens === null || percent === null) {
    const unknown = colors.meta("?");
    if (mode !== "full") return unknown;
    return `${unknown}${colors.separator(`/`)}${colors.primary(formatTokenCount(state.context.window))}`;
  }

  const percentDisplay = `${Math.round(percent)}%`;
  const pct = colors.pressure(
    percentDisplay,
    percent,
    DEFAULT_WARNING_PERCENT,
    DEFAULT_ERROR_PERCENT,
  );
  if (mode === "percent") return pct;

  const used = colors.pressure(
    formatTokenCount(tokens),
    percent,
    DEFAULT_WARNING_PERCENT,
    DEFAULT_ERROR_PERCENT,
  );
  if (mode === "compact") return `${pct} ${used}`;
  return `${pct} ${used}${colors.separator(`/`)}${colors.primary(formatTokenCount(state.context.window))}`;
}

function buildRightSideForLayout(
  state: FooterState,
  colors: ReturnType<typeof createUiColors>,
  options: { tokenVisibility: "on" | "dim" | "off"; liveTps: string | null },
  layout: AdaptiveLayout,
): string {
  let contextDisplay = renderContextUsage(state, colors, layout.contextMode);
  if (layout.showAutoCompact && state.autoCompact) contextDisplay += colors.subtle(" (auto)");

  const rightParts = [contextDisplay];
  if (layout.showCustomItems && state.customRight.length > 0) {
    const customRight = formatCustomStatuses(
      state.customRight,
      32,
      colors.separator(" · "),
      colors,
    );
    if (customRight) rightParts.push(colors.separator(" │ ") + customRight);
  }
  if (layout.showSessionTokens && options.tokenVisibility !== "off") {
    const formatter = options.tokenVisibility === "dim" ? colors.subtle : colors.meta;
    rightParts.push(
      colors.separator(" │ ") +
        formatter(formatSessionTokens(state.session.totals, state.session.cacheHitRate)),
    );
  }
  // A subscription still shows its nominal cost, so the marker says it is not billed per token.
  if (layout.showCost && (state.cost.totalUsd > 0 || state.cost.subscription)) {
    const cost = formatUsdCompact(state.cost.totalUsd) + (state.cost.subscription ? " (sub)" : "");
    rightParts.push(colors.separator(" │ ") + colors.meta(cost));
  }
  let modelDisplay = colors.model(shortenMiddle(state.model.id, layout.maxModelWidth));
  if (layout.showProvider && state.model.provider) {
    modelDisplay = colors.subtle(`(${state.model.provider}) `) + modelDisplay;
  }
  if (layout.showThinking && state.model.thinking && state.model.thinking !== "off") {
    modelDisplay += colors.separator(" · ") + colors.warning(abbreviateThinking(state.model.thinking));
  }
  if (state.model.routed) {
    modelDisplay += colors.separator(" → ") +
      colors.model(shortenMiddle(state.model.routed.id, layout.maxModelWidth));
    if (layout.showThinking && state.model.routed.thinking && state.model.routed.thinking !== "off") {
      modelDisplay += colors.separator(" · ") + colors.warning(abbreviateThinking(state.model.routed.thinking));
    }
  }
  rightParts.push(colors.separator(" │ ") + modelDisplay);
  if (options.liveTps) {
    rightParts.push(colors.separator(" │ ") + colors.primary(options.liveTps));
  }
  return rightParts.join("");
}

function buildAdaptiveRightSide(
  state: FooterState,
  width: number,
  colors: ReturnType<typeof createUiColors>,
  options: { tokenVisibility: "on" | "dim" | "off"; liveTps: string | null },
): { right: string; layout: AdaptiveLayout } {
  const maxRightWidth = Math.max(0, width - MIN_LEFT_SPACE - 1);
  let density: FooterDensity | null = baseDensityForWidth(width);
  while (density) {
    const layout = layoutForDensity(density, width);
    const right = buildRightSideForLayout(state, colors, options, layout);
    if (visibleWidth(right) <= maxRightWidth || density === "minimal") {
      return {
        right: visibleWidth(right) > width ? truncateToWidth(right, width) : right,
        layout,
      };
    }
    density = nextNarrowerDensity(density);
  }

  const layout = layoutForDensity("minimal", width);
  return {
    right: truncateToWidth(buildRightSideForLayout(state, colors, options, layout), width),
    layout,
  };
}

function buildLeftIdentity(
  state: FooterState,
  availableLeft: number,
  colors: ReturnType<typeof createUiColors>,
  layout: AdaptiveLayout,
): { left: string; width: number } {
  const cwd = layout.cwdMode === "basename"
    ? basenamePath(state.workspace.shortCwd)
    : state.workspace.shortCwd;
  const leftParts: string[] = [colors.meta(shortenMiddle(cwd, availableLeft))];
  let leftWidth = visibleWidth(leftParts[0]);

  if (layout.showBranch && state.workspace.branch) {
    const branchPrefix = colors.separator(" │ ");
    const roomForName = availableLeft - leftWidth - visibleWidth(branchPrefix) - visibleWidth(`${GIT_ICON} `);
    // The whole name when it fits, else shortened; never to a stub.
    const fitBranch = (room: number): string => {
      if (visibleWidth(state.workspace.branch) <= room) return state.workspace.branch;
      return room >= MIN_BRANCH_WIDTH ? shortenMiddle(state.workspace.branch, room) : "";
    };

    // The markers say more per column than the tail of a long name, so the
    // name is shortened to keep them and they are dropped only as a last resort.
    let gitSegment = layout.showGitMarkers ? renderGitMarkers(state.workspace.git, colors) : "";
    if (gitSegment) gitSegment = colors.separator(" ") + gitSegment;
    let name = fitBranch(roomForName - visibleWidth(gitSegment));
    if (!name && gitSegment) {
      gitSegment = "";
      name = fitBranch(roomForName);
    }

    if (name) {
      const branchSegment = branchPrefix + colors.primary(`${GIT_ICON} ${name}`) + gitSegment;
      leftParts.push(branchSegment);
      leftWidth += visibleWidth(branchSegment);
    }
  }

  if (layout.showSessionName && state.session.name) {
    const sessionSegment = colors.separator(" │ ") + colors.meta(
      `@${shortenMiddle(state.session.name, Math.min(20, Math.max(8, availableLeft - leftWidth - 1)))}`,
    );
    if (leftWidth + visibleWidth(sessionSegment) <= availableLeft) {
      leftParts.push(sessionSegment);
      leftWidth += visibleWidth(sessionSegment);
    }
  }

  let left = leftParts.join("");
  if (visibleWidth(left) > availableLeft) {
    left = truncateToWidth(left, availableLeft);
    leftWidth = visibleWidth(left);
  }

  return { left, width: leftWidth };
}

/** Custom left items followed by the regular statuses, cut to `maxWidth`. */
function formatStatusLine(
  state: FooterState,
  maxWidth: number,
  colors: ReturnType<typeof createUiColors>,
): string {
  const separator = colors.separator(" │ ");
  const custom = formatCustomStatuses(state.customLeft, maxWidth, separator, colors);
  const remaining = Math.max(
    0,
    maxWidth - visibleWidth(custom) - (custom ? visibleWidth(separator) : 0),
  );
  const regular = formatStatuses(state.statuses, remaining, separator, colors.meta, colors);
  return [custom, regular].filter(Boolean).join(separator);
}

/**
 * One line when the extension statuses fit next to the identity, otherwise the
 * statuses move to a second line. A status is only ever cut (`+N`) when it is
 * wider than the whole terminal: a locked vault or a failed sandbox must not
 * disappear because the branch name is long.
 */
export function renderFooter(
  state: FooterState,
  width: number,
  colors: ReturnType<typeof createUiColors>,
  options: {
    tokenVisibility: "on" | "dim" | "off";
    liveTps: string | null;
    /** Keep statuses on their own line even when they would fit inline. */
    statusLine: "auto" | "always";
  },
): string[] {
  const { right, layout } = buildAdaptiveRightSide(state, width, colors, options);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);
  const hasStatuses = state.statuses.length > 0 || state.customLeft.length > 0;
  const statusLines = hasStatuses ? [truncateToWidth(formatStatusLine(state, width, colors), width)] : [];

  if (availableLeft <= MIN_LEFT_SPACE) {
    return [truncateToWidth(right, width), ...statusLines];
  }

  if (hasStatuses && options.statusLine === "auto") {
    // Session tokens and the live rate come and go with every turn. Lay the
    // line out as if they were showing, or the footer would grow and shrink
    // by a line each time the model answers.
    const busiest = buildAdaptiveRightSide(state, width, colors, {
      tokenVisibility: "on",
      liveTps: options.liveTps && options.liveTps.length > TPS_PLACEHOLDER.length
        ? options.liveTps
        : TPS_PLACEHOLDER,
    });
    const busiestLeft = width - Math.max(rightWidth, visibleWidth(busiest.right)) - 1;
    if (busiestLeft > MIN_LEFT_SPACE) {
      const separator = colors.separator(" │ ");
      const identity = buildLeftIdentity(state, busiestLeft, colors, busiest.layout);
      const inline = formatStatusLine(state, Number.MAX_SAFE_INTEGER, colors);
      if (identity.width + visibleWidth(separator) + visibleWidth(inline) <= busiestLeft) {
        const left = identity.left + separator + inline;
        const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
        return [truncateToWidth(left + pad + right, width)];
      }
    }
  }

  const identity = buildLeftIdentity(state, availableLeft, colors, layout);
  const pad = " ".repeat(Math.max(1, width - identity.width - rightWidth));
  return [truncateToWidth(identity.left + pad + right, width), ...statusLines];
}

export default function (pi: ExtensionAPI) {
  once(pi, "pi-footer", () => {
  pi.registerFlag("footer-two-line", {
    description: "Always render statuses on a second footer line (default: only when they do not fit)",
    type: "boolean",
    default: false,
  });

  let renderNow: (() => void) | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let gitStatus: GitStatus | null = null;
  let gitStatusCwd = "";
  let gitStatusFetchedAt = 0;
  let gitStatusPending: Promise<void> | undefined;
  let currentCwd = "";
  let footerConfig: FooterConfig = { customItems: [] };
  let liveTps: string | null = null;
  let tpsClearTimer: ReturnType<typeof setTimeout> | undefined;
  let tpsTicker: ReturnType<typeof setInterval> | undefined;
  let tokenVisibility: "on" | "dim" | "off" = "off";
  let tokenVisibilityTimer: ReturnType<typeof setTimeout> | undefined;
  const activeStreams = new Map<string, { start: number; output: number }>();
  type SessionUsage = {
    totals: SessionTotals;
    context: ContextUsageState;
    cacheHitRate?: number;
    routed?: RoutedModel;
  };
  let usageCache: (SessionUsage & { key: string }) | undefined;

  /**
   * Totals scan the whole session and the context figure rebuilds Pi's
   * session projection, while the footer renders on every frame. Session
   * entries are append-only and every append moves the leaf, so these only
   * change with the session, its leaf, or the model whose window applies.
   */
  function readSessionUsage(ctx: ExtensionContext): SessionUsage {
    const sessionManager = ctx.sessionManager;
    const key = [
      sessionManager.getSessionId(),
      sessionManager.getLeafId(),
      ctx.model?.provider,
      ctx.model?.id,
    ].join("\0");
    if (usageCache?.key !== key) {
      const entries = sessionManager.getEntries();
      usageCache = {
        key,
        totals: sumSessionUsage(entries),
        context: resolveContextUsage(ctx),
        cacheHitRate: latestCacheHitRate(entries),
        routed: resolveRoutedModel(ctx.model, sessionManager.getBranch()),
      };
    }
    return usageCache;
  }

  /** Undefined on Pi versions without `pi.getSettings()` (before 0.99). */
  function autoCompactEnabled(): boolean | undefined {
    if (typeof pi.getSettings !== "function") return undefined;
    try {
      return pi.getSettings().compaction?.enabled ?? true;
    } catch {
      return undefined;
    }
  }

  function usesSubscription(ctx: ExtensionContext): boolean {
    const model = ctx.model;
    if (!model) return false;
    // Same exception as Pi's own footer: subscription-backed despite API-key auth.
    if (model.provider === "kimi-coding") return true;
    try {
      return ctx.modelRegistry.isUsingOAuth(model) &&
        ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;
    } catch {
      return false;
    }
  }

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer) clearTimeout(timer);
  }

  function scheduleRender(delayMs = RENDER_DEBOUNCE_MS): void {
    if (!renderNow) return;
    if (delayMs <= 0) {
      clearTimer(renderTimer);
      renderTimer = undefined;
      renderNow();
      return;
    }
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderNow?.();
    }, delayMs);
  }

  function requestGitRefresh(cwd: string, force = false): void {
    if (!cwd) return;
    const now = Date.now();
    if (!force && gitStatusCwd === cwd && now - gitStatusFetchedAt < GIT_CACHE_TTL_MS) {
      return;
    }
    if (gitStatusPending) return;

    gitStatusPending = getGitStatus(cwd)
      .then((next) => {
        const changed = gitStatusCwd !== cwd || JSON.stringify(next) !== JSON.stringify(gitStatus);
        gitStatus = next;
        gitStatusCwd = cwd;
        gitStatusFetchedAt = Date.now();
        if (changed) scheduleRender();
      })
      .finally(() => {
        gitStatusPending = undefined;
      });
  }

  function recomputeTps(): void {
    let output = 0;
    let earliest = Infinity;
    for (const stream of activeStreams.values()) {
      output += stream.output;
      earliest = Math.min(earliest, stream.start);
    }
    if (output <= 0 || earliest === Infinity) return;
    const elapsed = (Date.now() - earliest) / 1000;
    if (elapsed < 0.1) return;
    const next = `${Math.round(output / elapsed)} t/s`;
    if (next !== liveTps) {
      liveTps = next;
      scheduleRender(TPS_RENDER_DEBOUNCE_MS);
    }
  }

  function startTpsTicker(): void {
    if (!tpsTicker) tpsTicker = setInterval(recomputeTps, 100);
  }

  function stopTpsTicker(): void {
    if (tpsTicker) clearInterval(tpsTicker);
    tpsTicker = undefined;
  }

  function scheduleTpsClear(): void {
    clearTimer(tpsClearTimer);
    tpsClearTimer = setTimeout(() => {
      liveTps = null;
      tpsClearTimer = undefined;
      scheduleRender();
    }, 4_000);
  }

  function setTokenVisibility(next: "on" | "dim" | "off"): void {
    if (tokenVisibility === next) return;
    tokenVisibility = next;
    scheduleRender();
  }

  function scheduleTokenVisibilityDecay(): void {
    clearTimer(tokenVisibilityTimer);
    tokenVisibilityTimer = setTimeout(() => {
      setTokenVisibility("dim");
      tokenVisibilityTimer = setTimeout(() => {
        setTokenVisibility("off");
        tokenVisibilityTimer = undefined;
      }, 4_000);
    }, 4_000);
  }

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage & { id?: string; usage?: { output?: number } };
    const id = message.id ?? String(Date.now());
    activeStreams.set(id, { start: Date.now(), output: message.usage?.output ?? 0 });
    startTpsTicker();
    clearTimer(tokenVisibilityTimer);
    tokenVisibilityTimer = undefined;
    setTokenVisibility("on");
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage & { id?: string; usage?: { output?: number } };
    if (!message.id) return;
    const stream = activeStreams.get(message.id);
    if (!stream) return;
    const update = event.assistantMessageEvent as AssistantMessageEvent & { partial?: { usage?: { output?: number } } };
    const output = update.partial?.usage?.output ?? message.usage?.output ?? 0;
    if (output > stream.output) stream.output = output;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage & { id?: string; usage?: { output?: number } };
    if (message.id) {
      const stream = activeStreams.get(message.id);
      const output = message.usage?.output ?? 0;
      if (stream && output > stream.output) stream.output = output;
      recomputeTps();
      activeStreams.delete(message.id);
    }
    if (activeStreams.size === 0) stopTpsTicker();
  });

  pi.on("agent_end", async () => {
    activeStreams.clear();
    stopTpsTicker();
    scheduleTpsClear();
    scheduleTokenVisibilityDecay();
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    requestGitRefresh(ctx.cwd, true);
  });

  pi.on("model_select", async () => scheduleRender());
  pi.on("thinking_level_select", async () => scheduleRender());

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    footerConfig = parseFooterConfig(readSettings(currentCwd));
    gitStatusCwd = "";
    gitStatusFetchedAt = 0;
    requestGitRefresh(currentCwd, true);

    ctx.ui.setFooter((tui, theme, footerData) => {
      renderNow = () => tui.requestRender();
      const unsub = footerData.onBranchChange(() => {
        requestGitRefresh(ctx.cwd, true);
        scheduleRender();
      });
      const colors = createUiColors(theme);

      return {
        dispose() {
          unsub();
          renderNow = undefined;
        },
        invalidate() {
          scheduleRender();
        },
        render(width: number): string[] {
          requestGitRefresh(ctx.cwd);
          const state = buildFooterState(ctx, footerData, {
            gitStatus,
            thinkingLevel: pi.getThinkingLevel(),
            config: footerConfig,
            ...readSessionUsage(ctx),
            autoCompact: autoCompactEnabled(),
            subscription: usesSubscription(ctx),
          });
          return renderFooter(state, width, colors, {
            tokenVisibility,
            liveTps,
            statusLine: pi.getFlag("footer-two-line") === true ? "always" : "auto",
          });
        },
      };
    });
  });

  pi.on("session_shutdown", async () => {
    clearTimer(renderTimer);
    renderTimer = undefined;
    clearTimer(tpsClearTimer);
    tpsClearTimer = undefined;
    clearTimer(tokenVisibilityTimer);
    tokenVisibilityTimer = undefined;
    activeStreams.clear();
    stopTpsTicker();
    liveTps = null;
    tokenVisibility = "off";
    currentCwd = "";
    gitStatus = null;
    gitStatusCwd = "";
    gitStatusFetchedAt = 0;
    footerConfig = { customItems: [] };
    usageCache = undefined;
  });

  });
}
