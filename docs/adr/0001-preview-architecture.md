# ADR 0001: Saved-file Typst CLI preview

- Status: superseded by ADR 0002
- Date: 2026-08-24

## Context

Typstian must edit vault `.typ` files without replacing Obsidian's file
lifecycle, render multi-file documents, report source locations, and avoid
silently saving an editor buffer for preview. The first release is desktop-only.

The repository started empty. The evaluated compiler integrations were the
local Typst CLI, Tinymist's language server and preview frontend, and
`@myriaddreamin/typst.ts`. The evaluated editor integrations were a core
Markdown view registered for `.typ` and a custom `TextFileView`.

## Decision

Use a custom `TextFileView` containing CodeMirror 6. The base view owns file
loading and saving; the editor calls `requestSave()` after document changes and
does not write through `Vault.modify()`. This keeps `.typ` source-only and keeps
Typst language support out of Markdown editors. Use the WASM-free
`codemirror-lang-typst/lezer` parser, pinned to version 0.6.0.

Use a user-installed Typst CLI 0.15 or newer. Compile the saved entry file into
page-numbered SVG files in a unique operating-system temporary directory. Pass
arguments as an array with `shell: false`, use the vault as the default Typst
root, request short diagnostics and a JSON dependency manifest, bound process
time and output, and clean the exact temporary directory on every exit path.

Render each SVG as an opaque Blob URL on an `<img>`. Never insert compiler SVG
text into the DOM. Preview editor changes as a stale, waiting-for-save state;
compile after Obsidian saves the file. Watch only dependencies returned by the
compiler instead of the whole vault.

## Rejected editor alternatives

Obsidian's public API lets a plugin register a file extension for a view type,
but it does not expose a supported way to register `.typ` as the core Markdown
view while conditionally replacing that view's CodeMirror language. Depending
on core Markdown view internals would make editor ownership and extension
isolation version-sensitive. It was therefore rejected despite its potential to
inherit more core-editor behavior automatically.

A custom `TextFileView` is the smallest public-API implementation with explicit
ownership: `TextFileView` retains the Obsidian load/save and external-change
lifecycle, while the contained CodeMirror instance owns undo, selection,
clipboard, and Typst-only extensions. No extension is installed in Markdown
views. A completely custom `ItemView` plus `Vault.modify()` was rejected because
it would duplicate and risk violating the file lifecycle that `TextFileView`
already provides.

## Why preview follows saves

Typst 0.15.1 was tested with the repository fixture. Compiling the saved entry
file preserved relative imports and images, emitted two SVG pages, and produced
a JSON dependency list. Passing the same source through stdin assigned it the
virtual `<stdin>` identity at the project root, so a source in a subdirectory
could not resolve its relative import. The CLI has no documented source-overlay
API that preserves the entry path.

Tinymist models unsaved documents through LSP, but its embedded preview uses a
custom server and data-plane protocol beyond standard LSP. Depending on those
internal integration details would turn this MVP into a Tinymist frontend.
Typst.ts supports shadow sources, but a complete vault filesystem, package, font,
worker, and cache integration is substantially larger than a local CLI runner.

## Security boundary

`typst --root` is a project-root resolver, not a security sandbox. Upstream notes
that filesystem symlinks can escape it, and Typst packages may use the system
package cache or be downloaded by the compiler. Typst documents are therefore
treated as trusted local input. The plugin canonicalizes the root and entry,
rejects entries outside the selected root, does not add network or telemetry,
does not invoke a shell, and does not navigate diagnostics outside the vault.

Strict prevention of every outside-vault read and every compiler network request
would require a controlled WASM filesystem or an operating-system sandbox and is
outside this release.

## Consequences

- Preview correctness includes relative imports, images, system fonts, and
  multiple pages from the real entry file.
- The UI must say that preview is waiting for save while the buffer is dirty.
- Tinymist completion, hover, rename, semantic tokens, and live source-to-preview
  synchronization are deferred.
- Public distribution still needs the repository owner to choose a project
  license. The package remains `UNLICENSED`; bundled Apache-2.0 attribution is
  recorded separately.

## Evidence

- [Obsidian `TextFileView`](https://docs.obsidian.md/Reference/TypeScript+API/TextFileView)
- [Obsidian custom views](https://docs.obsidian.md/Plugins/User+interface/Views)
- [Typst CLI arguments](https://github.com/typst/typst/blob/main/crates/typst-cli/src/args.rs)
- [Typst CLI world and stdin identity](https://github.com/typst/typst/blob/main/crates/typst-cli/src/world.rs)
- [Typst filesystem root caveat](https://github.com/typst/typst/blob/main/crates/typst-kit/src/files.rs)
- [Tinymist preview documentation](https://myriad-dreamin.github.io/tinymist/feature/preview.html)
- [Typst CodeMirror language package](https://github.com/kxxt/codemirror-lang-typst)
