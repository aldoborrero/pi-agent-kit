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
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
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
const MAX_BRANCH_WIDTH = 18;
const GIT_CACHE_TTL_MS = 1_500;
const RENDER_DEBOUNCE_MS = 75;
const TPS_RENDER_DEBOUNCE_MS = 200;

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

type FooterDensity = "full" | "comfortable" | "compact" | "minimal";

type AdaptiveLayout = {
  density: FooterDensity;
  contextMode: "full" | "compact" | "percent";
  cwdMode: "full" | "basename";
  showStatuses: boolean;
  showSessionName: boolean;
  showBranch: boolean;
  showGitMarkers: boolean;
  showCustomItems: boolean;
  showSessionTokens: boolean;
  showCost: boolean;
  showThinking: boolean;
  maxModelWidth: number;
};

type FooterState = {
  workspace: {
    shortCwd: string;
    shortBranch: string;
    git: GitStatus | null;
  };
  context: {
    tokens: number;
    window: number;
    percent: number;
  };
  model: {
    id: string;
    thinking: string;
  };
  session: {
    name?: string;
    totals: SessionTotals;
  };
  cost: {
    totalUsd: number;
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
  if (width >= 112) return "full";
  if (width >= 88) return "comfortable";
  if (width >= 64) return "compact";
  return "minimal";
}

function layoutForDensity(density: FooterDensity, width: number): AdaptiveLayout {
  switch (density) {
    case "full":
      return {
        density,
        contextMode: "full",
        cwdMode: "full",
        showStatuses: true,
        showSessionName: true,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: true,
        showCost: true,
        showThinking: true,
        maxModelWidth: 32,
      };
    case "comfortable":
      return {
        density,
        contextMode: "full",
        cwdMode: "full",
        showStatuses: true,
        showSessionName: false,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: true,
        showCost: true,
        showThinking: true,
        maxModelWidth: 24,
      };
    case "compact":
      return {
        density,
        contextMode: "compact",
        cwdMode: "basename",
        showStatuses: false,
        showSessionName: false,
        showBranch: true,
        showGitMarkers: true,
        showCustomItems: true,
        showSessionTokens: false,
        showCost: false,
        showThinking: true,
        maxModelWidth: 18,
      };
    case "minimal":
      return {
        density,
        contextMode: "percent",
        cwdMode: "basename",
        showStatuses: false,
        showSessionName: false,
        showBranch: width >= 48,
        showGitMarkers: false,
        showCustomItems: false,
        showSessionTokens: false,
        showCost: false,
        showThinking: false,
        maxModelWidth: 14,
      };
  }
}

function nextNarrowerDensity(density: FooterDensity): FooterDensity | null {
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
  if (status.priority === "error") return colors.danger(`● ${status.text}`);
  if (status.priority === "warning") return colors.warning(`! ${status.text}`);
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

function formatSessionTokens(totals: SessionTotals): string {
  const parts = [`↑${formatTokenCount(totals.input)}`, `↓${formatTokenCount(totals.output)}`];
  if (totals.cacheRead > 0) parts.push(`R${formatTokenCount(totals.cacheRead)}`);
  if (totals.cacheWrite > 0) parts.push(`W${formatTokenCount(totals.cacheWrite)}`);
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
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
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

function readCoreContextUsage(ctx: { getContextUsage?: () => unknown }): {
  tokens: number;
  window: number;
  percent: number;
} | null {
  if (typeof ctx.getContextUsage !== "function") return null;
  let usage: unknown;
  try {
    usage = ctx.getContextUsage();
  } catch {
    return null;
  }
  if (!isRecord(usage)) return null;

  const tokens = typeof usage.tokens === "number"
    ? usage.tokens
    : typeof usage.contextTokens === "number"
      ? usage.contextTokens
      : undefined;
  const window = typeof usage.contextWindow === "number"
    ? usage.contextWindow
    : undefined;
  if (tokens === undefined || !Number.isFinite(tokens) || !window || !Number.isFinite(window)) {
    return null;
  }

  const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
    ? usage.percent
    : (tokens / window) * 100;
  return { tokens, window, percent };
}

function buildFooterState(
  ctx: {
    cwd?: string;
    getContextUsage?: () => unknown;
    sessionManager: {
      getBranch(): Array<{ type: string; message?: AssistantMessage }>;
      getSessionName(): string | undefined;
    };
    model?: { contextWindow?: number; id?: string };
  },
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
  },
  options: {
    gitStatus: GitStatus | null;
    thinkingLevel: string;
    config: FooterConfig;
  },
): FooterState {
  const messages = ctx.sessionManager.getBranch()
    .filter((e): e is { type: "message"; message: AssistantMessage } =>
      e.type === "message" && !!e.message && e.message.role === "assistant"
    )
    .map((e) => e.message)
    .filter((m) => m.stopReason !== "aborted");

  const lastMessage = messages[messages.length - 1];
  const totals = messages.reduce<SessionTotals>((sum, message) => {
    sum.input += message.usage.input ?? 0;
    sum.output += message.usage.output ?? 0;
    sum.cacheRead += message.usage.cacheRead ?? 0;
    sum.cacheWrite += message.usage.cacheWrite ?? 0;
    sum.cost += message.usage.cost?.total ?? 0;
    return sum;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const totalUsd = totals.cost;
  const fallbackContextTokens = lastMessage
    ? lastMessage.usage.input +
      lastMessage.usage.output +
      lastMessage.usage.cacheRead +
      lastMessage.usage.cacheWrite
    : 0;
  const coreContextUsage = readCoreContextUsage(ctx);
  const contextTokens = coreContextUsage?.tokens ?? fallbackContextTokens;
  const contextWindow = coreContextUsage?.window ?? ctx.model?.contextWindow ?? 0;
  const percentValue = coreContextUsage?.percent ?? (contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : 0);

  const cwd = ctx.cwd ?? process.cwd();
  const home = process.env.HOME || "";
  const shortCwd = home && cwd.startsWith(home)
    ? "~" + cwd.slice(home.length)
    : cwd;

  const branch = footerData.getGitBranch();
  const branchText = branch && options.gitStatus?.dirty ? `${branch}*` : branch;
  const shortBranch = branchText ? shortenMiddle(branchText, MAX_BRANCH_WIDTH) : "";

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
    workspace: { shortCwd, shortBranch, git: options.gitStatus },
    context: { tokens: contextTokens, window: contextWindow, percent: percentValue },
    model: { id: normalizeModelId(ctx.model?.id || "no-model"), thinking: options.thinkingLevel },
    session: { name: ctx.sessionManager.getSessionName(), totals },
    cost: { totalUsd },
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
  const percentDisplay = `${Math.round(state.context.percent)}%`;
  const pct = colors.pressure(
    percentDisplay,
    state.context.percent,
    DEFAULT_WARNING_PERCENT,
    DEFAULT_ERROR_PERCENT,
  );
  if (mode === "percent") return pct;

  const used = colors.pressure(
    formatTokenCount(state.context.tokens),
    state.context.percent,
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
  const contextDisplay = renderContextUsage(state, colors, layout.contextMode);

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
    rightParts.push(colors.separator(" │ ") + formatter(formatSessionTokens(state.session.totals)));
  }
  if (layout.showCost && state.cost.totalUsd > 0) {
    rightParts.push(colors.separator(" │ ") + colors.meta(formatUsdCompact(state.cost.totalUsd)));
  }
  let modelDisplay = colors.model(shortenMiddle(state.model.id, layout.maxModelWidth));
  if (layout.showThinking && state.model.thinking && state.model.thinking !== "off") {
    modelDisplay += colors.separator(" · ") + colors.warning(abbreviateThinking(state.model.thinking));
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

  if (layout.showBranch && state.workspace.shortBranch) {
    const branchSegment = colors.separator(" │ ") + colors.primary(state.workspace.shortBranch);
    if (leftWidth + visibleWidth(branchSegment) <= availableLeft) {
      leftParts.push(branchSegment);
      leftWidth += visibleWidth(branchSegment);
    }
  }

  const gitMarkers = renderGitMarkers(state.workspace.git, colors);
  if (layout.showGitMarkers && gitMarkers) {
    const gitSegment = colors.separator(" ") + gitMarkers;
    if (leftWidth + visibleWidth(gitSegment) <= availableLeft) {
      leftParts.push(gitSegment);
      leftWidth += visibleWidth(gitSegment);
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

function renderCompactFooter(
  state: FooterState,
  width: number,
  colors: ReturnType<typeof createUiColors>,
  options: { tokenVisibility: "on" | "dim" | "off"; liveTps: string | null },
): string[] {
  const { right, layout } = buildAdaptiveRightSide(state, width, colors, options);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) {
    return [truncateToWidth(right, width)];
  }

  const identity = buildLeftIdentity(state, availableLeft, colors, layout);
  let left = identity.left;
  let leftWidth = identity.width;

  const remainingForStatuses = Math.max(
    0,
    availableLeft - leftWidth - visibleWidth(colors.separator(" │ ")),
  );
  const customLeftStr = layout.showCustomItems
    ? formatCustomStatuses(
      state.customLeft,
      remainingForStatuses,
      colors.separator(" │ "),
      colors,
    )
    : "";
  const remainingAfterCustom = Math.max(
    0,
    remainingForStatuses - visibleWidth(customLeftStr) - (customLeftStr ? visibleWidth(colors.separator(" │ ")) : 0),
  );
  const regularStatusStr = layout.showStatuses
    ? formatStatuses(
      state.statuses,
      remainingAfterCustom,
      colors.separator(" │ "),
      colors.meta,
      colors,
    )
    : "";
  const statusStr = [customLeftStr, regularStatusStr].filter(Boolean).join(colors.separator(" │ "));
  if (statusStr) {
    left = identity.left + colors.separator(" │ ") + statusStr;
    left = visibleWidth(left) > availableLeft ? truncateToWidth(left, availableLeft) : left;
    leftWidth = visibleWidth(left);
  }

  const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
  return [truncateToWidth(left + pad + right, width)];
}

function renderTwoLineFooter(
  state: FooterState,
  width: number,
  colors: ReturnType<typeof createUiColors>,
  options: { tokenVisibility: "on" | "dim" | "off"; liveTps: string | null },
): string[] {
  const { right, layout } = buildAdaptiveRightSide(state, width, colors, options);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) {
    return [truncateToWidth(right, width)];
  }

  const identity = buildLeftIdentity(state, availableLeft, colors, layout);
  const pad = " ".repeat(Math.max(1, width - identity.width - rightWidth));
  const firstLine = truncateToWidth(identity.left + pad + right, width);

  if ((!layout.showStatuses || state.statuses.length === 0) && (!layout.showCustomItems || state.customLeft.length === 0)) {
    return [firstLine];
  }

  const customLine = layout.showCustomItems
    ? formatCustomStatuses(state.customLeft, width, colors.separator(" │ "), colors)
    : "";
  const remainingStatusWidth = Math.max(
    0,
    width - visibleWidth(customLine) - (customLine ? visibleWidth(colors.separator(" │ ")) : 0),
  );
  const regularLine = layout.showStatuses
    ? formatStatuses(
      state.statuses,
      remainingStatusWidth,
      colors.separator(" │ "),
      colors.meta,
      colors,
    )
    : "";
  const statusLine = [customLine, regularLine].filter(Boolean).join(colors.separator(" │ "));
  if (!statusLine) return [firstLine];
  return [firstLine, truncateToWidth(statusLine, width)];
}

export default function (pi: ExtensionAPI) {
  once(pi, "pi-footer", () => {
  pi.registerFlag("footer-two-line", {
    description: "Render footer in two lines (statuses on a second line)",
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
          const twoLine = pi.getFlag("footer-two-line") === true;
          const state = buildFooterState(ctx, footerData, {
            gitStatus,
            thinkingLevel: pi.getThinkingLevel(),
            config: footerConfig,
          });
          const renderOptions = { tokenVisibility, liveTps };
          return twoLine
            ? renderTwoLineFooter(state, width, colors, renderOptions)
            : renderCompactFooter(state, width, colors, renderOptions);
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
  });

  });
}
