import { describe, expect, test } from "bun:test";
import { SuggestEditor } from "./editor.ts";

function makeInner(): {
	editor: import("@earendil-works/pi-tui").EditorComponent;
	text: string;
} {
	const state = { text: "" };
	const editor = {
		getText: () => state.text,
		setText: (t: string) => {
			state.text = t;
		},
		handleInput: () => {},
		render: () => [],
		invalidate: () => {},
	};
	return { editor: editor as unknown as import("@earendil-works/pi-tui").EditorComponent, text: state.text };
}

function makeEditor(inner: import("@earendil-works/pi-tui").EditorComponent): SuggestEditor {
	const tui = { requestRender: () => {} } as unknown as import("@earendil-works/pi-tui").TUI;
	return new SuggestEditor(inner, tui);
}

describe("SuggestEditor generating state", () => {
	test("Escape while generating invokes the cancel hook instead of the inner editor", () => {
		const { editor, text } = makeInner();
		const suggest = makeEditor(editor);
		let innerInputs = 0;
		(editor as { handleInput: (d: string) => void }).handleInput = () => {
			innerInputs++;
		};
		let cancelled = 0;
		suggest.setOnCancelGeneration(() => {
			cancelled++;
		});

		suggest.setGenerating(false);
		suggest.handleInput("\x1b");
		expect(cancelled).toBe(0);
		expect(innerInputs).toBe(1); // reaches inner editor normally

		suggest.setGenerating(true);
		suggest.handleInput("\x1b");
		expect(cancelled).toBe(1);
		expect(innerInputs).toBe(1); // intercepted
		expect(text).toBe("");
	});

	test("non-escape keys still reach the inner editor while generating", () => {
		const { editor } = makeInner();
		const suggest = makeEditor(editor);
		let innerInputs = 0;
		(editor as { handleInput: (d: string) => void }).handleInput = () => {
			innerInputs++;
		};
		suggest.setGenerating(true);
		suggest.handleInput("a");
		expect(innerInputs).toBe(1);
	});
});
