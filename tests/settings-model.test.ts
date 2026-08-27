// @vitest-environment happy-dom

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemAdapter } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeSettings } from "../src/settings-model";
import { TypstianSettingsTab } from "../src/settings-tab";

describe("normalizeSettings", () => {
  it("uses the vault root by default", () => {
    expect(normalizeSettings({})).toEqual({ rootPath: "" });
  });

  it("trims the root and drops legacy native helper and font settings", () => {
    expect(normalizeSettings({
      rootPath: " projects/book ",
      helperExecutablePath: "/Applications/Legacy/helper-bin",
      executablePath: "/opt/local/bin/typst",
      fontPaths: ["fonts"],
      ignoreSystemFonts: true,
    })).toEqual({ rootPath: "projects/book" });
  });
});


// Obsidian's own FileSystemAdapter takes no constructor argument; the stub takes
// the vault path, which is the only part the settings tab reads.
const adapterFor = (vault: string): FileSystemAdapter =>
  new (FileSystemAdapter as unknown as new (base: string) => FileSystemAdapter)(vault);

describe("TypstianSettingsTab", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const hostFor = () => {
    const host = {
      settings: { rootPath: "" },
      registerInterval: vi.fn((id: number) => id),
      updateSettings: vi.fn((settings: { rootPath: string }) => {
        host.settings = settings;
        return Promise.resolve();
      }),
    };
    return host;
  };

  const descriptionOf = (tab: TypstianSettingsTab): DocumentFragment =>
    (tab.getSettingDefinitions()[0] as { desc: DocumentFragment }).desc;

  it("declares the compilation root so Obsidian can index it for search", () => {
    const tab = new TypstianSettingsTab({} as never, hostFor() as never);

    expect(tab.getSettingDefinitions()).toMatchObject([
      {
        name: "Compilation root",
        control: { type: "text", key: "rootPath", placeholder: "projects/book" },
      },
    ]);
    expect(descriptionOf(tab).textContent)
      .toBe("Optional path relative to the vault. Empty uses the vault root.");
  });

  it("reads the compilation root from the host settings", () => {
    const host = hostFor();
    host.settings = { rootPath: "projects/book" };

    expect(new TypstianSettingsTab({} as never, host as never).getControlValue("rootPath"))
      .toBe("projects/book");
  });

  it("saves only the latest compilation root after typing settles", async () => {
    vi.useFakeTimers();
    const host = hostFor();
    const tab = new TypstianSettingsTab({} as never, host as never);

    for (const value of ["p", "pr", "project"]) tab.setControlValue("rootPath", value);

    expect(host.updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(host.updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.updateSettings).toHaveBeenCalledOnce();
    expect(host.updateSettings).toHaveBeenCalledWith({ rootPath: "project" });
  });

  it("registers pending saves with the plugin unload lifecycle", async () => {
    vi.useFakeTimers();
    const host = hostFor();
    const tab = new TypstianSettingsTab({} as never, host as never);

    tab.setControlValue("rootPath", "project");
    for (const timer of host.registerInterval.mock.calls) window.clearTimeout(timer[0]);
    await vi.advanceTimersByTimeAsync(300);

    expect(host.registerInterval).toHaveBeenCalledOnce();
    expect(host.updateSettings).not.toHaveBeenCalled();
  });

  describe("compilation root feedback", () => {
    const temporaries: string[] = [];

    afterEach(() => {
      for (const temporary of temporaries.splice(0)) {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    });

    const vaultDir = (): string => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typst-settings-"));
      temporaries.push(temporary);
      return temporary;
    };

    const tabFor = (vault: string) => {
      const host = hostFor();
      const app = { vault: { adapter: adapterFor(vault) } };
      return { host, tab: new TypstianSettingsTab(app as never, host as never) };
    };

    const typeAndSettle = async (tab: TypstianSettingsTab, value: string): Promise<void> => {
      tab.setControlValue("rootPath", value);
      await vi.advanceTimersByTimeAsync(300);
    };

    it("confirms a root that resolves to a folder in the vault", async () => {
      vi.useFakeTimers();
      const vault = vaultDir();
      fs.mkdirSync(path.join(vault, "book"));
      const { tab } = tabFor(vault);
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "book");

      expect(desc.textContent).toContain("Ready: this folder is inside the vault.");
    });

    it("reports a root that names no folder yet, and still saves it", async () => {
      vi.useFakeTimers();
      const { host, tab } = tabFor(vaultDir());
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "boook");

      expect(desc.textContent)
        .toContain("No folder at this path yet. Create it, or type a path that exists.");
      expect(host.updateSettings).toHaveBeenCalledWith({ rootPath: "boook" });
    });

    it("reports a root that is a file rather than a folder", async () => {
      vi.useFakeTimers();
      const vault = vaultDir();
      fs.writeFileSync(path.join(vault, "book.typ"), "");
      const { tab } = tabFor(vault);
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "book.typ");

      expect(desc.textContent)
        .toContain("This path is a file, not a folder. Type the path of a folder instead.");
    });

    it("reports a root the filesystem refuses to read", async () => {
      vi.useFakeTimers();
      const vault = vaultDir();
      fs.symlinkSync("loop-b", path.join(vault, "loop-a"));
      fs.symlinkSync("loop-a", path.join(vault, "loop-b"));
      const { tab } = tabFor(vault);
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "loop-a");

      expect(desc.textContent)
        .toContain("This path cannot be read. Check its permissions, or type another path.");
    });

    it("reports a root that is a link pointing at nothing", async () => {
      vi.useFakeTimers();
      const vault = vaultDir();
      fs.symlinkSync(path.join(vault, "gone"), path.join(vault, "linked"));
      const { tab } = tabFor(vault);
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "linked");

      expect(desc.textContent)
        .toContain("This link points at nothing. Fix the link, or type another path.");
    });

    it("reports a root that escapes the vault, even when nothing is there", async () => {
      vi.useFakeTimers();
      const temporary = vaultDir();
      const vault = path.join(temporary, "vault");
      fs.mkdirSync(vault);
      const { tab } = tabFor(vault);
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "../notes");

      expect(desc.textContent)
        .toContain("This path leaves the vault. Type a path inside the vault instead.");
    });

    it("says nothing about an empty root, which already means the vault root", async () => {
      vi.useFakeTimers();
      const vault = vaultDir();
      fs.mkdirSync(path.join(vault, "book"));
      const { tab } = tabFor(vault);
      const desc = descriptionOf(tab);

      await typeAndSettle(tab, "book");
      await typeAndSettle(tab, "");

      expect(desc.textContent)
        .toBe("Optional path relative to the vault. Empty uses the vault root.");
    });

    it("shows the state of the stored root as soon as the tab is rendered", () => {
      const host = hostFor();
      host.settings = { rootPath: "boook" };
      const app = { vault: { adapter: adapterFor(vaultDir()) } };
      const tab = new TypstianSettingsTab(app as never, host as never);

      expect(descriptionOf(tab).textContent).toContain("No folder at this path yet.");
    });
  });

  it("ignores a key or value it does not own", async () => {
    vi.useFakeTimers();
    const host = hostFor();
    const tab = new TypstianSettingsTab({} as never, host as never);

    tab.setControlValue("unknown", "value");
    tab.setControlValue("rootPath", 7);
    await vi.advanceTimersByTimeAsync(300);

    expect(host.updateSettings).not.toHaveBeenCalled();
  });
});
