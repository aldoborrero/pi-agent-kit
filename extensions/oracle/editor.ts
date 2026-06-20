import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CURSOR_AT_END = "\x1b[7m \x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ORACLE_UNDO_KEY = "alt+o";

export class OracleEditor extends CustomEditor {
  private oracleSuggestions: string[] = [];
  private selectedSuggestionIndex = 0;
  private oracleEnabled = true;
  private oracleHistoryAvailable = false;
  private onAcceptOracleSuggestion?: () => void;
  private onSelectOracleSuggestion?: ((index: number) => void) | undefined;
  private onDismissOracleSuggestion?: () => void;
  private onUndoOracleSuggestion?: () => void;

  setOracleSuggestions(suggestions: string[], selectedIndex = 0): void {
    this.oracleSuggestions = suggestions.map((text) => text.trim()).filter(Boolean);
    this.selectedSuggestionIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, this.oracleSuggestions.length - 1)));
    this.tui.requestRender();
  }

  setOracleEnabled(enabled: boolean): void {
    this.oracleEnabled = enabled;
    this.tui.requestRender();
  }

  setOracleHistoryAvailable(available: boolean): void {
    this.oracleHistoryAvailable = available;
    this.tui.requestRender();
  }

  clearOracleSuggestion(): void {
    this.oracleSuggestions = [];
    this.selectedSuggestionIndex = 0;
    this.tui.requestRender();
  }

  setOnAcceptOracleSuggestion(handler: (() => void) | undefined): void {
    this.onAcceptOracleSuggestion = handler;
  }

  setOnSelectOracleSuggestion(handler: ((index: number) => void) | undefined): void {
    this.onSelectOracleSuggestion = handler;
  }

  setOnDismissOracleSuggestion(handler: (() => void) | undefined): void {
    this.onDismissOracleSuggestion = handler;
  }

  setOnUndoOracleSuggestion(handler: (() => void) | undefined): void {
    this.onUndoOracleSuggestion = handler;
  }

  private getSelectedSuggestion(): string | null {
    if (this.oracleSuggestions.length === 0) return null;
    return this.oracleSuggestions[this.selectedSuggestionIndex] ?? null;
  }

  private shouldShowOracleGhost(): boolean {
    return this.oracleEnabled && !!this.getSelectedSuggestion() && !this.isShowingAutocomplete() && this.getText().length === 0;
  }

  private cycleSelection(direction: -1 | 1): void {
    if (this.oracleSuggestions.length <= 1) return;
    const count = this.oracleSuggestions.length;
    this.selectedSuggestionIndex = (this.selectedSuggestionIndex + direction + count) % count;
    this.onSelectOracleSuggestion?.(this.selectedSuggestionIndex);
    this.tui.requestRender();
  }

  override handleInput(data: string): void {
    // Undo dismissal: Alt+O (works regardless of ghost state)
    if (matchesKey(data, ORACLE_UNDO_KEY)) {
      if (this.oracleHistoryAvailable) {
        this.onUndoOracleSuggestion?.();
        return;
      }
    }

    if (this.shouldShowOracleGhost()) {
      // Accept suggestion — keep suggestions so ghost reappears if the user deletes the text
      if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        this.insertTextAtCursor(this.getSelectedSuggestion()!);
        this.onAcceptOracleSuggestion?.();
        return;
      }
      // Escape does not dismiss anymore — suggestions persist until overwritten
      // Cycle through multiple suggestions with Alt+Up / Alt+Down
      if (this.oracleSuggestions.length > 1) {
        if (matchesKey(data, "alt+up")) {
          this.cycleSelection(-1);
          return;
        }
        if (matchesKey(data, "alt+down")) {
          this.cycleSelection(1);
          return;
        }
      }
    }

    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const ghostVisible = this.shouldShowOracleGhost();

    if (!ghostVisible) return lines;

    const editableLineIndex = lines.findIndex((line, index) => {
      if (index === 0 || index === lines.length - 1) return false;
      return line.includes(CURSOR_AT_END);
    });
    if (editableLineIndex === -1) return lines;

    const line = lines[editableLineIndex]!;
    const cursorIndex = line.indexOf(CURSOR_AT_END);
    if (cursorIndex === -1) return lines;

    const before = line.slice(0, cursorIndex + CURSOR_AT_END.length);
    const after = line.slice(cursorIndex + CURSOR_AT_END.length);
    const availableColumns = (after.match(/^\s+/)?.[0].length ?? 0);
    if (availableColumns <= 0) return lines;

    const ghost = truncateToWidth(this.getSelectedSuggestion()!, availableColumns, "");
    if (!ghost) return lines;

    const remainingSpaces = " ".repeat(Math.max(0, availableColumns - visibleWidth(ghost)));
    const rest = after.slice(availableColumns);
    lines[editableLineIndex] = `${before}${DIM}${ghost}${RESET}${remainingSpaces}${rest}`;
    return lines;
  }
}