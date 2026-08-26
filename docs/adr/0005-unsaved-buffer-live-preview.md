# ADR 0005: Unsaved-buffer live preview

- Status: accepted
- Date: 2026-08-26
- Amends: ADR 0001 (the waiting-for-save preview state) and ADR 0004 (the vault
  input protocol)

## Context

ADR 0001 rendered the saved entry file only. An edited buffer put the preview in
a `waiting-for-save` state until Obsidian's save lifecycle wrote the file. That
state was a consequence of the input path, not a requirement: the compiler reads
vault bytes through one rooted reader, and that reader only knows about disk.

The preview is worth the least at exactly the moment the user is typing, so the
compiler needs the text in the editor rather than the text on disk, without the
plugin saving the file on the user's behalf.

## Decision

Add a dirty-buffer overlay. `src/dirty-buffer-overlay.ts` turns every open Typst
editor with unsaved changes into a `Map` from compilation-root-relative path to
UTF-8 bytes, reusing `resolveCompilerEntryPath` so a buffer outside the
compilation root or one that is not a `.typ` source never enters the map.

The overlay travels with the compile request. `TypstianCompilerClient.compile`
pins it for that revision and hands it to the engine, which keeps it beside the
compile's input budget; it is never posted to the worker, so PDF-sized editor
text does not cross the message boundary or the JSON request-size guard. When
the compiler asks for a vault path, `WorkerWasmEngine.providePath` returns the
overlay bytes if the snapshot has that path and falls back to the rooted disk
reader otherwise. Overlay bytes are charged to the same 70 MiB per-compile
budget as disk bytes.

Pinning the map for the whole compile is what keeps inverse and forward search
honest. The vault input protocol is asynchronous and file-by-file, so re-reading
each editor as its file is requested would mix text from different keystrokes
into one document, and the span mapping against that document would be wrong in
ways nothing reports. A snapshot belongs to one revision; a later edit is a later
revision.

`PreviewController` compiles a dirty buffer after a 300 ms debounce rather than
emitting `waiting-for-save`, which is removed. The last PDF stays visible while
the recompile runs.

## Cancellation

A compile in flight is not aborted when the buffer changes. Aborting a compile
request calls `failSession`, which disposes the engine, and disposing the engine
terminates the worker — discarding its retained document and forcing system-font
registration to run again on the next request. Under continuous typing that
would restart the compiler on every burst.

`PreviewController` instead queues the newest revision, lets the running compile
finish, discards its now-superseded result through the existing generation check,
and starts the queued compile from the `finally` block. Only `setSource` and
`dispose` still abort, where the work is genuinely unwanted rather than merely
stale.

## Consequences

- The preview tracks the editor. Unsaved `import`s resolve from the overlay too,
  because it applies to every vault path the compiler requests, not just the
  entry.
- Typstian still never writes the user's buffer; Obsidian keeps the save
  lifecycle.
- Inverse search stays valid against the visible PDF: `markDirty` invalidates the
  active revision before any recompile, so a click cannot map through a stale
  document.
- Forward search remains gated on a saved snapshot. The compiled snapshot may lag
  the current buffer, and `isSavedForwardSnapshot` is what proves the editor text
  and the compiled text agree.
- An edit during a slow compile waits for that compile. The observable cost is
  latency, not a restarted session.

## Evidence

- `tests/dirty-buffer-overlay.test.ts` — overlay keying, root escape, non-Typst
  buffers
- `tests/preview-controller.test.ts` — dirty debounce, no abort on supersede,
  queued recompile after the running compile settles
- `tests/preview-view.test.ts` — inverse search invalidated on dirty while the
  last PDF stays visible
