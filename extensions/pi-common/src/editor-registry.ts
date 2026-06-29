import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EditorFactoryArgs = Parameters<EditorFactory>;

export type EditorDecorator = (inner: EditorComponent, ...args: EditorFactoryArgs) => EditorComponent;

interface DecoratorEntry {
	id: string;
	decorate: EditorDecorator;
	order: number;
}

interface EditorRegistryState {
	baseFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	installedFactory?: EditorFactory;
	decorators: Map<string, DecoratorEntry>;
	generation: number;
}

const EDITOR_REGISTRY_SYMBOL = Symbol.for("aldoborrero.pi-common.editor-registry");

type RegistryHost = {
	[EDITOR_REGISTRY_SYMBOL]?: WeakMap<ExtensionContext, EditorRegistryState>;
};

function registry(): WeakMap<ExtensionContext, EditorRegistryState> {
	const host = globalThis as RegistryHost;
	return (host[EDITOR_REGISTRY_SYMBOL] ??= new WeakMap<ExtensionContext, EditorRegistryState>());
}

function getState(ctx: ExtensionContext): EditorRegistryState {
	const reg = registry();
	const existing = reg.get(ctx);
	if (existing) return existing;

	const state: EditorRegistryState = {
		baseFactory: ctx.ui.getEditorComponent(),
		decorators: new Map(),
		generation: 0,
	};
	reg.set(ctx, state);
	return state;
}

function makeDefaultEditor([tui, theme, keybindings]: EditorFactoryArgs): EditorComponent {
	return new CustomEditor(tui, theme, keybindings);
}

function rebuildEditor(ctx: ExtensionContext, state: EditorRegistryState): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	if (state.decorators.size === 0) {
		if (ctx.ui.getEditorComponent() === state.installedFactory) {
			ctx.ui.setEditorComponent(state.baseFactory);
		}
		state.installedFactory = undefined;
		return;
	}

	const generation = ++state.generation;
	const factory: EditorFactory = (...args) => {
		let editor = state.baseFactory ? state.baseFactory(...args) : makeDefaultEditor(args);
		const decorators = [...state.decorators.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
		for (const entry of decorators) {
			editor = entry.decorate(editor, ...args);
		}
		return editor;
	};

	// Tag for diagnostics/debugging without depending on function identity names.
	Object.defineProperty(factory, "__piEditorRegistryGeneration", {
		value: generation,
		configurable: true,
	});

	state.installedFactory = factory;
	ctx.ui.setEditorComponent(factory);
}

export function registerEditorDecorator(
	ctx: ExtensionContext,
	id: string,
	decorate: EditorDecorator,
	options: { order?: number } = {},
): () => void {
	if (!ctx.hasUI || ctx.mode !== "tui") return () => undefined;

	const state = getState(ctx);
	state.decorators.set(id, {
		id,
		decorate,
		order: options.order ?? 0,
	});
	rebuildEditor(ctx, state);

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const current = registry().get(ctx);
		if (!current) return;
		current.decorators.delete(id);
		rebuildEditor(ctx, current);
	};
}

export function isEditorRegistryInstalled(ctx: ExtensionContext): boolean {
	const state = registry().get(ctx);
	return !!state?.installedFactory && ctx.ui.getEditorComponent() === state.installedFactory;
}

export function getRegisteredEditorDecorators(ctx: ExtensionContext): string[] {
	return [...(registry().get(ctx)?.decorators.keys() ?? [])];
}
