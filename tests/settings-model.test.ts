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

  it("saves only the latest compilation root after typing settles", async () => {
    vi.useFakeTimers();
    const host = {
      settings: { rootPath: "" },
      registerInterval: vi.fn((id: number) => id),
      updateSettings: vi.fn((settings: { rootPath: string }) => {
        host.settings = settings;
        return Promise.resolve();
      }),
    };
    const tab = new TypstianSettingsTab({} as never, host as never);
    tab.display();
    const input = tab.containerEl.querySelector("input");
    if (input === null) throw new Error("missing compilation root input");

    for (const value of ["p", "pr", "project"]) {
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }

    expect(host.updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(host.updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.updateSettings).toHaveBeenCalledOnce();
    expect(host.updateSettings).toHaveBeenCalledWith({ rootPath: "project" });
  });

  it("registers pending saves with the plugin unload lifecycle", async () => {
    vi.useFakeTimers();
    const timers: number[] = [];
    const host = {
      settings: { rootPath: "" },
      registerInterval: vi.fn((id: number) => {
        timers.push(id);
        return id;
      }),
      updateSettings: vi.fn(() => Promise.resolve()),
    };
    const tab = new TypstianSettingsTab({} as never, host as never);
    tab.display();
    const input = tab.containerEl.querySelector("input");
    if (input === null) throw new Error("missing compilation root input");

    input.value = "project";
    input.dispatchEvent(new Event("input"));
    for (const timer of timers) globalThis.clearTimeout(timer);
    await vi.advanceTimersByTimeAsync(300);

    expect(host.registerInterval).toHaveBeenCalledOnce();
    expect(host.updateSettings).not.toHaveBeenCalled();
  });
});
