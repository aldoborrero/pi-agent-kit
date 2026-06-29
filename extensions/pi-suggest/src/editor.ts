import { matchesKey, truncateToWidth, visibleWidth, type AutocompleteProvider, type EditorComponent, type TUI } from "@earendil-works/pi-tui";

const EMPTY_CURSOR_PATTERN = /\x1b\[7m \x1b\[(?:27|0)m/;
const ALT_UP_SEQUENCES = new Set(["\x1b[1;3A", "\x1b[3A"]);
const ALT_DOWN_SEQUENCES = new Set(["\x1b[1;3B", "\x1b[3B"]);
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * SuggestEditor decorates an existing editor instead of replacing it.
 *
 * It only adds ghost-suggestion rendering and Tab/Right/Alt-Up/Alt-Down handling;
 * all normal editing behavior is delegated to the wrapped editor so pi-suggest can
 * compose with other editor extensions such as pi-voice.
 */
export class SuggestEditor implements EditorComponent {
  private suggestions: string[] = [];
  private selectedSuggestionIndex = 0;
  private enabled = true;
  private onAcceptSuggestion?: () => void;
  private onSelectSuggestion?: ((index: number) => void) | undefined;
  private onDismissSuggestion?: () => void;

  // Expose CustomEditor's duck-typed app-keybinding surface so the host can wire
  // global actions even though this editor is now a wrapper.
  public actionHandlers: Map<string, () => void> = new Map();
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onPasteImage?: () => void;
  public onExtensionShortcut?: (data: string) => boolean;

  constructor(
    private readonly inner: EditorComponent,
    private readonly tui: TUI,
  ) {}

  // ─── EditorComponent delegation ─────────────────────────────────

  get wantsKeyRelease(): boolean {
    return this.inner.wantsKeyRelease === true;
  }

  get focused(): boolean {
    return (this.inner as unknown as { focused?: boolean }).focused ?? false;
  }

  set focused(value: boolean) {
    (this.inner as unknown as { focused?: boolean }).focused = value;
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.inner.onSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.inner.onSubmit = handler;
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.inner.onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.inner.onChange = handler;
  }

  get borderColor(): ((str: string) => string) | undefined {
    return this.inner.borderColor;
  }

  set borderColor(fn: ((str: string) => string) | undefined) {
    this.inner.borderColor = fn;
  }

  getText(): string {
    return this.inner.getText();
  }

  getExpandedText(): string {
    return this.inner.getExpandedText?.() ?? this.inner.getText();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  addToHistory(text: string): void {
    this.inner.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    if (this.inner.insertTextAtCursor) {
      this.inner.insertTextAtCursor(text);
      return;
    }
    this.inner.setText(`${this.inner.getText()}${text}`);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.inner.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.inner.setAutocompleteMaxVisible?.(maxVisible);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  isShowingAutocomplete(): boolean {
    return (this.inner as unknown as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() ?? false;
  }

  dispose(): void {
    (this.inner as unknown as { dispose?: () => void }).dispose?.();
  }

  // ─── Suggestion API ─────────────────────────────────────────────

  setSuggestions(suggestions: string[], selectedIndex = 0): void {
    this.suggestions = suggestions.map((text) => text.trim()).filter(Boolean);
    this.selectedSuggestionIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, this.suggestions.length - 1)));
    this.tui.requestRender();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.tui.requestRender();
  }

  clearSuggestions(): void {
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

  setOnDismissSuggestion(handler: (() => void) | undefined): void {
    this.onDismissSuggestion = handler;
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

  handleInput(data: string): void {
    if (this.shouldShowGhost()) {
      // Accept suggestion — keep suggestions so ghost reappears if the user deletes the text
      if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        this.insertTextAtCursor(this.getSelectedSuggestion()!);
        this.onAcceptSuggestion?.();
        return;
      }
      // Escape does not dismiss anymore — suggestions persist until overwritten
      // Cycle through multiple suggestions with Alt+Up / Alt+Down. Some terminals
      // (including WezTerm without Kitty keyboard protocol) send xterm-style
      // modifier sequences that pi-tui does not currently normalize as alt+arrow.
      if (this.suggestions.length > 1) {
        if (this.matchesPreviousSuggestion(data)) {
          this.cycleSelection(-1);
          return;
        }
        if (this.matchesNextSuggestion(data)) {
          this.cycleSelection(1);
          return;
        }
      }
    }

    this.syncCustomEditorHooks();
    this.inner.handleInput(data);
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    const ghostVisible = this.shouldShowGhost();

    if (!ghostVisible) return lines;

    const editableLineIndex = lines.findIndex((line) => EMPTY_CURSOR_PATTERN.test(line));
    if (editableLineIndex === -1) return lines;

    const line = lines[editableLineIndex]!;
    const match = EMPTY_CURSOR_PATTERN.exec(line);
    if (!match || match.index === undefined) return lines;

    const before = line.slice(0, match.index + match[0].length);
    const after = line.slice(match.index + match[0].length);
    const availableColumns = after.match(/^\s*/)?.[0].length ?? 0;
    if (availableColumns <= 0) return lines;

    const ghost = truncateToWidth(this.getSelectedSuggestion()!, availableColumns, "");
    if (!ghost) return lines;

    const remainingSpaces = " ".repeat(Math.max(0, availableColumns - visibleWidth(ghost)));
    const rest = after.slice(availableColumns);
    lines[editableLineIndex] = `${before}${DIM}${ghost}${RESET}${remainingSpaces}${rest}`;
    return lines;
  }

  private matchesPreviousSuggestion(data: string): boolean {
    return matchesKey(data, "alt+up") || ALT_UP_SEQUENCES.has(data);
  }

  private matchesNextSuggestion(data: string): boolean {
    return matchesKey(data, "alt+down") || ALT_DOWN_SEQUENCES.has(data);
  }

  private syncCustomEditorHooks(): void {
    const custom = this.inner as unknown as {
      actionHandlers?: Map<string, () => void>;
      onEscape?: () => void;
      onCtrlD?: () => void;
      onPasteImage?: () => void;
      onExtensionShortcut?: (data: string) => boolean;
    };

    if (custom.actionHandlers instanceof Map) {
      for (const [action, handler] of this.actionHandlers) {
        custom.actionHandlers.set(action, handler);
      }
    }
    if (this.onEscape) custom.onEscape = this.onEscape;
    if (this.onCtrlD) custom.onCtrlD = this.onCtrlD;
    if (this.onPasteImage) custom.onPasteImage = this.onPasteImage;
    if (this.onExtensionShortcut) custom.onExtensionShortcut = this.onExtensionShortcut;
  }
}
