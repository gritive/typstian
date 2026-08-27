// A compiler session registers system fonts as metadata and pulls their bytes
// only when a compile asks for them. The first compile of a session therefore
// lays the whole document out with no loadable face, and Typst answers every
// uncovered run with a fresh fallback scan over the entire font book — 22 s on a
// 126 KB Korean book against 983 registered faces, versus 0.3 s once the bytes
// are present. Keeping the bytes the host already read lets the worker answer
// that first request from memory and skips the wasted pass.
//
// `MAX_SYSTEM_FONT_SCAN_BYTES` bounds how much the host may *read*; the two
// ceilings below bound what stays *in memory* inside an Obsidian renderer that
// also hosts PDF.js, the WASM compiler, and the editor.

// The cold-start ceiling: unproven candidate faces the worker holds between
// registration and the moment the first compile settles. It is wider than the
// steady-state ceiling below because nothing yet knows which faces the document
// needs, and it lasts only until the first compile answers that question.
export const MAX_RESIDENT_FONT_BYTES = 256 * 1024 * 1024;

// The steady-state ceiling, and the same number `src/wasm-engine.ts` charges
// host-shipped font bytes against for one compile. Once a compile has settled,
// the worker keeps only the faces that compile actually read, bounded here, so
// the residency lives *inside* the per-compile selected-font budget instead of
// escaping alongside it.
export const MAX_SELECTED_FONT_BYTES = 128 * 1024 * 1024;

export interface FontResidencyEntry {
  /** Canonical font file path. */
  readonly path: string;
  /** Retained or on-disk size; an entry with no bytes is never retained. */
  readonly byteLength: number;
}

export interface FontResidencyCandidate extends FontResidencyEntry {
  /** Index of the discovery root the file was found under, lowest first. */
  readonly root: number;
}

/**
 * Chooses which discovered fonts stay resident in the compiler worker.
 *
 * Nothing here can know which faces a document will name, so the ranking uses
 * the two signals that survive discovery:
 *
 * 1. Discovery root, ascending. `systemFontDirectories()` lists the user's own
 *    font directories first, and a face a user installed is far likelier to be
 *    the one a document names than a face the OS shipped.
 * 2. File size inside a root, descending. The scan this cache exists to
 *    short-circuit is a *coverage* fallback, and the faces that end it are the
 *    broad-coverage CJK and Unicode ones — which are also the largest files.
 *
 * A candidate that does not fit is skipped rather than ending the plan, so the
 * cheap tail of a root still fills the remaining budget.
 */
export function planFontResidency(
  candidates: readonly FontResidencyCandidate[],
  capBytes: number = MAX_RESIDENT_FONT_BYTES,
): Set<string> {
  return fillUnderCap(
    candidates.filter((candidate) => candidate.byteLength > 0),
    capBytes,
    (left, right) => left.root - right.root || right.byteLength - left.byteLength,
  );
}

/**
 * Fills the cap greedily in ranked order, skipping — never stopping at — an
 * entry that does not fit, so the cheap tail still uses the remaining budget.
 * Path breaks every tie, so a plan is the same set on every run.
 */
function fillUnderCap<Entry extends { readonly path: string; readonly byteLength: number }>(
  entries: readonly Entry[],
  capBytes: number,
  rank: (left: Entry, right: Entry) => number,
): Set<string> {
  const ranked = entries
    .slice()
    .sort((left, right) =>
      rank(left, right)
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const kept = new Set<string>();
  let keptBytes = 0;
  for (const entry of ranked) {
    if (keptBytes + entry.byteLength > capBytes) continue;
    keptBytes += entry.byteLength;
    kept.add(entry.path);
  }
  return kept;
}

/**
 * Narrows a settled compile's residency to the faces it actually read.
 *
 * The cold-start set is a bet: `planFontResidency` keeps whatever might end the
 * fallback walk, because before the first compile nothing knows better. Once
 * that compile settles the worker does know — every seeded face the compiler
 * touched is recorded — so the bet is cashed in and the rest is dropped. Steady
 * state falls to the handful of faces the document uses, which is what keeps N
 * open previews from costing N times the cold-start ceiling.
 *
 * The survivors are bounded by `MAX_SELECTED_FONT_BYTES`, the same budget the
 * host charges the font bytes it ships for one compile, so the two cannot sum
 * past the ceiling either was written to hold. Ranking is size descending —
 * the cold-start plan sorts by discovery root first, this one has no reason to,
 * since every survivor is already proven — and it skips rather than stops at a
 * face that does not fit, because a broad-coverage face is the expensive one to
 * go without.
 */
export function retainUsedFonts(
  resident: readonly FontResidencyEntry[],
  used: ReadonlySet<string>,
  capBytes: number = MAX_SELECTED_FONT_BYTES,
): Set<string> {
  return fillUnderCap(
    resident.filter((entry) => entry.byteLength > 0 && used.has(entry.path)),
    capBytes,
    (left, right) => right.byteLength - left.byteLength,
  );
}
