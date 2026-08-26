import { spawnSync } from "node:child_process";

import { createPdfJsEngine } from "../src/pdfjs-adapter";

async function smoke(): Promise<void> {
  const compiled = spawnSync(
    "typst",
    ["compile", "--format", "pdf", "-", "-"],
    {
      input: "#set page(width: 120pt, height: 80pt, margin: 10pt)\nBundled PDF.js smoke",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (compiled.status !== 0) {
    throw new Error("Typst could not create the PDF.js bundle smoke fixture.");
  }

  const loadingTask = createPdfJsEngine().load(new Uint8Array(compiled.stdout));
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent() as {
      items: Array<{ str?: string }>;
    };
    const text = content.items
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ");
    page.cleanup();
    if (!text.includes("Bundled PDF.js smoke")) {
      throw new Error(`Bundled PDF.js returned unexpected text: ${text}`);
    }
    process.stdout.write("Bundled PDF.js loaded a Typst PDF with selectable text.\n");
  } finally {
    await loadingTask.destroy();
  }
}

void smoke().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
