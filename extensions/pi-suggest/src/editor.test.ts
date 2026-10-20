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
describe("SuggestEditor cancel-on-type", () => {
	function makeChain(): {
		suggest: SuggestEditor;
		innerCalls: () => number;
		assignHostOnChange: (handler: ((text: string) => void) | undefined) => void;
		fireInnerChange: (text: string) => void;
	} {
		let innerInputs = 0;
		let chained: ((text: string) => void) | undefined;
		const editor = {
			getText: () => "",
			setText: () => {},
			handleInput: () => {
				innerInputs++;
			},
			render: () => [],
			invalidate: () => {},
			// Inner editor: whoever assigns onChange lands here (the chain end).
			set onChange(handler: ((text: string) => void) | undefined) {
				chained = handler;
			},
			get onChange() {
				return chained;
			},
		} as unknown as import("@earendil-works/pi-tui").EditorComponent;
		const suggest = makeEditor(editor);
		return {
			suggest,
			innerCalls: () => innerInputs,
			// The host assigns its handler on the OUTERMOST decorator (this wrapper).
			assignHostOnChange: (handler) => {
				(suggest as unknown as { onChange: (h: ((text: string) => void) | undefined) => void }).onChange = handler;
			},
			// The inner editor firing change = the wrapped chain executing.
			fireInnerChange: (text) => chained?.(text),
		};
	}

	test("host onChange assignment installs the observer in the chain", () => {
		const chain = makeChain();
		let observed = 0;
		chain.assignHostOnChange(() => {});
		chain.suggest.setOnUserInput(() => {
			observed++;
		});

		chain.fireInnerChange("hello");
		expect(observed).toBe(1);
		expect(chain.innerCalls()).toBe(0); // onChange does not touch handleInput
	});

	test("observer survives host handler reassignment", () => {
		const chain = makeChain();
		let observed = 0;
		chain.assignHostOnChange(() => {});
		chain.suggest.setOnUserInput(() => {
			observed++;
		});

		chain.fireInnerChange("a");
		expect(observed).toBe(1);

		// The host replaces its handler (pi does across session events).
		chain.assignHostOnChange(() => {});
		chain.fireInnerChange("b");
		expect(observed).toBe(2);
	});

	test("removing the host handler clears the chain but keeps wrapping safe", () => {
		const chain = makeChain();
		let observed = 0;
		chain.assignHostOnChange(() => {});
		chain.suggest.setOnUserInput(() => {
			observed++;
		});

		chain.assignHostOnChange(undefined);
		chain.fireInnerChange("c");
		expect(observed).toBe(0); // chain cleared, no crash
	});
});

describe("SuggestEditor mouse + theme", () => {
	const CURSOR_LINE = "\x1b[7m \x1b[0m     "; // fake cursor cell + 5 padding cols

	function makeMouseHarness(theme?: { fg: (token: string, text: string) => string }) {
		let inserted: string | null = null;
		let innerMouseEvents = 0;
		const editor = {
			getText: () => "",
			setText: () => {},
			handleInput: () => {},
			handleMouse: () => {
				innerMouseEvents++;
				return { handled: true };
			},
			insertTextAtCursor: (text: string) => {
				inserted = text;
			},
			render: () => [CURSOR_LINE],
			invalidate: () => {},
		} as unknown as import("@earendil-works/pi-tui").EditorComponent;
		const tui = { requestRender: () => {} } as unknown as import("@earendil-works/pi-tui").TUI;
		const suggest = new SuggestEditor(editor, tui, theme);
		suggest.setEnabled(true);
		suggest.setSuggestions(["run the tests"]);
		return { suggest, inserted: () => inserted, innerMouseEvents: () => innerMouseEvents };
	}

	const click = (x: number, y: number) =>
		({
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 80,
			height: 24,
		}) as unknown as import("@earendil-works/pi-tui").TuiMouseEvent;

	test("click on the ghost span accepts the suggestion", () => {
		const harness = makeMouseHarness();
		harness.suggest.render(80);
		// ghost starts right after the cursor cell (col 1); click inside it
		const result = harness.suggest.handleMouse?.(click(2, 1));
		expect(result?.handled).toBe(true);
		expect(harness.inserted()).toBe("run the tests");
	});

	test("click elsewhere forwards to the inner editor", () => {
		const harness = makeMouseHarness();
		harness.suggest.render(80);
		const result = harness.suggest.handleMouse?.(click(2, 5));
		expect(harness.innerMouseEvents()).toBe(1);
		expect(result?.handled).toBe(true); // from the inner handler
		expect(harness.inserted()).toBeNull();
	});

	test("stale ghost span never accepts (ghost cleared on re-render)", () => {
		const harness = makeMouseHarness();
		harness.suggest.render(80);
		harness.suggest.clearSuggestions();
		harness.suggest.render(80); // no ghost now
		const before = harness.innerMouseEvents();
		harness.suggest.handleMouse?.(click(2, 1));
		expect(harness.innerMouseEvents()).toBe(before + 1);
		expect(harness.inserted()).toBeNull();
	});

	test("ghost uses the theme muted token when a theme is provided", () => {
		const harness = makeMouseHarness({ fg: (token, text) => `T[${token}]${text}` });
		const lines = harness.suggest.render(80);
		expect(lines[0]).toContain("T[muted]run t"); // truncated to the 5 available columns
	});

	test("ghost falls back to DIM without a theme", () => {
		const harness = makeMouseHarness();
		const lines = harness.suggest.render(80);
		expect(lines[0]).toContain("\x1b[2m");
	});
});
