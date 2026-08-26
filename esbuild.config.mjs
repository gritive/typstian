import { readFile } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const production = process.argv[2] === "production";
const external = [
  "obsidian",
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr"
];

const wasmBrotliBase64 = brotliCompressSync(
  await readFile("helper/wasm/pkg/typstian_wasm_bg.wasm"),
  {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
    },
  },
).toString("base64");

const workerBuild = await esbuild.build({
  entryPoints: ["src/wasm-worker.ts"],
  bundle: true,
  define: {
    "import.meta.url": "undefined",
  },
  format: "iife",
  logLevel: "silent",
  minify: production,
  platform: "browser",
  sourcemap: false,
  target: "es2021",
  treeShaking: true,
  write: false,
});
const workerSource = workerBuild.outputFiles[0]?.text;
if (workerSource === undefined) throw new Error("Typstian worker bundle was not generated.");

const thirdPartyNotices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
const thirdPartyNoticeBanner = `/*!
${thirdPartyNotices.replaceAll("*/", "* /")}
*/`;

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  banner: { js: thirdPartyNoticeBanner },
  define: {
    "import.meta.url": "undefined",
    __TYPSTIAN_WASM_BROTLI__: JSON.stringify(wasmBrotliBase64),
    __TYPSTIAN_WORKER_SOURCE__: JSON.stringify(workerSource),
  },
  entryNames: "[name]",
  external,
  format: "cjs",
  logLevel: "info",
  minify: production,
  outdir: ".",
  platform: "node",
  sourcemap: production ? false : "inline",
  target: "es2021",
  treeShaking: true
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
