export class TextFileView {
  contentEl: HTMLElement;
  data = "";
  file: { path: string; extension: string } | null = null;

  constructor(_leaf?: unknown) {
    void _leaf;
    this.contentEl = document.createElement("div");
  }

  requestSave(): void {}
}

export class ItemView {
  contentEl: HTMLElement;

  constructor(public readonly leaf?: unknown) {
    this.contentEl = document.createElement("div");
  }
}

export class TFile {
  readonly extension: string;
  readonly basename: string;

  constructor(public readonly path: string = "") {
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    this.extension = dot < 0 ? "" : name.slice(dot + 1);
    this.basename = dot < 0 ? name : name.slice(0, dot);
  }
}

export class FileSystemAdapter {
  constructor(private readonly basePath: string) {}

  getBasePath(): string {
    return this.basePath;
  }
}

export class Notice {
  constructor(_message: string) {
    void _message;
  }
}

export class Plugin {
  settings: unknown;

  constructor(
    public readonly app: unknown,
    public readonly manifest: unknown = {},
  ) {}

  loadData(): Promise<unknown> {
    return Promise.resolve({});
  }

  saveData(data: unknown): Promise<void> {
    void data;
    return Promise.resolve();
  }

  registerView(type: string, creator: unknown): void {
    void type;
    void creator;
  }

  registerExtensions(extensions: string[], viewType: string): void {
    void extensions;
    void viewType;
  }

  addCommand(command: unknown): void {
    void command;
  }

  addSettingTab(tab: unknown): void {
    void tab;
  }

  registerEvent<T>(event: T): T {
    return event;
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");

  constructor(
    public readonly app: unknown,
    public readonly plugin: unknown,
  ) {}

  display(): void {}
}

export class Setting {
  constructor(private readonly containerEl: HTMLElement) {}

  setName(name: string): this {
    void name;
    return this;
  }

  setDesc(description: string): this {
    void description;
    return this;
  }

  addText(callback: (component: {
    inputEl: HTMLInputElement;
    setPlaceholder(value: string): unknown;
    setValue(value: string): unknown;
    onChange(handler: (value: string) => void): unknown;
  }) => void): this {
    const inputEl = document.createElement("input");
    this.containerEl.append(inputEl);
    const component = {
      inputEl,
      setPlaceholder: (value: string) => {
        inputEl.placeholder = value;
        return component;
      },
      setValue: (value: string) => {
        inputEl.value = value;
        return component;
      },
      onChange: (handler: (value: string) => void) => {
        inputEl.addEventListener("input", () => handler(inputEl.value));
        return component;
      },
    };
    callback(component);
    return this;
  }

  addToggle(callback: (component: {
    setValue(value: boolean): unknown;
    onChange(handler: (value: boolean) => void): unknown;
  }) => void): this {
    const component = {
      setValue: () => component,
      onChange: () => component,
    };
    callback(component);
    return this;
  }
}
