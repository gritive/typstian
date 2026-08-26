// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

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


describe("TypstianSettingsTab", () => {
  const hostFor = () => {
    const host = {
      settings: { rootPath: "" },
      updateSettings: vi.fn((settings: { rootPath: string }) => {
        host.settings = settings;
        return Promise.resolve();
      }),
    };
    return host;
  };

  it("declares the compilation root so Obsidian can index it for search", () => {
    const tab = new TypstianSettingsTab({} as never, hostFor() as never);

    expect(tab.getSettingDefinitions()).toEqual([
      {
        name: "Compilation root",
        desc: "Optional path relative to the vault. Empty uses the vault root.",
        control: { type: "text", key: "rootPath", placeholder: "projects/book" },
      },
    ]);
  });

  it("reads the compilation root from the host settings", () => {
    const host = hostFor();
    host.settings = { rootPath: "projects/book" };

    expect(new TypstianSettingsTab({} as never, host as never).getControlValue("rootPath"))
      .toBe("projects/book");
  });

  it("persists a changed compilation root through the host", async () => {
    const host = hostFor();
    const tab = new TypstianSettingsTab({} as never, host as never);

    await tab.setControlValue("rootPath", "projects/book");

    expect(host.updateSettings).toHaveBeenCalledWith({ rootPath: "projects/book" });
  });

  it("ignores a key or value it does not own", async () => {
    const host = hostFor();
    const tab = new TypstianSettingsTab({} as never, host as never);

    await tab.setControlValue("unknown", "value");
    await tab.setControlValue("rootPath", 7);

    expect(host.updateSettings).not.toHaveBeenCalled();
  });
});
