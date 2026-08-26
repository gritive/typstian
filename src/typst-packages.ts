import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rootedReadFile, rootedReadFileAsync } from "./wasm-vault-reader";

// One rooted reader is kept per package directory that a compile touches. The
// cap bounds how many host roots a single document can pin open; no realistic
// document imports more packages than this.
export const MAX_LOCAL_PACKAGE_ROOTS = 128;

// Typst's own grammar for the parts of `@namespace/name:version`. Validating the
// triple before it ever becomes a path keeps a crafted spec from naming a
// directory outside the package store, and the rooted reader then keeps the file
// part inside the package directory.
// Typst validates the spec with its own identifier grammar — letters, digits,
// `_`, `-` — before the compiler asks for a file, so re-deriving that grammar
// here would only misreport an installed package as missing. What is left for
// this to check is that a component cannot become a path.
const UNSAFE_SPEC_PART = /[/\\\u0000]/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Reads files of packages the user already downloaded. Typstian never fetches
// one, so this is the whole of package resolution.
export interface LocalPackages {
  readSync(key: string): Uint8Array | undefined;
  read(key: string): Promise<Uint8Array | undefined>;
}

interface PackageKey {
  // The `{namespace}/{name}/{version}` directory of the package.
  spec: readonly string[];
  // The package-relative path of the file within it.
  file: string;
}

function parsePackageKey(key: string): PackageKey | undefined {
  const parts = key.split("/");
  if (parts.length < 4) return undefined;
  const [namespace, name, version] = parts;
  const specParts = [namespace, name, version];
  if (
    specParts.some((part) => part === undefined || part === "" || part === "." || part === ".."
      || UNSAFE_SPEC_PART.test(part))
    || !VERSION.test(version ?? "")
  ) {
    return undefined;
  }
  // The rooted reader rejects the rest — empty, `.`, `..`, backslash, NUL — so
  // this only has to hand it the file part unchanged.
  return { spec: [namespace!, name!, version!], file: parts.slice(3).join("/") };
}

function packageDirectory(root: string, spec: readonly string[]): string | undefined {
  const directory = path.join(root, ...spec);
  try {
    return fs.statSync(directory).isDirectory() ? directory : undefined;
  } catch {
    return undefined;
  }
}

export function createLocalPackageReader(directories: readonly string[]): LocalPackages {
  const roots = [...new Set(directories)];
  const syncReaders = new Map<string, ReturnType<typeof rootedReadFile>>();
  const asyncReaders = new Map<string, ReturnType<typeof rootedReadFileAsync>>();

  // Each installed package directory becomes its own read root, so a file can
  // only ever resolve inside the one package that asked for it.
  const rootFor = (spec: readonly string[]): string | undefined => {
    for (const root of roots) {
      const directory = packageDirectory(root, spec);
      if (directory !== undefined) return directory;
    }
    return undefined;
  };

  // A rooted reader is built on first use and only for the accessor that needs
  // it, so a directory that vanishes never leaves an unobserved rejection
  // behind.
  function readerFor<T>(
    cache: Map<string, T>,
    spec: readonly string[],
    create: (directory: string) => T,
  ): T | undefined {
    const directory = rootFor(spec);
    if (directory === undefined) return undefined;
    const cached = cache.get(directory);
    if (cached !== undefined) return cached;
    if (cache.size >= MAX_LOCAL_PACKAGE_ROOTS) return undefined;
    try {
      const reader = create(directory);
      cache.set(directory, reader);
      return reader;
    } catch {
      // A package directory that vanished between the stat and the open is
      // simply not installed.
      return undefined;
    }
  }

  return {
    readSync(key) {
      const parsed = parsePackageKey(key);
      if (parsed === undefined) return undefined;
      return readerFor(syncReaders, parsed.spec, rootedReadFile)?.(parsed.file);
    },
    async read(key) {
      const parsed = parsePackageKey(key);
      if (parsed === undefined) return undefined;
      const reader = readerFor(asyncReaders, parsed.spec, rootedReadFileAsync);
      if (reader === undefined) return undefined;
      try {
        return await reader(parsed.file);
      } catch {
        // A package directory removed mid-compile reads as not installed.
        return undefined;
      }
    },
  };
}

// The package stores Typst itself uses: the data directory holds packages the
// user installed by hand, the cache directory holds the ones the Typst CLI
// downloaded. Both are read-only inputs here; nothing is ever written.
export function typstPackageDirectories(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  if (platform === "darwin") {
    return [
      path.join(home, "Library/Application Support/typst/packages"),
      path.join(home, "Library/Caches/typst/packages"),
    ];
  }
  if (platform === "win32") {
    const data = process.env.APPDATA || path.join(home, "AppData/Roaming");
    const cache = process.env.LOCALAPPDATA || path.join(home, "AppData/Local");
    return [
      path.join(data, "typst/packages"),
      path.join(cache, "typst/packages"),
    ];
  }
  const data = process.env.XDG_DATA_HOME || path.join(home, ".local/share");
  const cache = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  return [
    path.join(data, "typst/packages"),
    path.join(cache, "typst/packages"),
  ];
}
