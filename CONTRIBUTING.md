# Contributing to Typstian

Typstian is an Obsidian desktop plugin: a TypeScript plugin around a Rust
compiler compiled to WebAssembly. `README.md` is the plugin's description in the
Community directory, so everything about building and releasing lives here.

## Build from source

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

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build:wasm # after changing helper/wasm/
npm run build
npm run licenses:check
cargo test   --manifest-path helper/wasm/Cargo.toml
cargo clippy --manifest-path helper/wasm/Cargo.toml --all-targets -- -D warnings

cargo install wasm-bindgen-cli --version 0.2.127 --locked  # to match release CI

make                      # same as npm run build
make clean                # drop the cargo cache, main.js, and coverage output
```

The cargo cache under `helper/wasm/target/` grows to several gigabytes once the
Rust tests and a WASM rebuild have run; `make clean` is how you reclaim it. It
leaves the checked-in `helper/wasm/pkg/` artifacts alone, because those are
build inputs rather than build output.

Commit the regenerated files under `helper/wasm/pkg/` after `npm run build:wasm`;
a plain `npm test` and `npm run build` consume the checked-in artifacts and do
not need `wasm-pack`. A regenerated `pkg/` is byte-identical to what is checked
in, so a clean `git status` afterwards is the expected result. That holds from
any directory: `build:wasm` passes `--remap-path-prefix` so the checkout path
and the Cargo registry path stay out of the module.

If `npm run build:wasm` reports `wasm32-unknown-unknown target not found in
sysroot`, another Rust installation is ahead of rustup in `PATH`. Put the
toolchain CI uses first, and make sure it has the components the link step needs:

```sh
rustup toolchain install 1.98.0 --target wasm32-unknown-unknown
rustup component add llvm-tools clippy --toolchain 1.98.0
```

Without `llvm-tools`, `rust-lld` cannot load `libLLVM.dylib` and the link aborts;
without `clippy`, another installation's `clippy-driver` is picked up and every
crate fails to compile with `E0514`.

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

## Publish a Community release

Typstian is listed in the Community directory as
[typstian](https://community.obsidian.md/plugins/typstian); a published GitHub
release is what the directory serves. Run the release script from a clean
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

Obsidian picks the release up from `manifest.json` and `versions.json`, and
only a published release reaches users.

