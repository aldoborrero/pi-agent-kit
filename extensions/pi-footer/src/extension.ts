/**
 * Custom Footer Extension - shows working directory, git branch, model, context usage, and extension statuses
 * URL: https://github.com/Mic92/dotfiles/blob/main/home/.pi/agent/extensions/custom-footer.ts
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  createUiColors,
  DEFAULT_ERROR_PERCENT,
  DEFAULT_WARNING_PERCENT,
} from "@aldoborrero/pi-common";

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const MIN_LEFT_SPACE = 12;
const MAX_BRANCH_WIDTH = 18;

type StatusPriority = "error" | "warning" | "info";

type FooterStatus = {
  raw: string;
  text: string;
  priority: StatusPriority;
};

type FooterState = {
  workspace: {
    shortCwd: string;
    shortBranch: string;
  };
  context: {
    tokens: number;
    window: number;
    percent: number;
  };
  model: {
    id: string;
  };
  session: {
    name?: string;
  };
  cost: {
    totalUsd: number;
  };
  statuses: FooterStatus[];
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

function classifyStatus(text: string): StatusPriority {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("error") ||
    normalized.includes("missing") ||
    normalized.includes("unconfigured") ||
    normalized.includes("locked") ||
    normalized.includes("off")
  ) {
    return "error";
  }
  if (
    normalized.includes("warning") ||
    normalized.includes("no-key") ||
    normalized.includes("setup")
  ) {
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

function buildFooterState(
  ctx: {
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
): FooterState {
  const messages = ctx.sessionManager.getBranch()
    .filter((e): e is { type: "message"; message: AssistantMessage } =>
      e.type === "message" && !!e.message && e.message.role === "assistant"
    )
    .map((e) => e.message)
    .filter((m) => m.stopReason !== "aborted");

  const lastMessage = messages[messages.length - 1];
  const totalUsd = messages.reduce(
    (sum, message) => sum + (message.usage.cost?.total ?? 0),
    0,
  );
  const contextTokens = lastMessage
    ? lastMessage.usage.input +
      lastMessage.usage.output +
      lastMessage.usage.cacheRead +
      lastMessage.usage.cacheWrite
    : 0;
  const contextWindow = ctx.model?.contextWindow || 0;
  const percentValue = contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : 0;

  const cwd = process.cwd();
  const home = process.env.HOME || "";
  const shortCwd = home && cwd.startsWith(home)
    ? "~" + cwd.slice(home.length)
    : cwd;

  const branch = footerData.getGitBranch();
  const shortBranch = branch ? shortenMiddle(branch, MAX_BRANCH_WIDTH) : "";

  const statuses = Array.from(footerData.getExtensionStatuses().values())
    .map((raw) => {
      const text = sanitizeStatusText(stripAnsi(raw));
      return { raw, text, priority: classifyStatus(text) } satisfies FooterStatus;
    })
    .filter((status) => status.text.length > 0);

  return {
    workspace: { shortCwd, shortBranch },
    context: { tokens: contextTokens, window: contextWindow, percent: percentValue },
    model: { id: ctx.model?.id || "no-model" },
    session: { name: ctx.sessionManager.getSessionName() },
    cost: { totalUsd },
    statuses,
  };
}

function buildRightSide(
  state: FooterState,
  colors: ReturnType<typeof createUiColors>,
): string {
  const percentDisplay = `${Math.round(state.context.percent)}%`;
  const contextDisplay = colors.pressure(
    percentDisplay,
    state.context.percent,
    DEFAULT_WARNING_PERCENT,
    DEFAULT_ERROR_PERCENT,
  ) + " " + colors.pressure(
    formatTokenCount(state.context.tokens),
    state.context.percent,
    DEFAULT_WARNING_PERCENT,
    DEFAULT_ERROR_PERCENT,
  ) + colors.separator(`/`) + colors.primary(formatTokenCount(state.context.window));

  const rightParts = [contextDisplay];
  if (state.cost.totalUsd > 0) {
    rightParts.push(colors.separator(" │ ") + colors.meta(formatUsdCompact(state.cost.totalUsd)));
  }
  rightParts.push(colors.separator(" │ ") + colors.model(state.model.id));
  return rightParts.join("");
}

function buildLeftIdentity(
  state: FooterState,
  availableLeft: number,
  colors: ReturnType<typeof createUiColors>,
): { left: string; width: number } {
  const leftParts: string[] = [colors.meta(shortenMiddle(state.workspace.shortCwd, availableLeft))];
  let leftWidth = visibleWidth(leftParts[0]);

  if (state.workspace.shortBranch) {
    const branchSegment = colors.separator(" │ ") + colors.primary(state.workspace.shortBranch);
    if (leftWidth + visibleWidth(branchSegment) <= availableLeft) {
      leftParts.push(branchSegment);
      leftWidth += visibleWidth(branchSegment);
    }
  }

  if (state.session.name) {
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
): string[] {
  const right = buildRightSide(state, colors);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) {
    return [truncateToWidth(right, width)];
  }

  const identity = buildLeftIdentity(state, availableLeft, colors);
  let left = identity.left;
  let leftWidth = identity.width;

  const remainingForStatuses = Math.max(
    0,
    availableLeft - leftWidth - visibleWidth(colors.separator(" │ ")),
  );
  const statusStr = formatStatuses(
    state.statuses,
    remainingForStatuses,
    colors.separator(" │ "),
    colors.meta,
    colors,
  );
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
): string[] {
  const right = buildRightSide(state, colors);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) {
    return [truncateToWidth(right, width)];
  }

  const identity = buildLeftIdentity(state, availableLeft, colors);
  const pad = " ".repeat(Math.max(1, width - identity.width - rightWidth));
  const firstLine = truncateToWidth(identity.left + pad + right, width);

  if (state.statuses.length === 0) {
    return [firstLine];
  }

  const statusLine = formatStatuses(
    state.statuses,
    width,
    colors.separator(" │ "),
    colors.meta,
    colors,
  );
  return [firstLine, truncateToWidth(statusLine, width)];
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("footer-two-line", {
    description: "Render footer in two lines (statuses on a second line)",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const colors = createUiColors(theme);

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const twoLine = pi.getFlag("footer-two-line") === true;
          const state = buildFooterState(ctx, footerData);
          return twoLine
            ? renderTwoLineFooter(state, width, colors)
            : renderCompactFooter(state, width, colors);
        },
      };
    });
  });
}
