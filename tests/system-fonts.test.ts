import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_SYSTEM_FONT_BYTES,
  registerSystemFonts,
  systemFontDirectories,
} from "../src/system-fonts";

// `systemFontDirectories` is a pure function of the platform and the
// environment, so a test drives it by replacing both. `process.platform` is a
// non-writable property, hence the descriptor dance rather than an assignment.
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

// Fontconfig discovery reads real files, so each test owns a temporary
// configuration tree and points the environment at it. Every channel the
// production code consults is stubbed, even the ones a test does not use, so a
// developer's own /etc/fonts cannot leak into the result.
function withFontconfig<T>(
  environment: Record<string, string | undefined>,
  run: (root: string) => T,
): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-fontconfig-"));
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  const resolved = {
    FONTCONFIG_FILE: undefined,
    FONTCONFIG_PATH: empty,
    XDG_CONFIG_HOME: empty,
    ...environment,
  };
  for (const [name, value] of Object.entries(resolved)) {
    vi.stubEnv(name, value as string | undefined);
  }
  try {
    return run(root);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("system font directories", () => {
  it("includes the mount points a sandboxed Obsidian sees host fonts at", () => {
    const directories = withPlatform("linux", () => systemFontDirectories());

    expect(directories).toEqual(
      expect.arrayContaining(["/run/host/fonts", "/run/host/local-fonts", "/run/host/user-fonts"]),
    );
  });

  it("scans the directories the fontconfig file named by the environment declares", () => {
    const directories = withFontconfig({}, (root) => {
      const configuration = path.join(root, "fonts.conf");
      fs.writeFileSync(
        configuration,
        `<?xml version="1.0"?>
<fontconfig>
  <dir>/opt/declared-fonts</dir>
</fontconfig>`,
      );
      vi.stubEnv("FONTCONFIG_FILE", configuration);
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(directories).toContain("/opt/declared-fonts");
  });

  it("expands ~ and resolves a relative xdg-prefixed directory against XDG_DATA_HOME", () => {
    const directories = withFontconfig({ XDG_DATA_HOME: "/data/home" }, (root) => {
      const configuration = path.join(root, "fonts.conf");
      fs.writeFileSync(
        configuration,
        `<fontconfig>
  <dir>~/my-fonts</dir>
  <dir prefix="xdg">fonts</dir>
</fontconfig>`,
      );
      vi.stubEnv("FONTCONFIG_FILE", configuration);
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(directories).toContain(path.join(os.homedir(), "my-fonts"));
    expect(directories).toContain("/data/home/fonts");
  });

  it("reads fonts.conf and every conf.d fragment from the fontconfig path", () => {
    const directories = withFontconfig({}, (root) => {
      const fontconfigPath = path.join(root, "fonts");
      fs.mkdirSync(path.join(fontconfigPath, "conf.d"), { recursive: true });
      fs.writeFileSync(
        path.join(fontconfigPath, "fonts.conf"),
        "<fontconfig><dir>/opt/system-fonts</dir></fontconfig>",
      );
      fs.writeFileSync(
        path.join(fontconfigPath, "conf.d", "10-extra.conf"),
        "<fontconfig><dir>/opt/fragment-fonts</dir></fontconfig>",
      );
      fs.writeFileSync(path.join(fontconfigPath, "conf.d", "notes.txt"), "<dir>/opt/ignored</dir>");
      vi.stubEnv("FONTCONFIG_PATH", fontconfigPath);
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(directories).toContain("/opt/system-fonts");
    expect(directories).toContain("/opt/fragment-fonts");
    expect(directories).not.toContain("/opt/ignored");
  });
});

describe("system font loading", () => {
  it("registers a font the residency plan cannot fit, without retaining it", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-font-"));
    try {
      const kept = path.join(temporary, "kept.ttf");
      const skipped = path.join(temporary, "skipped.ttf");
      fs.writeFileSync(kept, "x".repeat(1024));
      fs.writeFileSync(skipped, "y".repeat(512));
      const registerFont = vi.fn<(path: string, bytes: Uint8Array, resident: boolean) => number>(
        () => 1,
      );

      // A cap that only the larger file fits: the smaller one must still reach
      // the compiler, just without its bytes being held.
      await registerSystemFonts([temporary], registerFont, undefined, 1024);

      const residency = new Map(
        registerFont.mock.calls.map(([fontPath, , resident]) => [fontPath, resident]),
      );
      expect(residency.get(fs.realpathSync(kept))).toBe(true);
      expect(residency.get(fs.realpathSync(skipped))).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("registers every font in nested system directories", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-font-"));
    try {
      const nested = path.join(temporary, "nested");
      fs.mkdirSync(nested);
      const first = path.join(temporary, "first.ttf");
      const second = path.join(nested, "second.otf");
      fs.writeFileSync(first, "first font");
      fs.writeFileSync(second, "second font");
      fs.writeFileSync(path.join(temporary, "ignored.txt"), "not a font");
      const registerFont = vi.fn(() => 1);

      const fonts = await registerSystemFonts([temporary, temporary], registerFont);

      expect(registerFont).toHaveBeenCalledTimes(2);
      expect(registerFont).toHaveBeenCalledWith(
        fs.realpathSync(first),
        Buffer.from("first font"),
        true,
      );
      expect(registerFont).toHaveBeenCalledWith(
        fs.realpathSync(second),
        Buffer.from("second font"),
        true,
      );
      expect(fonts.readSync(fs.realpathSync(first))).toEqual(Buffer.from("first font"));
      await expect(fonts.read(fs.realpathSync(second))).resolves.toEqual(
        Buffer.from("second font"),
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("skips oversized and invalid fonts and denies unregistered paths", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-font-"));
    try {
      const oversized = path.join(temporary, "oversized.ttf");
      const invalid = path.join(temporary, "invalid.ttf");
      const usable = path.join(temporary, "usable.ttf");
      fs.writeFileSync(oversized, "");
      fs.truncateSync(oversized, MAX_SYSTEM_FONT_BYTES + 1);
      fs.writeFileSync(invalid, "invalid");
      fs.writeFileSync(usable, "usable");
      const registerFont = vi.fn((_fontPath: string, bytes: Uint8Array) => {
        if (Buffer.from(bytes).toString() === "invalid") throw new Error("invalid font");
        return 1;
      });

      const fonts = await registerSystemFonts([temporary], registerFont);

      expect(registerFont).toHaveBeenCalledTimes(2);
      expect(fonts.readSync(fs.realpathSync(invalid))).toBeUndefined();
      expect(fonts.readSync(fs.realpathSync(oversized))).toBeUndefined();
      expect(fonts.readSync(fs.realpathSync(usable))).toEqual(Buffer.from("usable"));
      await expect(fonts.read(path.join(temporary, "not-registered.ttf"))).resolves.toBeUndefined();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("stops scanning when initialization is aborted", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-font-"));
    try {
      fs.writeFileSync(path.join(temporary, "first.ttf"), "first");
      fs.writeFileSync(path.join(temporary, "second.ttf"), "second");
      const controller = new AbortController();
      const registerFont = vi.fn(() => {
        controller.abort();
        return 1;
      });

      await expect(
        registerSystemFonts([temporary], registerFont, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(registerFont).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
