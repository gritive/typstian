import { describe, expect, it } from "vitest";

import {
  chooseForwardPreview,
  isSavedForwardSnapshot,
  shouldPreviewFollow,
} from "../src/preview-routing";

describe("preview routing", () => {
  it("prefers the exact entry before a dependency preview", () => {
    const exact = { id: "exact" };
    const dependency = { id: "dependency" };

    expect(chooseForwardPreview([
      { preview: dependency, sourcePath: "book/main.typ" },
      { preview: exact, sourcePath: "book/section.typ" },
    ], "book/section.typ", new Set(["book/main.typ"]))).toBe(exact);
  });

  it("chooses a dependency preview deterministically", () => {
    const letter = { id: "letter" };
    const book = { id: "book" };

    expect(chooseForwardPreview([
      { preview: letter, sourcePath: "letter.typ" },
      { preview: book, sourcePath: "book/main.typ" },
    ], "shared.typ", new Set(["letter.typ", "book/main.typ"]))).toBe(book);
  });

  it("retains same-entry and dependency previews but follows unrelated sources", () => {
    const affected = new Set(["book/main.typ"]);

    expect(shouldPreviewFollow("book/main.typ", "book/main.typ", affected)).toBe(false);
    expect(shouldPreviewFollow("book/main.typ", "book/section.typ", affected)).toBe(false);
    expect(shouldPreviewFollow("letter.typ", "book/section.typ", affected)).toBe(true);
    expect(shouldPreviewFollow(null, "book/section.typ", affected)).toBe(true);
  });

  it("accepts only a snapshot still matching both editor and vault", () => {
    const snapshot = {
      sourcePath: "book/main.typ",
      sourceText: "saved",
    };

    expect(isSavedForwardSnapshot("book/main.typ", "saved", "saved", snapshot)).toBe(true);
    expect(isSavedForwardSnapshot("book/main.typ", "dirty", "saved", snapshot)).toBe(false);
    expect(isSavedForwardSnapshot("book/main.typ", "saved", "older", snapshot)).toBe(false);
    expect(isSavedForwardSnapshot("book/other.typ", "saved", "saved", snapshot)).toBe(false);
  });
});
