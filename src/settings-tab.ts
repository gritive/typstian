import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import type { TypstianSettings } from "./settings-model";

export interface SettingsHost {
  settings: TypstianSettings;
  updateSettings(value: TypstianSettings): Promise<void>;
}

export class TypstianSettingsTab extends PluginSettingTab {
  private saveTimer: number | null = null;

  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  override display(): void {
    this.containerEl.replaceChildren();

    new Setting(this.containerEl)
      .setName("Compilation root")
      .setDesc("Optional path relative to the vault. Empty uses the vault root.")
      .addText((text) => text
        .setPlaceholder("projects/book")
        .setValue(this.host.settings.rootPath)
        .onChange((value) => {
          this.scheduleSave({ rootPath: value });
        }));
  }

  private scheduleSave(change: Partial<TypstianSettings>): void {
    if (this.saveTimer !== null) globalThis.window.clearTimeout(this.saveTimer);
    const timer = globalThis.window.setTimeout(() => {
      this.saveTimer = null;
      void this.save(change);
    }, 300);
    this.saveTimer = timer;
    this.host.registerInterval(timer);
  }

  private async save(change: Partial<TypstianSettings>): Promise<void> {
    await this.host.updateSettings({ ...this.host.settings, ...change });
  }
}
