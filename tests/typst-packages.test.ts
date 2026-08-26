import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalPackageReader,
  typstPackageDirectories,
} from "../src/typst-packages";

const temporaries: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-package-"));
  temporaries.push(directory);
  return fs.realpathSync(directory);
}

function installPackage(root: string, spec: string, files: Record<string, string>): string {
  const directory = path.join(root, ...spec.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(directory, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaries.length > 0) {
    fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
  }
});

describe("local Typst package reading", () => {
  it("reads a file of an installed package", async () => {
    const root = temporaryDirectory();
    installPackage(root, "preview/greet/0.1.0", {
      "typst.toml": "[package]",
      "src/lib.typ": "#let greet = 1",
    });
    const packages = createLocalPackageReader([root]);

    expect(packages.readSync("preview/greet/0.1.0/typst.toml")).toEqual(
      new Uint8Array(Buffer.from("[package]")),
    );
    await expect(packages.read("preview/greet/0.1.0/src/lib.typ")).resolves.toEqual(
      new Uint8Array(Buffer.from("#let greet = 1")),
    );
  });

  it("prefers the first directory that has the package", () => {
    const first = temporaryDirectory();
    const second = temporaryDirectory();
    installPackage(first, "preview/greet/0.1.0", { "typst.toml": "first" });
    installPackage(second, "preview/greet/0.1.0", { "typst.toml": "second" });
    installPackage(second, "preview/greet/0.2.0", { "typst.toml": "only in second" });
    const packages = createLocalPackageReader([first, second]);

    expect(packages.readSync("preview/greet/0.1.0/typst.toml")).toEqual(
      new Uint8Array(Buffer.from("first")),
    );
    expect(packages.readSync("preview/greet/0.2.0/typst.toml")).toEqual(
      new Uint8Array(Buffer.from("only in second")),
    );
  });

  it("reports nothing for a package that is not installed", async () => {
    const root = temporaryDirectory();
    const packages = createLocalPackageReader([root, path.join(root, "missing")]);

    expect(packages.readSync("preview/greet/0.1.0/typst.toml")).toBeUndefined();
    await expect(packages.read("preview/greet/0.1.0/typst.toml")).resolves.toBeUndefined();
  });

  it("refuses keys that are not a package spec followed by a file", () => {
    const root = temporaryDirectory();
    installPackage(root, "preview/greet/0.1.0", { "typst.toml": "[package]" });
    fs.writeFileSync(path.join(root, "secret.txt"), "secret");
    const packages = createLocalPackageReader([root]);

    for (const key of [
      "preview/greet/0.1.0/../../../secret.txt",
      "preview/greet/0.1.0/..",
      "preview/greet/0.1.0",
      "preview/greet/0.1.0/",
      "../greet/0.1.0/typst.toml",
      "preview/../0.1.0/typst.toml",
      "preview/greet/0.1/typst.toml",
      "preview/greet/0.1.0-beta/typst.toml",
      "preview/greet/0.1.0/nested\\typst.toml",
      "preview/greet/0.1.0/typst.toml\0",
    ]) {
      expect(packages.readSync(key), key).toBeUndefined();
    }
  });

  it("refuses a package file that symlinks out of its package directory", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const directory = installPackage(root, "preview/greet/0.1.0", { "typst.toml": "[package]" });
    fs.writeFileSync(path.join(outside, "secret.typ"), "secret");
    fs.symlinkSync(path.join(outside, "secret.typ"), path.join(directory, "escape.typ"));
    const packages = createLocalPackageReader([root]);

    expect(packages.readSync("preview/greet/0.1.0/escape.typ")).toBeUndefined();
  });
});

describe("Typst package directories", () => {
  it("lists the data directory before the cache directory on Linux", () => {
    vi.stubEnv("XDG_DATA_HOME", "/data");
    vi.stubEnv("XDG_CACHE_HOME", "/cache");

    const directories = typstPackageDirectories("linux", "/home/user");

    expect(directories).toEqual([
      path.join("/data", "typst/packages"),
      path.join("/cache", "typst/packages"),
    ]);
  });

  it("falls back to the home-relative Linux defaults", () => {
    vi.stubEnv("XDG_DATA_HOME", "");
    vi.stubEnv("XDG_CACHE_HOME", "");

    expect(typstPackageDirectories("linux", "/home/user")).toEqual([
      path.join("/home/user", ".local/share/typst/packages"),
      path.join("/home/user", ".cache/typst/packages"),
    ]);
  });

  it("uses the platform directories Typst itself writes to", () => {
    expect(typstPackageDirectories("darwin", "/Users/user")).toEqual([
      path.join("/Users/user", "Library/Application Support/typst/packages"),
      path.join("/Users/user", "Library/Caches/typst/packages"),
    ]);

    vi.stubEnv("APPDATA", "C:\\Users\\user\\AppData\\Roaming");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\user\\AppData\\Local");
    expect(typstPackageDirectories("win32", "C:\\Users\\user")).toEqual([
      path.join("C:\\Users\\user\\AppData\\Roaming", "typst/packages"),
      path.join("C:\\Users\\user\\AppData\\Local", "typst/packages"),
    ]);
  });
});

describe("package names Typst itself accepts", () => {
  it("resolves a name with an underscore or a capital, which Typst's identifier grammar allows", () => {
    // Typst validates the spec before the compiler ever asks for a file, so a
    // stricter grammar here would report an installed package as missing.
    const root = temporaryDirectory();
    installPackage(root, "preview/My_Pkg/1.0.0", { "lib.typ": "ok" });
    const packages = createLocalPackageReader([root]);

    expect(packages.readSync("preview/My_Pkg/1.0.0/lib.typ")).toEqual(
      new TextEncoder().encode("ok"),
    );
  });

  it("still refuses a spec component that could walk out of the packages root", () => {
    const root = temporaryDirectory();
    installPackage(root, "preview/greet/0.1.0", { "lib.typ": "ok" });
    const packages = createLocalPackageReader([root]);

    expect(packages.readSync("preview/../../etc/0.1.0/lib.typ")).toBeUndefined();
    expect(packages.readSync("preview/./0.1.0/lib.typ")).toBeUndefined();
    expect(packages.readSync("preview/a\\b/0.1.0/lib.typ")).toBeUndefined();
  });
});
