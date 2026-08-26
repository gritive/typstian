// Vault paths are always `/`-separated, so this module stays off `node:path`:
// its Windows separator would leak into the vault API.

const MAX_CANDIDATES = 100;

/**
 * Vault-relative target for a compiled PDF: the source's folder and basename
 * with a `.pdf` extension. A name already taken moves to the next numbered
 * sibling — an export must never clobber a file the user is keeping — and
 * returns null rather than probing candidates without bound.
 */
export function resolvePdfExportPath(
  sourcePath: string,
  exists: (vaultPath: string) => boolean
): string | null {
  const dot = sourcePath.lastIndexOf(".");
  const stem = dot > sourcePath.lastIndexOf("/") ? sourcePath.slice(0, dot) : sourcePath;
  for (let suffix = 0; suffix < MAX_CANDIDATES; suffix += 1) {
    const candidate = suffix === 0 ? `${stem}.pdf` : `${stem}-${suffix}.pdf`;
    if (!exists(candidate)) return candidate;
  }
  return null;
}
