# Font discovery paths

Issue #1 (comment 5440231535): a reporter's `Noto Sans` compiles in tinymist but
not in Typstian. Typstian scans a fixed list of standard OS font directories
(`systemFontDirectories()` in `src/system-fonts.ts`); tinymist goes through
fontconfig. Two classes of font therefore exist that other applications see and
Typstian does not.

## What this change decides

1. **A sandboxed Obsidian sees host fonts at the sandbox's mount points, not at
   the host's paths.** Under Flatpak the host's system and user fonts are bound
   at `/run/host/fonts`, `/run/host/local-fonts`, and `/run/host/user-fonts`;
   `/usr/share/fonts` inside the sandbox is the runtime's own, near-empty set. A
   Linux font list that names only the unsandboxed paths misses every host font.
2. **fontconfig's configured directories are part of "where this system keeps
   fonts".** A user who installs fonts to a directory named in
   `/etc/fonts/fonts.conf`, its `conf.d` fragments, or
   `$XDG_CONFIG_HOME/fontconfig/fonts.conf` has told the whole system where they
   are. Reading those `<dir>` elements is what makes Typstian agree with every
   other application on the machine.

Both are read-only *discovery* changes. They add directories to scan; they do
not change what `registerSystemFonts` is willing to read from a directory, nor
the file, byte, and face bounds it enforces, nor the residency policy.

## Acceptance criteria

Observable at `systemFontDirectories()`, a pure function over `process.platform`
and the environment.

- **AC1** On Linux, the returned list contains `/run/host/fonts`,
  `/run/host/local-fonts`, and `/run/host/user-fonts`.
- **AC2** On Linux, directories named by `<dir>` elements in the fontconfig
  configuration are in the returned list, with `~` expanded to the home
  directory and a relative `prefix="xdg"` resolved against `$XDG_DATA_HOME`.
- **AC3** fontconfig configuration is read from `$FONTCONFIG_FILE` when set,
  otherwise from `$FONTCONFIG_PATH`/`/etc/fonts` — `fonts.conf` plus every
  `conf.d/*.conf` fragment — and from
  `$XDG_CONFIG_HOME/fontconfig/{fonts.conf,conf.d/*.conf}`.
- **AC4** A missing, unreadable, or malformed fontconfig file yields no
  directories and no thrown error: discovery keeps the standard paths.
- **AC5** The user's own directories still rank ahead of the OS's. Ordering
  drives `planFontResidency`'s discovery-root ranking, so the returned list stays
  ordered user-first: `~/.fonts` and `$XDG_DATA_HOME/fonts`, then fontconfig's
  user configuration, then the system paths and the host mounts.
- **AC6** The returned list contains no duplicates and every entry is absolute.
- **AC7** macOS and Windows lists are unchanged. fontconfig is not consulted on
  either platform.

## Out of scope

- A user-facing setting for extra font directories. `CLAUDE.md` records "No
  additional font paths"; nothing here adds a path the user types.
- Bundling a default text face. Typst's default `libertinus serif` stays
  unbundled, and a document that asks for a missing family still substitutes.
- Any change to `registerSystemFonts`, the residency plan, or the compiler's
  font catalog.
