import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_FONTCONFIG_FILE_BYTES,
  MAX_FONTCONFIG_FRAGMENTS,
  MAX_FONTCONFIG_INCLUDE_DEPTH,
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
    vi.stubEnv(name, value);
  }
  try {
    return run(root);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The default configuration roots are absolute paths a test cannot create, so
// pinning them means serving a virtual filesystem to discovery and observing
// which paths it asks for. Anything not in `files` reads as absent.
function withVirtualFontconfig<T>(
  files: Record<string, string>,
  run: (reads: string[]) => T,
): T {
  // The read log is how a test can tell "terminated" from "terminated because
  // each file was read once": a swallowed stack overflow also terminates.
  const reads: string[] = [];
  const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(((file: string) => {
    const contents = files[file];
    if (contents === undefined) throw new Error(`ENOENT: ${file}`);
    reads.push(file);
    return contents;
  }) as unknown as typeof fs.readFileSync);
  const stat = vi.spyOn(fs, "statSync").mockImplementation(((file: string) => {
    const contents = files[file];
    if (contents === undefined) throw new Error(`ENOENT: ${file}`);
    return { size: Buffer.byteLength(contents) };
  }) as unknown as typeof fs.statSync);
  // Directory listings come from the same map, so a virtual conf.d behaves
  // like a real one; a directory with no files reads as absent.
  const readDir = vi.spyOn(fs, "readdirSync").mockImplementation(((directory: string) => {
    const entries = Object.keys(files)
      .filter((file) => path.dirname(file) === directory)
      .map((file) => path.basename(file));
    if (entries.length === 0) throw new Error(`ENOENT: ${directory}`);
    return entries;
  }) as unknown as typeof fs.readdirSync);
  try {
    return run(reads);
  } finally {
    readFile.mockRestore();
    stat.mockRestore();
    readDir.mockRestore();
  }
}

// The common shape: one configuration file, named by FONTCONFIG_FILE, read on
// Linux. `write` gets the temporary root and returns that file's contents.
function linuxDirectoriesFor(
  write: (root: string) => string,
  environment: Record<string, string | undefined> = {},
): string[] {
  return withFontconfig(environment, (root) => {
    const configuration = path.join(root, "fonts.conf");
    fs.writeFileSync(configuration, write(root));
    vi.stubEnv("FONTCONFIG_FILE", configuration);
    return withPlatform("linux", () => systemFontDirectories());
  });
}

describe("system font directories", () => {
  it("includes the mount points a Flatpak Obsidian sees host fonts at", () => {
    const directories = withPlatform("linux", () => systemFontDirectories());

    // Last, not merely present: the host mounts duplicate the whole host font
    // tree, so ranking them ahead of the user's own directories would hand
    // `planFontResidency` the wrong roots first.
    expect(directories.slice(-3)).toEqual([
      "/run/host/fonts",
      "/run/host/local-fonts",
      "/run/host/user-fonts",
    ]);
  });

  it("scans the directories the fontconfig file named by the environment declares", () => {
    const directories = linuxDirectoriesFor(
      () => `<?xml version="1.0"?>
<fontconfig>
  <dir>/opt/declared-fonts</dir>
</fontconfig>`,
    );

    expect(directories).toContain("/opt/declared-fonts");
  });

  it("expands ~ and resolves a relative xdg-prefixed directory against XDG_DATA_HOME", () => {
    const directories = linuxDirectoriesFor(
      () => `<fontconfig>
  <dir>~/my-fonts</dir>
  <dir>~otheruser/fonts</dir>
  <dir prefix="xdg">my-xdg-fonts</dir>
</fontconfig>`,
      { XDG_DATA_HOME: "/data/home" },
    );

    expect(directories).toContain(path.join(os.homedir(), "my-fonts"));
    // "~otheruser" is another account's home, which this process cannot resolve.
    // Rewriting it under $HOME would invent a path belonging to nobody.
    expect(directories).not.toContain(path.join(os.homedir(), "otheruser/fonts"));
    // Not "/data/home/fonts": the standard list already produces that, so it
    // could not tell the xdg prefix from the unconditional XDG_DATA_HOME entry.
    expect(directories).toContain("/data/home/my-xdg-fonts");
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

  it("reads every root on the colon-separated fontconfig search path", () => {
    const directories = withFontconfig({}, (root) => {
      const first = path.join(root, "first-etc");
      const second = path.join(root, "second-etc");
      fs.mkdirSync(first, { recursive: true });
      fs.mkdirSync(second, { recursive: true });
      fs.writeFileSync(
        path.join(first, "fonts.conf"),
        "<fontconfig><dir>/opt/first-root</dir></fontconfig>",
      );
      fs.writeFileSync(
        path.join(second, "fonts.conf"),
        "<fontconfig><dir>/opt/second-root</dir></fontconfig>",
      );
      vi.stubEnv("FONTCONFIG_PATH", [first, second].join(path.delimiter));
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(directories).toContain("/opt/first-root");
    expect(directories).toContain("/opt/second-root");
  });

  it("expands ~ and a relative name in FONTCONFIG_FILE", () => {
    const tilde = withFontconfig({}, () =>
      withVirtualFontconfig(
        {
          [path.join(os.homedir(), "my-fonts.conf")]:
            "<fontconfig><dir>/opt/tilde-configured</dir></fontconfig>",
        },
        () => {
          vi.stubEnv("FONTCONFIG_FILE", "~/my-fonts.conf");
          return withPlatform("linux", () => systemFontDirectories());
        },
      ),
    );
    const relative = withFontconfig({}, (root) => {
      const configurationRoot = path.join(root, "etc-fonts");
      fs.mkdirSync(configurationRoot, { recursive: true });
      fs.writeFileSync(
        path.join(configurationRoot, "named.conf"),
        "<fontconfig><dir>/opt/relatively-configured</dir></fontconfig>",
      );
      vi.stubEnv("FONTCONFIG_PATH", configurationRoot);
      vi.stubEnv("FONTCONFIG_FILE", "named.conf");
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(tilde).toContain("/opt/tilde-configured");
    expect(relative).toContain("/opt/relatively-configured");
  });

  it("falls back to /etc/fonts when no fontconfig path is set", () => {
    const directories = withFontconfig({ FONTCONFIG_PATH: undefined }, () =>
      withVirtualFontconfig(
        { "/etc/fonts/fonts.conf": "<fontconfig><dir>/opt/etc-fonts</dir></fontconfig>" },
        () => withPlatform("linux", () => systemFontDirectories()),
      ),
    );

    expect(directories).toContain("/opt/etc-fonts");
  });

  it("falls back to ~/.config/fontconfig when no config home is set", () => {
    const directories = withFontconfig({ XDG_CONFIG_HOME: undefined }, () =>
      withVirtualFontconfig(
        {
          [path.join(os.homedir(), ".config/fontconfig/fonts.conf")]:
            "<fontconfig><dir>/opt/home-config-fonts</dir></fontconfig>",
        },
        () => withPlatform("linux", () => systemFontDirectories()),
      ),
    );

    expect(directories).toContain("/opt/home-config-fonts");
  });

  it("reads the legacy ~/.fonts.conf", () => {
    const directories = withFontconfig({}, () =>
      withVirtualFontconfig(
        {
          [path.join(os.homedir(), ".fonts.conf")]:
            "<fontconfig><dir>/opt/legacy-fonts</dir></fontconfig>",
        },
        () => withPlatform("linux", () => systemFontDirectories()),
      ),
    );

    expect(directories).toContain("/opt/legacy-fonts");
  });

  it("ranks the user's fontconfig directories after the user's font directories and before the system's", () => {
    const directories = withFontconfig(
      { XDG_DATA_HOME: "/data/home" },
      (root) => {
        const userConfig = path.join(root, "config");
        fs.mkdirSync(path.join(userConfig, "fontconfig", "conf.d"), { recursive: true });
        fs.writeFileSync(
          path.join(userConfig, "fontconfig", "fonts.conf"),
          "<fontconfig><dir>/opt/user-fonts</dir></fontconfig>",
        );
        fs.writeFileSync(
          path.join(userConfig, "fontconfig", "conf.d", "50-mine.conf"),
          "<fontconfig><dir>/opt/user-fragment-fonts</dir></fontconfig>",
        );
        vi.stubEnv("XDG_CONFIG_HOME", userConfig);
        // The system block must be non-empty too, or "user before system" is
        // vacuous: an empty system block sits at no index at all.
        const systemConfig = path.join(root, "etc-fonts");
        fs.mkdirSync(systemConfig, { recursive: true });
        fs.writeFileSync(
          path.join(systemConfig, "fonts.conf"),
          "<fontconfig><dir>/opt/system-ranked</dir></fontconfig>",
        );
        vi.stubEnv("FONTCONFIG_PATH", systemConfig);
        return withPlatform("linux", () => systemFontDirectories());
      },
    );

    expect(directories).toContain("/opt/user-fonts");
    expect(directories).toContain("/opt/user-fragment-fonts");
    expect(directories).toContain("/opt/system-ranked");
    expect(directories.indexOf("/opt/user-fonts")).toBeGreaterThan(
      directories.indexOf("/data/home/fonts"),
    );
    expect(directories.indexOf("/opt/user-fragment-fonts")).toBeLessThan(
      directories.indexOf("/opt/system-ranked"),
    );
    expect(directories.indexOf("/opt/system-ranked")).toBeLessThan(
      directories.indexOf("/usr/share/fonts"),
    );
  });

  it("keeps the standard paths when the fontconfig configuration is missing or malformed", () => {
    const malformed = withFontconfig({}, (root) => {
      const configuration = path.join(root, "broken.conf");
      fs.writeFileSync(configuration, "<fontconfig><dir>/opt/truncated");
      vi.stubEnv("FONTCONFIG_FILE", configuration);
      return withPlatform("linux", () => systemFontDirectories());
    });
    const absent = withFontconfig({}, (root) =>
      withPlatform("linux", () => {
        vi.stubEnv("FONTCONFIG_FILE", path.join(root, "nothing-here.conf"));
        return systemFontDirectories();
      }),
    );

    expect(malformed).not.toContain("/opt/truncated");
    expect(malformed).toContain("/usr/share/fonts");
    expect(absent).toContain("/usr/share/fonts");
    expect(absent).toContain(path.join(os.homedir(), ".fonts"));
  });

  it("decodes predefined entities and CDATA in a directory value", () => {
    const directories = linuxDirectoriesFor(
      () => `<fontconfig>
  <dir>/opt/rock&amp;roll</dir>
  <dir><![CDATA[/opt/cdata fonts]]></dir>
</fontconfig>`,
    );

    expect(directories).toContain("/opt/rock&roll");
    expect(directories).not.toContain("/opt/rock&amp;roll");
    expect(directories).toContain("/opt/cdata fonts");
  });

  it("returns absolute directories without duplicates", () => {
    const directories = linuxDirectoriesFor(
      () => `<fontconfig>
  <dir>/usr/share/fonts/</dir>
  <dir>//usr/share/fonts</dir>
  <dir>/usr/local/share/./fonts</dir>
  <dir>/opt/twice</dir>
  <dir>/opt/twice</dir>
  <dir>relative/fonts</dir>
</fontconfig>`,
    );

    expect(directories).toEqual([...new Set(directories)]);
    // Dropped, not resolved. Only an include resolves a relative name; a
    // relative <dir> honored against *any* base — the declaring file, the cwd,
    // $HOME — is still absolute, so `every(isAbsolute)` below cannot notice it.
    // Asserting on the value rather than on one resolution of it catches every
    // base a wrong implementation might pick.
    expect(directories.some((directory) => directory.endsWith("relative/fonts"))).toBe(false);
    expect(directories.every((directory) => path.isAbsolute(directory))).toBe(true);
    expect(directories).toContain("/opt/twice");
    // Spellings of a path already in the standard list must not reappear:
    // a second entry for one directory also perturbs the residency ranking.
    expect(directories.filter((directory) => directory === "/usr/share/fonts")).toHaveLength(1);
    expect(directories).not.toContain("/usr/share/fonts/");
    expect(directories).not.toContain("//usr/share/fonts");
    expect(directories).not.toContain("/usr/local/share/./fonts");
  });

  it("follows an include to another configuration file", () => {
    const directories = linuxDirectoriesFor((root) => {
      const included = path.join(root, "my-fonts.conf");
      fs.writeFileSync(included, "<fontconfig><dir>/opt/included-fonts</dir></fontconfig>");
      return `<fontconfig><include>${included}</include></fontconfig>`;
    });

    expect(directories).toContain("/opt/included-fonts");
  });

  it("reads each file once on an include cycle", () => {
    const first = "/opt/conf/first.conf";
    const second = "/opt/conf/second.conf";
    // Each file includes the other, a shape real dotfile setups reach by
    // accident. Asserting the read counts, not just that the call returned:
    // unbounded recursion also "returns", by overflowing into the catch.
    const { directories, reads } = withFontconfig({}, () =>
      withVirtualFontconfig(
        {
          [first]: `<fontconfig><dir>/opt/cycle-first</dir><include>${second}</include></fontconfig>`,
          [second]: `<fontconfig><dir>/opt/cycle-second</dir><include>${first}</include></fontconfig>`,
        },
        (reads) => {
          vi.stubEnv("FONTCONFIG_FILE", first);
          return { directories: withPlatform("linux", () => systemFontDirectories()), reads };
        },
      ),
    );

    expect(directories).toContain("/opt/cycle-first");
    expect(directories).toContain("/opt/cycle-second");
    expect(reads.filter((file) => file === first)).toHaveLength(1);
    expect(reads.filter((file) => file === second)).toHaveLength(1);
  });

  it("resolves an xdg-prefixed include against the config home, not the data home", () => {
    const directories = linuxDirectoriesFor((root) => {
      // The same relative name exists under both bases, so only the base the
      // reader picks decides which directory comes back.
      const configHome = path.join(root, "config-home");
      const dataHome = path.join(root, "data-home");
      for (const [base, declared] of [
        [configHome, "/opt/xdg-config-include"],
        [dataHome, "/opt/xdg-data-include"],
      ] as const) {
        fs.mkdirSync(path.join(base, "extra"), { recursive: true });
        fs.writeFileSync(
          path.join(base, "extra", "included.conf"),
          `<fontconfig><dir>${declared}</dir></fontconfig>`,
        );
      }
      vi.stubEnv("XDG_CONFIG_HOME", configHome);
      vi.stubEnv("XDG_DATA_HOME", dataHome);
      return '<fontconfig><include prefix="xdg">extra/included.conf</include></fontconfig>';
    });

    expect(directories).toContain("/opt/xdg-config-include");
    expect(directories).not.toContain("/opt/xdg-data-include");
  });

  it("resolves a relative include against the including file's directory", () => {
    const directories = linuxDirectoriesFor((root) => {
      fs.mkdirSync(path.join(root, "conf.d"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "conf.d", "10-nearby.conf"),
        "<fontconfig><dir>/opt/relative-included</dir></fontconfig>",
      );
      fs.writeFileSync(
        path.join(root, "sibling.conf"),
        "<fontconfig><dir>/opt/relative-sibling</dir></fontconfig>",
      );
      return `<fontconfig>
  <include>conf.d</include>
  <include prefix="relative">sibling.conf</include>
</fontconfig>`;
    });

    expect(directories).toContain("/opt/relative-included");
    expect(directories).toContain("/opt/relative-sibling");
  });

  it("reads a file shared by two fragments once across the whole scan", () => {
    const shared = "/opt/conf/shared.conf";
    const { reads } = withFontconfig({ FONTCONFIG_PATH: "/opt/conf" }, () =>
      withVirtualFontconfig(
        {
          "/opt/conf/fonts.conf": `<fontconfig><include>${shared}</include></fontconfig>`,
          "/opt/conf/conf.d/10-a.conf": `<fontconfig><include>${shared}</include></fontconfig>`,
          "/opt/conf/conf.d/20-b.conf": `<fontconfig><include>${shared}</include></fontconfig>`,
          [shared]: "<fontconfig><dir>/opt/shared-fonts</dir></fontconfig>",
        },
        (reads) => {
          withPlatform("linux", () => systemFontDirectories());
          return { reads };
        },
      ),
    );

    expect(reads.filter((file) => file === shared)).toHaveLength(1);
  });

  it("reads a file once even when both configuration halves include it", () => {
    const shared = "/opt/conf/shared.conf";
    const { directories, reads } = withFontconfig(
      { FONTCONFIG_PATH: "/opt/etc-fonts", XDG_CONFIG_HOME: "/opt/config-home" },
      () =>
        withVirtualFontconfig(
          {
            "/opt/etc-fonts/fonts.conf": `<fontconfig><include>${shared}</include></fontconfig>`,
            "/opt/config-home/fontconfig/fonts.conf": `<fontconfig><include>${shared}</include></fontconfig>`,
            [shared]: "<fontconfig><dir>/opt/shared-across-halves</dir></fontconfig>",
          },
          (reads) => ({
            directories: withPlatform("linux", () => systemFontDirectories()),
            reads,
          }),
        ),
    );

    // Both halves are read — the point is that the file they share is not.
    expect(directories).toContain("/opt/shared-across-halves");
    expect(reads).toContain("/opt/etc-fonts/fonts.conf");
    expect(reads).toContain("/opt/config-home/fontconfig/fonts.conf");
    expect(reads.filter((file) => file === shared)).toHaveLength(1);
  });

  it("stops following a straight include chain at the depth bound", () => {
    // No cycle here, so the visited set never fires: only the depth bound can
    // stop this. The chain is one longer than the bound allows.
    const chain = (index: number) => `/opt/chain/${index}.conf`;
    const files: Record<string, string> = {};
    for (let index = 0; index <= MAX_FONTCONFIG_INCLUDE_DEPTH + 1; index += 1) {
      files[chain(index)] =
        `<fontconfig><dir>/opt/depth-${index}</dir><include>${chain(index + 1)}</include></fontconfig>`;
    }

    const directories = withFontconfig({}, () =>
      withVirtualFontconfig(files, () => {
        vi.stubEnv("FONTCONFIG_FILE", chain(0));
        return withPlatform("linux", () => systemFontDirectories());
      }),
    );

    expect(directories).toContain("/opt/depth-0");
    expect(directories).toContain(`/opt/depth-${MAX_FONTCONFIG_INCLUDE_DEPTH}`);
    expect(directories).not.toContain(`/opt/depth-${MAX_FONTCONFIG_INCLUDE_DEPTH + 1}`);
  });

  it("expands a ~ include and reads the file it names", () => {
    // Through the virtual filesystem, because the only way to prove the
    // expansion is to have a file at the expanded path — and a test must not
    // write into the real home directory to get one.
    const directories = withFontconfig({}, () =>
      withVirtualFontconfig(
        {
          "/opt/conf/fonts.conf":
            "<fontconfig><include>~/my-includes/extra.conf</include></fontconfig>",
          [path.join(os.homedir(), "my-includes/extra.conf")]:
            "<fontconfig><dir>/opt/tilde-included</dir></fontconfig>",
        },
        () => {
          vi.stubEnv("FONTCONFIG_FILE", "/opt/conf/fonts.conf");
          return withPlatform("linux", () => systemFontDirectories());
        },
      ),
    );

    expect(directories).toContain("/opt/tilde-included");
  });

  it("survives a missing include, and follows one naming a directory", () => {
    const directories = linuxDirectoriesFor((root) => {
      const includedDirectory = path.join(root, "conf-parts");
      fs.mkdirSync(includedDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(includedDirectory, "10-part.conf"),
        "<fontconfig><dir>/opt/directory-included</dir></fontconfig>",
      );
      return `<fontconfig>
  <include ignore_missing="yes">${path.join(root, "absent.conf")}</include>
  <include ignore_missing="yes">${includedDirectory}</include>
  <include>~/.fonts.conf.d/nothing.conf</include>
  <dir>/opt/still-read</dir>
</fontconfig>`;
    });

    expect(directories).toContain("/opt/directory-included");
    // A missing include, expanded or not, must not cost the rest of the file.
    expect(directories).toContain("/opt/still-read");
  });

  it("ignores a fontconfig file past the byte bound", () => {
    const directories = withFontconfig({}, (root) => {
      const configuration = path.join(root, "huge.conf");
      const declaration = "<fontconfig><dir>/opt/oversized-declaration</dir>";
      fs.writeFileSync(
        configuration,
        declaration +
          "<!--" +
          "p".repeat(MAX_FONTCONFIG_FILE_BYTES) +
          "--></fontconfig>",
      );
      vi.stubEnv("FONTCONFIG_FILE", configuration);
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(directories).not.toContain("/opt/oversized-declaration");
    expect(directories).toContain("/usr/share/fonts");
  });

  it("applies the byte bound to an included file, not only the named one", () => {
    const directories = linuxDirectoriesFor((root) => {
      const oversized = path.join(root, "oversized-include.conf");
      fs.writeFileSync(
        oversized,
        "<fontconfig><dir>/opt/oversized-included</dir><!--" +
          "p".repeat(MAX_FONTCONFIG_FILE_BYTES) +
          "--></fontconfig>",
      );
      return `<fontconfig>
  <include>${oversized}</include>
  <dir>/opt/small-declaring-file</dir>
</fontconfig>`;
    });

    // The including file is well under the bound, so only a bound that reaches
    // the included file can keep this out.
    expect(directories).not.toContain("/opt/oversized-included");
    expect(directories).toContain("/opt/small-declaring-file");
  });

  it("reads at most the bounded number of conf.d fragments", () => {
    const directories = withFontconfig({}, (root) => {
      const fontconfigPath = path.join(root, "fonts");
      const confD = path.join(fontconfigPath, "conf.d");
      fs.mkdirSync(confD, { recursive: true });
      for (let index = 0; index <= MAX_FONTCONFIG_FRAGMENTS; index += 1) {
        fs.writeFileSync(
          // Zero-padded so the sort order is the numeric one and the last
          // fragment written is the one past the bound.
          path.join(confD, `${String(index).padStart(5, "0")}.conf`),
          `<fontconfig><dir>/opt/fragment-${index}</dir></fontconfig>`,
        );
      }
      vi.stubEnv("FONTCONFIG_PATH", fontconfigPath);
      return withPlatform("linux", () => systemFontDirectories());
    });

    expect(directories).toContain("/opt/fragment-0");
    expect(directories).toContain(`/opt/fragment-${MAX_FONTCONFIG_FRAGMENTS - 1}`);
    expect(directories).not.toContain(`/opt/fragment-${MAX_FONTCONFIG_FRAGMENTS}`);
  });

  it("leaves macOS and Windows alone and never consults fontconfig there", () => {
    const { darwin, win32 } = withFontconfig(
      { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", WINDIR: undefined },
      (root) => {
      const configuration = path.join(root, "fonts.conf");
      fs.writeFileSync(configuration, "<fontconfig><dir>/opt/never-here</dir></fontconfig>");
      vi.stubEnv("FONTCONFIG_FILE", configuration);
      return {
        darwin: withPlatform("darwin", () => systemFontDirectories()),
        win32: withPlatform("win32", () => systemFontDirectories()),
      };
      },
    );

    expect(darwin).toEqual([
      path.join(os.homedir(), "Library/Fonts"),
      "/Library/Fonts",
      "/Network/Library/Fonts",
      "/System/Library/Fonts",
    ]);
    // Literal paths, not the implementation's own expression: WINDIR is unset
    // above, so the C:\Windows fallback is what must appear.
    expect(win32).toEqual([
      "C:\\Users\\me\\AppData\\Local/Microsoft/Windows/Fonts",
      "C:\\Windows/Fonts",
    ]);
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
