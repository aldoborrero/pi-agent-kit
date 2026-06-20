import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CURSOR_AT_END = "\x1b[7m \x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const SUGGEST_UNDO_KEY = "alt+o";

export class SuggestEditor extends CustomEditor {
  private suggestions: string[] = [];
  private selectedSuggestionIndex = 0;
  private enabled = true;
  private historyAvailable = false;
  private onAcceptSuggestion?: () => void;
  private onSelectSuggestion?: ((index: number) => void) | undefined;
  private onUndoSuggestion?: () => void;

  setSuggestions(suggestions: string[], selectedIndex = 0): void {
    this.suggestions = suggestions.map((text) => text.trim()).filter(Boolean);
    this.selectedSuggestionIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, this.suggestions.length - 1)));
    this.tui.requestRender();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.tui.requestRender();
  }

  setHistoryAvailable(available: boolean): void {
    this.historyAvailable = available;
    this.tui.requestRender();
  }

  clear(): void {
    this.suggestions = [];
    this.selectedSuggestionIndex = 0;
    this.tui.requestRender();
  }

  setOnAcceptSuggestion(handler: (() => void) | undefined): void {
    this.onAcceptSuggestion = handler;
  }

  setOnSelectSuggestion(handler: ((index: number) => void) | undefined): void {
    this.onSelectSuggestion = handler;
  }

  setOnUndoSuggestion(handler: (() => void) | undefined): void {
    this.onUndoSuggestion = handler;
  }

  private getSelectedSuggestion(): string | null {
    if (this.suggestions.length === 0) return null;
    return this.suggestions[this.selectedSuggestionIndex] ?? null;
  }

  private shouldShowGhost(): boolean {
    return this.enabled && !!this.getSelectedSuggestion() && !this.isShowingAutocomplete() && this.getText().length === 0;
  }

  private cycleSelection(direction: -1 | 1): void {
    if (this.suggestions.length <= 1) return;
    const count = this.suggestions.length;
    this.selectedSuggestionIndex = (this.selectedSuggestionIndex + direction + count) % count;
    this.onSelectSuggestion?.(this.selectedSuggestionIndex);
    this.tui.requestRender();
  }

  override handleInput(data: string): void {
    // Undo dismissal: Alt+O (works regardless of ghost state)
    if (matchesKey(data, SUGGEST_UNDO_KEY)) {
      if (this.historyAvailable) {
        this.onUndoSuggestion?.();
        return;
      }
    }

    if (this.shouldShowGhost()) {
      // Accept suggestion — keep suggestions so ghost reappears if the user deletes the text
      if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        this.insertTextAtCursor(this.getSelectedSuggestion()!);
        this.onAcceptSuggestion?.();
        return;
      }
      // Cycle through multiple suggestions with Alt+Up / Alt+Down
      if (this.suggestions.length > 1) {
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
    if (!this.shouldShowGhost()) return lines;

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