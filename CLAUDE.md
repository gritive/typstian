# Typstian

Obsidian desktop plugin (TypeScript) with a bundled Rust-to-WASM Typst compiler.
User-facing docs live in `README.md`; this file records what is not obvious from
the code.

## Commands

```sh
npm test                  # vitest run
npm run typecheck         # tsc --noEmit
npm run lint              # eslint .
npm run build             # -> main.js with Brotli-embedded WASM
npm run dev               # esbuild watch

cargo test   --manifest-path helper/wasm/Cargo.toml
cargo clippy --manifest-path helper/wasm/Cargo.toml --all-targets -- -D warnings
npm run build:wasm        # wasm-pack web target -> helper/wasm/pkg/
```

Run `npm run build:wasm` after changing `helper/wasm/`, then commit the generated
files under `helper/wasm/pkg/`. Local `npm test` and `npm run build` consume those
checked-in files without requiring `wasm-pack`. Release CI instead rebuilds WASM
from the locked Rust sources before the plugin build. esbuild Brotli-compresses
and embeds the result in `main.js`; Community releases contain only `main.js`,
`manifest.json`, and `styles.css`.

## Architecture

- `src/`: Obsidian plugin. `main.ts` (`TypstianPlugin`) wires the editor,
  preview, and settings; `compiler-client.ts` owns request ordering, bounds,
  cancellation, and response validation; `wasm-engine.ts` initializes the
  bundled WASM module and owns per-preview browser workers; `wasm-worker.ts`
  owns compiler sessions and the asynchronous vault/font input protocol.
- `helper/src/lib.rs` is the serde-only protocol DTO crate shared with WASM; it
  owns no compiler backend.
- `helper/wasm/` provides the only Rust compiler implementation, using
  `wasm-bindgen` and exact Typst 0.15.1 crates for compile/jump/forward.
- Each WASM session retains the compiled document per revision so a
  PDF click maps back to a source span (inverse search) and an editor cursor maps
  forward to a page position, both against the exact snapshot that produced the
  visible PDF.

## Gotchas

- **Protocol version is duplicated**: `PROTOCOL_VERSION` in
  `src/compiler-client.ts` and `helper/wasm/src/lib.rs`. Bump both together; the
  environment handshake rejects a mismatch.
- **Release contract**: `manifest.json` `version` must exist as a key in
  `versions.json` mapping to `minAppVersion`. `tests/release-contract.test.ts`
  also guards the embedded WASM and third-party notices, pinned release workflow,
  checked-in WASM glue/artifact, and `styles.css`.
- **Typst crates are pinned `=0.15.1`** (`typst`, `typst-ide`, `typst-kit`,
  `typst-layout`, `typst-pdf`). They move together; do not bump one alone.
- **esbuild externals**: `obsidian`, `electron`, node builtins, and every
  `@codemirror/*` / `@lezer/*` package must stay in `external` in
  `esbuild.config.mjs`. Bundling CodeMirror creates a second instance and breaks
  the host editor. vitest mirrors this with `dedupe` in `vitest.config.mts`.
- **`obsidian` is aliased** to `tests/stubs/obsidian.ts` under vitest; there is
  no real Obsidian in tests.
- `main.js` is a gitignored build artifact (~19 MB): PDF.js, its in-process
  worker, the embedded browser compiler-worker source, the Brotli-compressed
  WASM compiler, and third-party notices are bundled without a CDN.
- Preview compiles unsaved buffers: `src/dirty-buffer-overlay.ts` snapshots every
  open dirty Typst editor into a compilation-root-relative overlay that
  `WorkerWasmEngine.providePath` consults before the disk reader, under the same
  70 MiB budget and path policy. The snapshot is pinned per compile revision, so a
  mid-compile edit cannot tear it. Never save the buffer on the user's behalf.
- **Never abort a compile to supersede it.** Aborting a compile request calls
  `failSession`, which disposes the engine and terminates the worker — that
  discards the retained document and re-runs system-font registration.
  `PreviewController` therefore queues the newest revision and starts it when the
  running compile settles; only `setSource` and `dispose` abort.
- The checked-in `typstian_wasm_bg.wasm` is a local-development input; release CI
  rebuilds it and embeds the result in `main.js`. A Blob-backed browser worker owns
  each compiler session. Vault inputs arrive as file-by-file transferable chunks
  through `src/wasm-vault-reader.ts`, capped at 70 MiB per compile. Its rooted reader
  opens each canonical regular file and rechecks device and inode before returning
  bytes. System-font discovery separately scans standard OS directories under file,
  byte, and face bounds. The worker retains parsed metadata; selected font bytes
  load through an allowlisted callback only for the active compile, capped at
  128 MiB in aggregate. Keep network,
  telemetry, native process launch, and compiler downloads out of the plugin.
- Obsidian's Electron renderer cannot create Node `worker_threads`; the release
  uses an embedded browser Web Worker instead. WASM calls remain synchronous only
  inside that worker. Initialization has a 120-second deadline; each compile has a
  15-second deadline. Timeout or abort terminates the worker and its retained
  document; the next request starts a clean session. PDF bytes cross the WASM boundary directly as an `ArrayBuffer`; the worker
  transfers it without a renderer-side copy.
- Version 0.0.1 uses embedded fonts plus fonts in bounded standard OS
  directories. It does not accept additional font paths.
- Compiler test fixtures are under `helper/tests/fixtures/`
  (`project/`, `diagnostics/`, `escape/`, `fonts/`), not `tests/fixtures/`.

## Decisions

`docs/adr/`: 0001 (superseded by 0002), 0002 PDF.js preview with inverse search,
0003 source-to-preview search, 0004 bundled WASM compiler, and 0005
unsaved-buffer live preview. Read the relevant
ADR before changing preview, search, or compiler integration.
