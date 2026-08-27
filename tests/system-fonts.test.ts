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

describe("system font directories", () => {
  it("includes the mount points a sandboxed Obsidian sees host fonts at", () => {
    const directories = withPlatform("linux", () => systemFontDirectories());

    expect(directories).toEqual(
      expect.arrayContaining(["/run/host/fonts", "/run/host/local-fonts", "/run/host/user-fonts"]),
    );
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
