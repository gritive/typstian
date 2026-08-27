// Off `node:path`, for the reason `src/pdf-export.ts` states: a vault path is
// always `/`-separated, and `path.sep` would leak a backslash into the vault API
// on Windows.

const BASE_NAME = "Untitled";
const MAX_CANDIDATES = 100;

export interface NewTypstFile {
  path: string;
  content: string;
}

/**
 * Vault-relative target for a newly created Typst file, following Obsidian's
 * own `Untitled`, `Untitled 1`, … naming. A name already taken moves to the
 * next free sibling — creating a note must never clobber one the user is
 * keeping — and returns null rather than probing candidates without bound.
 *
 * The document starts with a heading rather than empty because an empty Typst
 * source compiles to a document with no pages, and a blank preview is exactly
 * what a first-time user reads as a broken plugin.
 */
export function resolveNewTypstFile(
  folderPath: string,
  exists: (vaultPath: string) => boolean
): NewTypstFile | null {
  const folder = folderPath.replace(/^\.$/, "").replace(/\/+$/, "");
  const prefix = folder.length === 0 ? "" : `${folder}/`;
  for (let suffix = 0; suffix < MAX_CANDIDATES; suffix += 1) {
    const name = suffix === 0 ? BASE_NAME : `${BASE_NAME} ${suffix}`;
    const candidate = `${prefix}${name}.typ`;
    if (!exists(candidate)) return { path: candidate, content: `= ${name}\n` };
  }
  return null;
}

/**
 * Whether a vault folder sits at or below another. Vault paths are always
 * `/`-separated and already normalized by Obsidian, so this is a prefix test,
 * not path arithmetic.
 */
export function isWithinVaultFolder(root: string, folderPath: string): boolean {
  if (root === "") return true;
  return folderPath === root || folderPath.startsWith(`${root}/`);
}
