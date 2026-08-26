// @vitest-environment happy-dom

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
