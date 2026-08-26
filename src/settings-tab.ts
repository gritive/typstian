import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from "obsidian";

import type { TypstianSettings } from "./settings-model";

export interface SettingsHost {
  settings: TypstianSettings;
  updateSettings(value: TypstianSettings): Promise<void>;
}

const ROOT_PATH_KEY = "rootPath";

export class TypstianSettingsTab extends PluginSettingTab {
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

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== ROOT_PATH_KEY || typeof value !== "string") return;
    await this.host.updateSettings({ ...this.host.settings, rootPath: value });
  }
}
