import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from "obsidian";

import type { TypstianSettings } from "./settings-model";

export interface SettingsHost {
  settings: TypstianSettings;
  updateSettings(value: TypstianSettings): Promise<void>;
}

const ROOT_PATH_KEY = "rootPath";
// Every accepted change restarts each preview's compiler backend, so a burst of
// keystrokes has to settle into one save.
const SAVE_DEBOUNCE_MS = 300;

export class TypstianSettingsTab extends PluginSettingTab {
  private saveTimer: number | null = null;

  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Compilation root",
        desc: "Optional path relative to the vault. Empty uses the vault root.",
        control: { type: "text", key: ROOT_PATH_KEY, placeholder: "projects/book" },
      },
    ];
  }

  override getControlValue(key: string): unknown {
    return key === ROOT_PATH_KEY ? this.host.settings.rootPath : undefined;
  }

  override setControlValue(key: string, value: unknown): void {
    if (key !== ROOT_PATH_KEY || typeof value !== "string") return;
    const win = this.containerEl.win;
    if (this.saveTimer !== null) win.clearTimeout(this.saveTimer);
    const timer = win.setTimeout(() => {
      this.saveTimer = null;
      void this.host.updateSettings({ ...this.host.settings, rootPath: value });
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer = timer;
    this.host.registerInterval(timer);
  }
}
