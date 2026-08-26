.DEFAULT_GOAL := build

.PHONY: build clean

# Wraps `npm run build`, which typechecks, bundles main.js with the
# Brotli-embedded WASM compiler, and verifies the generated notices.
build:
	npm run build

# Removes what regenerates from source: the cargo cache under helper/wasm
# (several GB after a test run), the plugin bundle, a stray WASM artifact from
# an older layout, and coverage output. The checked-in helper/wasm/pkg/ files
# stay — they are inputs to `npm test` and `npm run build`, and `npm run
# build:wasm` is what refreshes them. `cargo clean` is prefixed so a machine
# without cargo still gets the rest cleaned.
clean:
	-cargo clean --manifest-path helper/wasm/Cargo.toml
	rm -rf coverage
	rm -f main.js typstian_wasm_bg.wasm
