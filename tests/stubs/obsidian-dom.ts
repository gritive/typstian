// Obsidian injects its DOM helpers as globals at runtime; vitest has to supply
// the few the plugin uses. Node-environment test files get nothing.
if (typeof document !== "undefined") {
  const globals = globalThis as unknown as {
    createEl: (tag: string) => HTMLElement;
    createDiv: () => HTMLDivElement;
  };
  globals.createEl = (tag) => document.createElement(tag);
  globals.createDiv = () => document.createElement("div");
}
