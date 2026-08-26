import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import init, { TypstianWasmSession } from "../pkg/typstian_wasm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../tests/fixtures/project");
const wasm = fs.readFileSync(path.resolve(here, "../pkg/typstian_wasm_bg.wasm"));
await init({ module_or_path: wasm });

const session = new TypstianWasmSession();
const environment = JSON.parse(session.environment());
if (environment.protocolVersion !== 1 || environment.typstVersion !== "0.15.1") {
  throw new Error(`unexpected environment: ${session.environment()}`);
}

const readFile = (relativePath) => {
  const resolved = path.resolve(fixtureRoot, relativePath);
  if (!resolved.startsWith(`${fixtureRoot}${path.sep}`)) return undefined;
  try {
    return new Uint8Array(fs.readFileSync(resolved));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};

const compiled = session.compile(JSON.stringify({
  entry: "main.typ",
  revision: 11,
}), readFile);
if (
  typeof compiled !== "object"
  || compiled === null
  || compiled.revision !== 11
  || !(compiled.pdfBuffer instanceof ArrayBuffer)
  || compiled.pdfBuffer.byteLength === 0
  || compiled.pages.length === 0
) {
  throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
}

let sourceHit;
for (const source of ["main.typ", "section.typ"]) {
  const text = new TextDecoder().decode(readFile(source));
  for (let byteOffset = 0; byteOffset < Buffer.byteLength(text); byteOffset += 1) {
    const response = JSON.parse(session.forward(JSON.stringify({
      revision: 11,
      source,
      byteOffset,
    })));
    if (response.type === "positions") {
      sourceHit = { source, position: response.positions[0] };
      break;
    }
  }
  if (sourceHit) break;
}
if (!sourceHit) throw new Error("forward search found no rendered source position");

const jumped = JSON.parse(session.jump(JSON.stringify({
  revision: 11,
  page: sourceHit.position.page,
  xPt: sourceHit.position.xPt,
  yPt: sourceHit.position.yPt,
})));
if (jumped.type !== "source" || jumped.path !== sourceHit.source) {
  throw new Error(`inverse search failed: ${JSON.stringify(jumped)}`);
}

const staleForward = JSON.parse(session.forward(JSON.stringify({
  revision: 10,
  source: sourceHit.source,
  byteOffset: 0,
})));
if (staleForward.type !== "stale-revision" || staleForward.expectedRevision !== 11) {
  throw new Error(`unexpected stale response: ${JSON.stringify(staleForward)}`);
}

const invalidJump = JSON.parse(new TypstianWasmSession().jump(JSON.stringify({
  revision: 1,
  page: 1,
  xPt: 0,
  yPt: 0,
})));
if (invalidJump.type !== "error"
  || invalidJump.requestType !== "jump"
  || invalidJump.code !== "invalid-request") {
  throw new Error(`unexpected invalid jump response: ${JSON.stringify(invalidJump)}`);
}

const invalidSession = new TypstianWasmSession();
const invalidSource = new TextEncoder().encode("#let =");
const compileError = JSON.parse(invalidSession.compile(JSON.stringify({
  entry: "invalid.typ",
  revision: 12,
}), (relativePath) => relativePath === "invalid.typ" ? invalidSource : undefined));
if (compileError.type !== "error"
  || compileError.requestType !== "compile"
  || compileError.code !== "compile"
  || compileError.revision !== 12
  || compileError.diagnostics.length === 0) {
  throw new Error(`unexpected compile error: ${JSON.stringify(compileError)}`);
}

console.log(JSON.stringify({
  environment,
  pdfBytes: compiled.pdfBuffer.byteLength,
  pages: compiled.pages.length,
  dependencies: compiled.dependencies,
  forwardSource: sourceHit.source,
  inverseSource: jumped.path,
  compileErrorCode: compileError.code,
}));
