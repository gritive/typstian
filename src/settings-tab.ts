import {
  FileSystemAdapter,
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionItem
} from "obsidian";

import { checkCompilationRoot } from "./path-policy";
import type { TypstianSettings } from "./settings-model";

export interface SettingsHost {
  settings: TypstianSettings;
  updateSettings(value: TypstianSettings): Promise<void>;
}

const ROOT_PATH_KEY = "rootPath";
// Every accepted change restarts each preview's compiler backend, so a burst of
// keystrokes has to settle into one save.
const SAVE_DEBOUNCE_MS = 300;
const ROOT_PATH_DESC = "Optional path relative to the vault. Empty uses the vault root.";
// Without this, an unusable root only surfaces much later as a notice on an
// unrelated action: creating a file rejects a root outside the vault, opening a
// preview rejects an entry the root cannot contain. Each sentence has to be true
// of exactly its own state and name the action that fixes that state, since the
// fixes differ: create the folder, retype the path, or repair permissions.
const ROOT_STATUS = {
  "ok": "Ready: this folder is inside the vault.",
  "missing": "No folder at this path yet. Create it, or type a path that exists.",
  "not-a-folder": "This path is a file, not a folder. Type the path of a folder instead.",
  "broken-link": "This link points at nothing. Fix the link, or type another path.",
  "unreadable": "This path cannot be read. Check its permissions, or type another path.",
  "outside-vault": "This path leaves the vault. Type a path inside the vault instead."
} as const;

export class TypstianSettingsTab extends PluginSettingTab {
  private saveTimer: number | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    // The status lives in the row's own description, so it can be rewritten in
    // place without re-rendering the field the user is typing in.
    const desc = createFragment();
    desc.createSpan().textContent = ROOT_PATH_DESC;
    this.statusEl = desc.createDiv();
    this.showStatus(this.host.settings.rootPath);
    return [
      {
        name: "Compilation root",
        desc,
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
      // The check touches the filesystem, so it runs once per settled edit,
      // on the same beat as the save it reports on. An unusable value is still
      // saved: the folder may not exist yet, and dropping what was typed
      // without saying so is exactly the silence this feedback removes.
      this.showStatus(value);
      void this.host.updateSettings({ ...this.host.settings, rootPath: value });
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer = timer;
    this.host.registerInterval(timer);
  }

  /** Says, in the setting row, whether `rootPath` names a usable folder. */
  private showStatus(rootPath: string): void {
    const status = this.statusEl;
    if (status === null) return;
    status.className = "typstian-setting-status";
    // Empty means the vault root, which the description already explains, and a
    // vault that is not on a local filesystem fails long before this setting.
    const vaultRoot = rootPath.trim() === "" ? null : this.vaultRoot();
    if (vaultRoot === null) {
      status.textContent = "";
      return;
    }
    const check = checkCompilationRoot(vaultRoot, rootPath);
    if (!check.ok) status.className += " is-invalid";
    status.textContent = ROOT_STATUS[check.ok ? "ok" : check.reason];
  }

  private vaultRoot(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }
}
