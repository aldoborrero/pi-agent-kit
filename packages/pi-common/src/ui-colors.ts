import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export const DEFAULT_WARNING_PERCENT = 70;
export const DEFAULT_ERROR_PERCENT = 90;

export function getPressureColor(
  percentValue: number,
  warningPercent = DEFAULT_WARNING_PERCENT,
  errorPercent = DEFAULT_ERROR_PERCENT,
): ThemeColor {
  if (percentValue > errorPercent) return "error";
  if (percentValue > warningPercent) return "warning";
  return "success";
}

export function createUiColors(theme: Theme) {
  return {
    apply: (color: ThemeColor, text: string) => theme.fg(color, text),
    separator: (text: string) => theme.fg("dim", text),
    subtle: (text: string) => theme.fg("dim", text),
    meta: (text: string) => theme.fg("muted", text),
    primary: (text: string) => theme.fg("accent", text),
    success: (text: string) => theme.fg("success", text),
    warning: (text: string) => theme.fg("warning", text),
    danger: (text: string) => theme.fg("error", text),
    text: (text: string) => theme.fg("text", text),
    model: (text: string) => theme.fg("toolTitle", text),
    toolOutput: (text: string) => theme.fg("toolOutput", text),
    pressure: (
      text: string,
      percentValue: number,
      warningPercent = DEFAULT_WARNING_PERCENT,
      errorPercent = DEFAULT_ERROR_PERCENT,
    ) => theme.fg(getPressureColor(percentValue, warningPercent, errorPercent), text),
  };
}
