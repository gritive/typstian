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

export class View {
  constructor(public readonly leaf?: unknown) {}
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

