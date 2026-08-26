import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  promises as fs,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_VAULT_INPUT_FILE_BYTES = 50 * 1024 * 1024;

function isSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function candidatePath(root: string, path: string): string | undefined {
  if (!isSafeRelativePath(path)) return undefined;
  const candidate = resolve(root, ...path.split("/"));
  return isWithin(root, candidate) ? candidate : undefined;
}

const OPEN_READ_FLAGS = constants.O_RDONLY
  | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

function isSameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}


function isReadableRegularFile(stats: Stats): boolean {
  return stats.isFile() && stats.size <= MAX_VAULT_INPUT_FILE_BYTES;
}

function isUnchangedRootedFile(
  root: string,
  openedPath: string,
  currentPath: string,
  opened: Stats,
  current: Stats,
): boolean {
  return currentPath === openedPath
    && isWithin(root, currentPath)
    && isSameFile(opened, current);
}

function isReadableByteLength(byteLength: number): boolean {
  return byteLength <= MAX_VAULT_INPUT_FILE_BYTES;
}

export function rootedReadFileAsync(
  rootPath: string,
): (path: string) => Promise<Uint8Array | undefined> {
  const root = fs.realpath(rootPath);
  return async (path) => {
    const resolvedRoot = await root;
    const candidate = candidatePath(resolvedRoot, path);
    if (candidate === undefined) return undefined;

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const realCandidate = await fs.realpath(candidate);
      if (!isWithin(resolvedRoot, realCandidate)) return undefined;
      handle = await fs.open(realCandidate, OPEN_READ_FLAGS);
      const opened = await handle.stat();
      if (!isReadableRegularFile(opened)) return undefined;

      const currentPath = await fs.realpath(candidate);
      const current = await fs.stat(currentPath);
      if (!isUnchangedRootedFile(
        resolvedRoot,
        realCandidate,
        currentPath,
        opened,
        current,
      )) return undefined;

      const bytes = await handle.readFile();
      if (!isReadableByteLength(bytes.byteLength)) return undefined;
      return Uint8Array.from(bytes);
    } catch {
      return undefined;
    } finally {
      await handle?.close();
    }
  };
}

export function rootedReadFile(rootPath: string): (path: string) => Uint8Array | undefined {
  const root = realpathSync(rootPath);
  return (path) => {
    const candidate = candidatePath(root, path);
    if (candidate === undefined) return undefined;

    let descriptor: number | undefined;
    try {
      const realCandidate = realpathSync(candidate);
      if (!isWithin(root, realCandidate)) return undefined;
      descriptor = openSync(realCandidate, OPEN_READ_FLAGS);
      const opened = fstatSync(descriptor);
      if (!isReadableRegularFile(opened)) return undefined;

      const currentPath = realpathSync(candidate);
      const current = statSync(currentPath);
      if (!isUnchangedRootedFile(
        root,
        realCandidate,
        currentPath,
        opened,
        current,
      )) return undefined;

      const bytes = readFileSync(descriptor);
      if (!isReadableByteLength(bytes.byteLength)) return undefined;
      return Uint8Array.from(bytes);
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}
