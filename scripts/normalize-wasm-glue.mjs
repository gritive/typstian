#!/usr/bin/env node
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// wasm-pack heads its generated glue with a blanket `/* eslint-disable */`.
// The Obsidian community review rejects unscoped disables, and this repository
// already excludes helper/wasm/pkg from its own lint run, so the directive is
// removed after every regeneration.
const BLANKET_ESLINT_DISABLE = /^\/\* eslint-disable \*\/\n/gm;

// wasm-bindgen cannot describe `&js_sys::Function` or a returned `JsValue`, so
// it emits `Function` and `any` — the two shapes every linter reading the
// generated declarations reports. The vault, package, and font readers share one
// exact signature, and `compile` returns a value the client validates, so the
// declaration is narrowed to what the worker actually passes and receives.
const GENERATED_COMPILE_SIGNATURE =
  "    compile(request_json: string, read_file: Function, read_package: Function, read_font: Function): any;\n";
const NARROWED_COMPILE_SIGNATURE =
  "    compile(request_json: string, read_file: WasmInputReader, read_package: WasmInputReader, read_font: WasmInputReader): unknown;\n";
const INPUT_READER_DECLARATION =
  "/** Resolves one input key, or nothing when it is absent. */\n"
  + "export type WasmInputReader = (path: string) => Uint8Array | undefined;\n\n";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../helper/wasm/pkg",
);

function narrowCompileSignature(source) {
  if (source.includes(NARROWED_COMPILE_SIGNATURE)) return source;
  if (!source.includes(GENERATED_COMPILE_SIGNATURE)) {
    throw new Error(
      "typstian_wasm.d.ts no longer declares the expected `compile` signature; "
      + "update scripts/normalize-wasm-glue.mjs to match wasm-bindgen's output.",
    );
  }
  return INPUT_READER_DECLARATION
    + source.replace(GENERATED_COMPILE_SIGNATURE, NARROWED_COMPILE_SIGNATURE);
}

let changed = 0;
for (const name of fs.readdirSync(packageDir)) {
  if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
  const file = path.join(packageDir, name);
  const source = fs.readFileSync(file, "utf8");
  let normalized = source.replace(BLANKET_ESLINT_DISABLE, "");
  if (name === "typstian_wasm.d.ts") {
    normalized = narrowCompileSignature(normalized);
  }
  if (normalized === source) continue;
  fs.writeFileSync(file, normalized);
  changed += 1;
}

console.log(`Normalized ${changed} generated file(s).`);
