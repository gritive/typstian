import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_SYSTEM_FONT_BYTES,
  registerSystemFonts,
} from "../src/system-fonts";

describe("system font loading", () => {
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
