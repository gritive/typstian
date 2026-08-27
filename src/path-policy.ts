import fs from "node:fs";
import path from "node:path";

/**
 * Whether a candidate leaves a root. `..hidden` is a legitimate name, so the
 * test is on path segments rather than on the string starting with two dots.
 */
export function escapesRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  );
}

function relativePathWithin(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.length === 0 || escapesRoot(resolvedRoot, resolved)) {
    return null;
  }
  return relative;
}

export type CompilationRootProblem =
  | "outside-vault"
  | "not-a-folder"
  | "missing"
  | "broken-link"
  | "unreadable";

export type CompilationRootCheck =
  | { readonly ok: true; readonly path: string }
  // A refusal the filesystem raised is carried along, because "must resolve
  // inside the vault" would misname a folder that merely does not exist yet.
  | { readonly ok: false; readonly reason: CompilationRootProblem; readonly error?: Error };

// Only reached once canonicalization has failed, which is why it may spend two
// more filesystem calls: realpath cannot say whether nothing is there or a link
// is there pointing at nothing, and the two need different advice.
function classifyUnresolvable(
  vaultRoot: string,
  candidate: string,
  error: NodeJS.ErrnoException
): CompilationRootCheck {
  let link: fs.Stats;
  try {
    link = fs.lstatSync(candidate);
  } catch {
    return { ok: false, reason: error.code === "ENOENT" ? "missing" : "unreadable", error };
  }
  if (!link.isSymbolicLink()) {
    // Something is here that realpath still refused: permissions, or a loop
    // further along a path component.
    return { ok: false, reason: "unreadable", error };
  }
  // A link out of the vault is an escape whatever state its target is in —
  // creating that target would only make the escape reachable. One level is
  // enough: a longer chain leaves the vault through a link this same check sees
  // when the user points the setting at it.
  const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
  const canonicalTarget = path.join(canonicalOrSelf(path.dirname(target)), path.basename(target));
  if (escapesRoot(canonicalOrSelf(vaultRoot), canonicalTarget)) {
    return { ok: false, reason: "outside-vault", error };
  }
  // The link is here and points inside the vault, so realpath's own code says
  // whether the chain ends nowhere or the filesystem refused it (a loop, say).
  return {
    ok: false,
    reason: error.code === "ENOENT" ? "broken-link" : "unreadable",
    error
  };
}

function canonicalOrSelf(directory: string): string {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return directory;
  }
}

/**
 * The one policy that decides whether a compilation root setting is usable.
 * It reports *why* an unusable value fails so the settings tab can say so while
 * the user is still looking at the field, instead of leaving it to a notice on
 * some later action.
 */
/**
 * What to tell the user about a root that will not resolve. The settings row
 * and the commands that refuse to run both say this, so the two cannot drift
 * into telling the same user different stories about one value.
 */
export const COMPILATION_ROOT_PROBLEM: Record<CompilationRootProblem, string> = {
  "missing": "No folder at this path yet. Create it, or type a path that exists.",
  "not-a-folder": "This path is a file, not a folder. Type the path of a folder instead.",
  "broken-link": "This link points at nothing. Fix the link, or type another path.",
  "unreadable": "This path cannot be read. Check its permissions, or type another path.",
  "outside-vault": "This path leaves the vault. Type a path inside the vault instead."
};

export function checkCompilationRoot(vaultRoot: string, rootPath: string): CompilationRootCheck {
  // The escape is decided lexically first, so `../notes` is named for leaving
  // the vault rather than for not existing yet — creating it would not help.
  const resolvedVault = path.resolve(vaultRoot);
  const resolvedRoot = path.resolve(resolvedVault, rootPath);
  if (escapesRoot(resolvedVault, resolvedRoot)) {
    return { ok: false, reason: "outside-vault" };
  }

  let canonicalVault: string;
  let canonicalRoot: string;
  let stats: fs.Stats;
  try {
    canonicalVault = fs.realpathSync.native(resolvedVault);
    canonicalRoot = fs.realpathSync.native(resolvedRoot);
    stats = fs.statSync(canonicalRoot);
  } catch (error) {
    return classifyUnresolvable(resolvedVault, resolvedRoot, error as NodeJS.ErrnoException);
  }

  // Re-checked after canonicalization: a symlink that sits inside the vault can
  // still point out of it, and only realpath can tell.
  if (escapesRoot(canonicalVault, canonicalRoot)) {
    return { ok: false, reason: "outside-vault" };
  }
  if (!stats.isDirectory()) {
    return { ok: false, reason: "not-a-folder" };
  }
  return { ok: true, path: canonicalRoot };
}

export function resolveCompilationRoot(vaultRoot: string, rootPath: string): string {
  const check = checkCompilationRoot(vaultRoot, rootPath);
  if (check.ok) return check.path;
  // Whatever the filesystem itself refused keeps its own error; only a value the
  // policy alone rejects gets the policy's message.
  throw check.error ?? new Error("Compilation root must resolve inside the vault.");
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
