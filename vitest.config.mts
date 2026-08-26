import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url))
    },
    dedupe: [
      "@codemirror/language",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr"
    ]
  },
  test: {
    environment: "node",
    restoreMocks: true,
    setupFiles: ["./tests/stubs/obsidian-dom.ts"]
  }
});
