import { describe, expect, it } from "vitest";

import {
  MAX_RESIDENT_FONT_BYTES,
  MAX_SELECTED_FONT_BYTES,
  planFontResidency,
  retainUsedFonts,
} from "../src/font-residency";

const MIB = 1024 * 1024;

function candidate(path: string, mib: number, root = 0) {
  return { path, byteLength: Math.round(mib * MIB), root };
}

describe("planFontResidency", () => {
  it("caps the residency far below the system font scan budget", () => {
    expect(MAX_RESIDENT_FONT_BYTES).toBeLessThanOrEqual(256 * MIB);
    expect(MAX_RESIDENT_FONT_BYTES).toBeGreaterThan(64 * MIB);
  });

  it("retains every candidate when the corpus fits under the cap", () => {
    const plan = planFontResidency([
      candidate("/a.ttf", 1),
      candidate("/b.ttf", 2),
    ]);
    expect([...plan].sort()).toEqual(["/a.ttf", "/b.ttf"]);
  });

  it("prefers earlier discovery roots, because user-installed faces are the ones documents name", () => {
    const plan = planFontResidency(
      [candidate("/system/big.ttf", 8, 1), candidate("/user/small.ttf", 8, 0)],
      8 * MIB,
    );
    expect([...plan]).toEqual(["/user/small.ttf"]);
  });

  it("prefers the largest file inside a root, because broad-coverage faces end the fallback walk", () => {
    const plan = planFontResidency(
      [candidate("/a.ttf", 2), candidate("/b.ttf", 8), candidate("/c.ttf", 4)],
      8 * MIB,
    );
    expect([...plan]).toEqual(["/b.ttf"]);
  });

  it("skips a candidate that does not fit and keeps filling with smaller ones", () => {
    const plan = planFontResidency(
      [candidate("/big.ttf", 10), candidate("/mid.ttf", 6), candidate("/small.ttf", 2)],
      8 * MIB,
    );
    expect([...plan].sort()).toEqual(["/mid.ttf", "/small.ttf"]);
  });

  it("never admits more bytes than the cap", () => {
    const candidates = Array.from({ length: 400 }, (_, index) =>
      candidate(`/f${index}.ttf`, 1));
    const plan = planFontResidency(candidates, 100 * MIB);
    expect(plan.size).toBe(100);
  });

  it("orders ties by path so the plan is reproducible", () => {
    const plan = planFontResidency(
      [candidate("/b.ttf", 4), candidate("/a.ttf", 4)],
      4 * MIB,
    );
    expect([...plan]).toEqual(["/a.ttf"]);
  });

  it("rejects candidates without usable bytes", () => {
    const plan = planFontResidency([candidate("/empty.ttf", 0)]);
    expect(plan.size).toBe(0);
  });
});

describe("retainUsedFonts", () => {
  it("keeps the residency inside the per-compile selected-font budget", () => {
    expect(MAX_SELECTED_FONT_BYTES).toBe(128 * MIB);
    expect(MAX_SELECTED_FONT_BYTES).toBeLessThan(MAX_RESIDENT_FONT_BYTES);
  });

  it("keeps a face the compile actually read", () => {
    const kept = retainUsedFonts(
      [candidate("/used.ttf", 4), candidate("/idle.ttf", 4)],
      new Set(["/used.ttf"]),
    );
    expect([...kept]).toEqual(["/used.ttf"]);
  });

  it("drops every face the compile never touched", () => {
    const kept = retainUsedFonts(
      [candidate("/a.ttf", 4), candidate("/b.ttf", 4)],
      new Set(),
    );
    expect(kept.size).toBe(0);
  });

  it("charges the kept set against the selected-font budget", () => {
    const resident = [candidate("/big.ttf", 100), candidate("/small.ttf", 40)];
    const used = new Set(["/big.ttf", "/small.ttf"]);
    const kept = retainUsedFonts(resident, used);
    const keptBytes = resident
      .filter((entry) => kept.has(entry.path))
      .reduce((total, entry) => total + entry.byteLength, 0);
    expect(keptBytes).toBeLessThanOrEqual(MAX_SELECTED_FONT_BYTES);
    expect([...kept]).toEqual(["/big.ttf"]);
  });

  it("does not re-evict what a second compile still needs", () => {
    const resident = [candidate("/a.ttf", 4), candidate("/b.ttf", 8)];
    const used = new Set(["/a.ttf", "/b.ttf"]);
    const first = retainUsedFonts(resident, used);
    const second = retainUsedFonts(
      resident.filter((entry) => first.has(entry.path)),
      used,
    );
    expect([...second].sort()).toEqual([...first].sort());
    expect(second.size).toBe(2);
  });

  it("never keeps a path the residency does not hold", () => {
    const kept = retainUsedFonts([candidate("/a.ttf", 4)], new Set(["/ghost.ttf"]));
    expect(kept.size).toBe(0);
  });
});
