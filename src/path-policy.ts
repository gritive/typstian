import fs from "node:fs";
import path from "node:path";

function relativePathWithin(root: string, candidate: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative.length === 0
    || path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  return relative;
}

export function resolveCompilationRoot(vaultRoot: string, rootPath: string): string {
  const canonicalVault = fs.realpathSync.native(vaultRoot);
  const canonicalRoot = fs.realpathSync.native(path.resolve(canonicalVault, rootPath));
  const relative = path.relative(canonicalVault, canonicalRoot);
  if (
    path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || !fs.statSync(canonicalRoot).isDirectory()
  ) {
    throw new Error("Compilation root must resolve inside the vault.");
  }
  return canonicalRoot;
}

export function resolveDiagnosticVaultPath(
  vaultRoot: string,
  compilationRoot: string,
  diagnosticPath: string
): string | null {
  const candidate = path.resolve(
    path.isAbsolute(diagnosticPath) ? diagnosticPath : path.join(compilationRoot, diagnosticPath)
  );
  const relative = relativePathWithin(vaultRoot, candidate);
  if (relative === null || path.extname(relative).toLowerCase() !== ".typ") {
    return null;
  }
  return relative.split(path.sep).join("/");
}

export function resolveCompilerEntryPath(
  vaultRoot: string,
  compilationRoot: string,
  vaultPath: string
): string | null {
  const source = path.resolve(vaultRoot, vaultPath);
  const vaultRelative = relativePathWithin(vaultRoot, source);
  if (vaultRelative === null || path.extname(vaultRelative).toLowerCase() !== ".typ") {
    return null;
  }
  const rootRelative = relativePathWithin(compilationRoot, source);
  return rootRelative?.split(path.sep).join("/") ?? null;
}
