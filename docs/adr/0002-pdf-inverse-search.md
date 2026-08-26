# ADR 0002: PDF.js preview with exact inverse search

- Status: accepted; native-helper transport superseded by ADR 0004
- Date: 2026-08-25

## Context

The SVG preview from ADR 0001 was safe and simple, but SVG images do not expose
a selectable PDF text layer or an official mapping from a rendered click to a
Typst source span. Tinymist offers a richer preview, but its preview data plane
is not a stable public LSP protocol. Reconstructing mappings from SVG text or
compiling a second mapping document could disagree with the displayed output.

## Decision

Keep the `TextFileView` editor and saved-file preview policy from ADR 0001.
Replace the Typst CLI subprocess with a separately installed
a native helper executable. The helper is built against exact Typst 0.15.1 crates
and owns one rooted `World` plus the retained `PagedDocument` for a revision.
It creates the PDF with `typst-pdf` and answers rendered-page click requests with
`typst_ide::jump_from_click` against that same document.

The desktop plugin communicates over bounded newline-delimited JSON using a
persistent child process launched with an argument array and `shell: false`.
Each preview leaf owns its own helper client because a helper retains one
document revision. New compilation supersedes and terminates older work. A
superseded jump or forward query is rejected locally while its ordered helper
response is drained; it does not destroy the retained revision. Closing the view
or aborting compilation still terminates the helper. Dirty buffers, source
changes, compile failures, and closed views invalidate
the active revision before inverse-search results can navigate.

Render the returned PDF with pinned `pdfjs-dist` 4.8.69. Bundle the browser
runtime and `WorkerMessageHandler` into `main.js`; connect them with a
`MessageChannel` so no worker file, CDN, or network access is needed. Canvas
renders the page while PDF.js's text layer preserves selection and copy. An
unmodified primary click converts PDF.js bottom-left coordinates to Typst
top-left points, then sends page and coordinates to the helper. A non-collapsed
text selection, link or control click, and secondary click remain ordinary PDF
interactions and do not navigate.

The Obsidian adapter serializes inverse navigation and retains only the latest
queued target. It reuses an editor leaf only when that exact source is already
open; otherwise it opens a new tab instead of replacing an unrelated editor.
The synchronous activation emitted by Obsidian's `getLeaf("tab")` is scoped as
part of that creation transaction; any other workspace context change invalidates
pending navigation. A stale newly-created leaf is detached only if it still
shows the exact plugin-opened target and has never been edited. If it is still
the internally activated leaf, the adapter first restores the previous leaf.
Dirty, edited, repurposed, and preexisting leaves are never rolled back.

The helper executable is never downloaded or bundled by the plugin. Users
build or install it separately and configure its executable path.

## Security and lifecycle

The helper's `World` canonicalizes every source and asset path, accepts regular
files only below the configured compilation root, and rejects symlink escapes
and package imports. Helper-returned dependencies, diagnostics, and source
jumps are validated as root-relative paths; Obsidian navigation applies a
second vault containment check.

Protocol requests, stdout/stderr, PDF bytes, compile duration, diagnostics,
dependencies, and pages are bounded. Preview replacement and closure cancel
PDF render/text tasks, destroy loading tasks and the inline worker, close both
message ports, and terminate the exact helper child. No network, telemetry,
remote compiler, or native auto-updater is present.

## Consequences

- Preview text is selectable and copyable.
- Primary-click inverse search is exact for the displayed retained revision.
- Preview still updates after save, not from an unsaved editor overlay.
- Rotated-page inverse search is intentionally disabled until its coordinate
  invariant is proven.
- The plugin artifact remains platform-independent, but the helper must be
  built or distributed separately for each desktop platform.
- Tinymist completion, hover, semantic tokens, and its private preview protocol
  remain out of scope.

## Evidence

- Helper unit and protocol integration tests under `helper/`
- PDF renderer, worker lifecycle, runtime, and bundle tests under `tests/`
- [Typst 0.15.1 `jump_from_click`](https://docs.rs/typst-ide/0.15.1/typst_ide/fn.jump_from_click.html)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/)
