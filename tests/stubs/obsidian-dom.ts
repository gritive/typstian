// Obsidian adds its DOM helpers to the runtime globals and to Node.prototype;
// vitest has to supply the few the plugin uses. Node-environment test files
// get nothing.
if (typeof document !== "undefined") {
  const create = (parent: Node, tag: string, info?: { cls?: string } | string): HTMLElement => {
    const element = document.createElement(tag);
    const cls = typeof info === "string" ? info : info?.cls;
    if (cls !== undefined) element.className = cls;
    parent.appendChild(element);
    return element;
  };

  const nodeHelpers = {
    createEl(this: Node, tag: string, info?: { cls?: string } | string) {
      return create(this, tag, info);
    },
    createDiv(this: Node, info?: { cls?: string } | string) {
      return create(this, "div", info);
    },
    createSpan(this: Node, info?: { cls?: string } | string) {
      return create(this, "span", info);
    },
  };
  for (const [name, value] of Object.entries(nodeHelpers)) {
    Object.defineProperty(Node.prototype, name, { configurable: true, writable: true, value });
  }

  Object.defineProperty(Node.prototype, "win", {
    configurable: true,
    get(this: Node): Window {
      return (this.ownerDocument ?? document).defaultView ?? window;
    },
  });

  Object.defineProperty(Node.prototype, "doc", {
    configurable: true,
    get(this: Node): Document {
      return this.ownerDocument ?? document;
    },
  });

  const globals = globalThis as unknown as { createFragment: () => DocumentFragment };
  globals.createFragment = () => document.createDocumentFragment();
}
