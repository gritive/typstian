#!/usr/bin/env node
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// wasm-pack heads its generated glue with a blanket `/* eslint-disable */`.
// The Obsidian community review rejects unscoped disables, and this repository
// already excludes helper/wasm/pkg from its own lint run, so the directive is
// removed after every regeneration.
const BLANKET_ESLINT_DISABLE = /^\/\* eslint-disable \*\/\n/gm;

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../helper/wasm/pkg",
);

let changed = 0;
for (const name of fs.readdirSync(packageDir)) {
  if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
  const file = path.join(packageDir, name);
  const source = fs.readFileSync(file, "utf8");
  const normalized = source.replace(BLANKET_ESLINT_DISABLE, "");
  if (normalized === source) continue;
  fs.writeFileSync(file, normalized);
  changed += 1;
}

console.log(`Removed blanket eslint-disable directives from ${changed} generated file(s).`);
process.exitCode = 0;
