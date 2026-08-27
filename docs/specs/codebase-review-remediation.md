# Codebase review remediation

The 2026-08-28 full codebase review found correctness, resource-boundary,
popout-window, lifecycle, and release-atomicity gaps. This specification is the
acceptance contract for closing those findings without changing Typstian's
network-free compiler or preview behavior.

## Acceptance criteria

1. Fontconfig discovery has a scan-wide configuration-file budget shared by
   roots, fragments, and recursive includes. Reaching it returns the directories
   found so far without reading another configuration file.
2. System-font discovery has a scan-wide visited-directory budget and observes
   cancellation during discovery, not only after discovery completes.
3. A fontconfig document that is not well-formed XML contributes no directories,
   even when it contains a complete `<dir>` element before the malformed part.
4. Every path returned by `systemFontDirectories()` is absolute. Relative XDG
   home values fall back to their standard absolute defaults, and relative
   XDG search-path entries are ignored.
5. In an Obsidian popout, located diagnostics render as accessible buttons and
   invoke source navigation. Renderer observers, fragments, timers, selection,
   and computed-style access use the rendered element's owning window or
   document rather than main-window globals.
6. Compilation-root validation updates are announced by assistive technology
   through a status live region.
7. Passing a successful compiler PDF to the preview does not make a full-size
   renderer-side copy. The renderer still preserves the visible PDF while a
   replacement is loading and retains its existing stale-render protection.
8. A compile's dirty-buffer overlay is available for that request and is no
   longer retained by the compiler client after the request settles. Overlay
   construction enforces the same per-file and aggregate byte policy before
   handing data to the engine.
9. The WASM compiler rejects documents over its supported page and page-size
   complexity boundary before calling PDF serialization, while ordinary
   documents continue to compile.
10. Closing the last preview associated with an entry removes that entry from
    the dependency index; closing one of multiple previews must not remove an
    entry still in use.
11. A release publishes its branch and tag with one atomic push, so the remote
    cannot observe only half of a release.
12. Completion and source-navigation scheduling share one implementation of
    the "one running, newest pending" state machine while preserving their
    public scheduling, stale-result, and error behavior.
13. User-facing copy is owned by one message module without changing rendered
    wording, and the unused `typst-pdf-forward-target` class mutations are
    removed.

## Verification

- Every behavioral criterion is exercised through the agreed public seams:
  font discovery exports, renderer and settings DOM behavior, compiler-client
  requests, plugin preview lifecycle, release CLI, scheduler request APIs, and
  the Rust WASM compile session.
- New behavior follows one red test to one minimal green implementation.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
  `cargo test --manifest-path helper/wasm/Cargo.toml`, and
  `cargo clippy --manifest-path helper/wasm/Cargo.toml --all-targets -- -D warnings`
  all pass.
- Two-axis review against this specification and repository standards has no
  actionable findings.

## Out of scope

- Network access, telemetry, compiler or package downloads, and native helpers.
- New user-configured font paths.
- Changes to the retained-document navigation and completion protocols beyond
  the lifecycle and scheduling corrections above.
