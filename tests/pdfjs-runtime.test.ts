import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createPdfJsEngine } from "../src/pdfjs-adapter";

const compiled = spawnSync(
  "typst",
  ["compile", "--format", "pdf", "-", "-"],
  {
    input: "#set page(width: 120pt, height: 80pt, margin: 10pt)\nPDF.js selectable smoke",
    maxBuffer: 2 * 1024 * 1024,
  },
);

describe("bundled PDF.js runtime", () => {
  it.skipIf(compiled.status !== 0)(
    "loads a real Typst PDF offline and exposes its text content",
    async () => {
      const workerRuntime = globalThis as typeof globalThis & {
        pdfjsWorker?: { WorkerMessageHandler?: unknown };
      };
      expect(typeof workerRuntime.pdfjsWorker?.WorkerMessageHandler).toBe("function");
      const engine = createPdfJsEngine();
      const loadingTask = engine.load(new Uint8Array(compiled.stdout));

      try {
        const document = await loadingTask.promise;
        expect(document.numPages).toBe(1);
        const page = await document.getPage(1);
        const content = await page.getTextContent() as {
          items: Array<{ str?: string }>;
        };
        expect(content.items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " "))
          .toContain("PDF.js selectable smoke");
        page.cleanup();
      } finally {
        await loadingTask.destroy();
      }
    },
  );
});
