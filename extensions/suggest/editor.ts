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
  private onAcceptSuggestion?: () => void;
  private onSelectSuggestion?: ((index: number) => void) | undefined;
