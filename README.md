# Typstian

Typstian opens `.typ` files as editable source in Obsidian and renders the
document as a selectable PDF in an adjacent preview leaf, including edits you
have not saved yet. It targets
Obsidian desktop. The plugin ships its Typst compiler as WebAssembly, so users
do not install Typst or a native helper.

## Requirements

- Obsidian desktop 1.13.1 or newer
- A filesystem-backed vault

## Install from this repository

Building the plugin from checked-in sources requires Node.js and npm.
Regenerating the compiler artifacts requires Rust 1.92 or newer and
`wasm-pack`. Release CI uses Rust 1.98.0. Release users do not need these tools.

```sh
npm ci
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/typstian/
```

Reload Obsidian, enable community plugins, and enable **Typstian**. Do not
enable another plugin that registers the `.typ` extension in the same vault.

## Publish a Community release

Make the GitHub repository public, then run the release script from a clean
checkout that matches its remote branch:

```sh
npm run release -- patch     # or minor, major, or an explicit 1.2.3
npm run release -- patch --dry-run
```

It bumps `manifest.json`, `package.json`, `package-lock.json`, and
`versions.json` together, regenerates the dependency notices, runs the
typecheck, lint, and test gates, then commits, tags, and pushes. Pushing the tag
starts the release workflow, which rebuilds the WASM compiler from the locked
Rust sources, reruns those gates, attests `main.js`, `manifest.json`, and
`styles.css`, and publishes a GitHub release containing those three files with
generated notes.

Submit the plugin to the Community directory only after the matching release is
published.

## Use

1. Create or open a `.typ` file in the vault.
2. Edit it in the Typst source view.
3. Run **Typstian: Open Typst preview** from the command palette.
4. Use the preview toolbar to zoom or fit pages to the available width.
5. Click rendered preview text to jump to the exact Typst source byte offset.
   Dragging still selects text for copying; links and controls keep their normal behavior.
6. In a saved `.typ` editor, click or move the selection with the mouse to reveal
   the corresponding output location in the preview. Keyboard-only selection
   changes do not sync automatically. Unsaved buffers must be saved first.

The preview follows the active Typst editor, except that opening a source
imported by the visible entry keeps that entry's preview. Compiler diagnostics are buttons;
select one to open its `.typ` file and move the cursor to the reported location.
The command **Typstian: Check Typst environment** reports the embedded Typst
version and compilation root.

Typstian recompiles shortly after you stop typing, using the unsaved text of
every open Typst editor in place of its file on disk. Obsidian still owns the
normal save lifecycle; the plugin never saves the buffer for you. Everything the
compiler does not have open reads from the vault, so relative imports, images,
fonts, and multi-page output keep their normal Typst meaning. Changes to
dependencies from the previous compile refresh only affected previews.

A compile that is already running cannot be cancelled without discarding the
compiler session, so an edit made mid-compile does not interrupt it. That result
is dropped and the newest text compiles as soon as the running compile finishes.

## Settings

- **Compilation root**: optional path inside the vault; defaults to the vault
  root.

Typstian 0.0.1 uses its embedded fonts and fonts installed in standard macOS,
Windows, or Linux font directories. It registers shared font metadata once, then
loads only fonts selected by a document into WASM on demand. It does not accept
additional font paths or compiler flags.

## Troubleshooting

### An import or image is not found

Paths remain relative to the `.typ` entry file. Keep the entry and dependency
inside the selected compilation root. The default root is the vault.

### A `.typ` file opens in another view

Disable other Obsidian plugins that register the `.typ` extension, then reload
Typstian.

## Security boundary

The compiler and its browser-worker source are embedded in `main.js` during the
release build. Obsidian's renderer decompresses and compiles the WASM module once,
then each preview runs its compiler session in a Blob-backed Web Worker. The worker
requests vault files and selected system fonts as file-by-file transferable chunks;
asynchronous rooted host readers open regular files below their canonical roots and
recheck device and inode before returning bytes. Vault input is capped at 70 MiB per
compile and selected fonts at 128 MiB in aggregate. Absolute paths, traversal, and
symlink escapes are rejected. Initialization has a 120-second deadline and each
compile has a 15-second deadline; timeout or cancellation terminates the worker.
PDF bytes cross the WASM boundary as an `ArrayBuffer` and are transferred without
a renderer-side copy. PDF.js
ships in `main.js`, including its in-process worker, and runs without a CDN.

Typstian makes no network requests, sends no telemetry, performs no remote
compilation, and does not launch or download native executables.
The Typstian MIT license and complete third-party license and attribution notices
are embedded as a readable comment in the installed `main.js` and are also maintained in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Current scope

Version 0.0.1 does not provide mobile support,
completion, hover, rename, go-to-definition, formatting, semantic tokens, PDF
export, rotated-page inverse search, glyph-exact forward round-tripping, or
Tinymist's custom preview protocol. Syntax highlighting comes from
the experimental `codemirror-lang-typst` 0.6.0 Lezer grammar for Typst 0.15.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build:wasm # after changing helper/wasm/
npm run build
cargo test --manifest-path helper/wasm/Cargo.toml
```

The WASM session tests compile imported Unicode and image fixtures and exercise
both navigation directions against retained document revisions. The browser-worker
runtime test verifies that compilation can wait for asynchronous rooted input batches
without blocking the host event loop. The compiler client suite verifies serialization,
request timeout and abort state, worker-session recovery, and shutdown. The remaining
plugin suite uses engine fakes, real CodeMirror state, PDF.js runtime smoke tests, and
DOM-level preview tests.

## Manual smoke test

Use a disposable vault without another Typst plugin.

1. Install `manifest.json`, `main.js`, and `styles.css` in the Obsidian plugin
   directory, then enable Typstian.
2. Open `helper/tests/fixtures/project/main.typ` from a copy inside the vault.
3. Confirm syntax highlighting, undo, redo, selection, and normal save behavior.
4. Open the preview and confirm scrollable PDF pages, selectable text, and the
   imported image.
5. Click visible preview text without a modifier and confirm the matching
   `.typ` source and byte offset are revealed; drag-selection must not navigate.
6. Save the source, click or move its editor selection with the mouse, and confirm
   the preview scrolls to and briefly marks the corresponding output location. Repeat from
   an imported source and confirm the entry preview remains open.
7. Introduce a syntax error, save, select its diagnostic, and confirm the cursor
   moves to the reported location.
8. Fix the error, save, and confirm the preview recovers.
9. Change `section.typ` and confirm only the dependent preview refreshes.
10. Change zoom and fit, restart Obsidian, and confirm the split and state return.
11. Disable the plugin after a compile and confirm it releases the WASM session.

Architecture evidence and rejected alternatives are recorded in
[`docs/adr/0001-preview-architecture.md`](docs/adr/0001-preview-architecture.md),
[`docs/adr/0002-pdf-inverse-search.md`](docs/adr/0002-pdf-inverse-search.md),
and [`docs/adr/0003-source-to-preview-search.md`](docs/adr/0003-source-to-preview-search.md).
The bundled compiler decision is recorded in
[`docs/adr/0004-bundled-wasm-compiler.md`](docs/adr/0004-bundled-wasm-compiler.md).

## Licensing

Typstian is licensed under the MIT License. Third-party attribution is embedded
in the distributed `main.js` and recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
