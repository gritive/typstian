# Preview entry points

## Why

Issue [#1](https://github.com/whitekid/typstian/issues/1) reported that the
Typst preview could not be found. 0.0.7 answered half of it: there was no way
to create a `.typ` file at all, so `open-typst-preview` — a `checkCallback`
command gated on an active Typst editor — stayed hidden and the preview looked
absent. The reporter confirmed creating a file now works and the preview is
still not visible.

The remaining cause is discoverability. The command palette entry is the only
way into the preview: `grep -n 'addRibbonIcon\|addAction' src/` returns nothing,
and the `file-menu` handler in `src/main.ts` handles only `TFolder`. A user who
has a `.typ` file open sees no button, no context-menu item, and no affordance
anywhere in the interface pointing at the preview.

This spec adds two entry points that are visible without knowing the command
exists. It deliberately leaves `open-typst-preview` as it is — the palette
command keeps its active-editor gate.

## Requirements

1. **The Typst editor carries a preview action.** A leaf showing
   `TypstEditorView` has a view action titled `Open Typst preview`. Activating
   it opens the preview and points it at that leaf's file.
2. **The action does not depend on being the active view.** It is registered
   when the view opens, not derived from `getActiveViewOfType`, so a Typst
   editor in a background split still offers it.
3. **The action does nothing when the view has no file.** A `TypstEditorView`
   whose `file` is `null` — a leaf that has not opened a file yet — must not
   open a preview pointed at nothing.
4. **The file explorer offers the preview on a `.typ` file.** The `file-menu`
   event adds an `Open Typst preview` item for a `TFile` whose extension is
   `typ`, and activating it opens the preview for that file's path.
5. **The file item is scoped to Typst files.** No `Open Typst preview` item
   appears for a `TFile` of another extension, and none for a `TFolder`. The
   existing `New Typst file` folder item is unchanged, including its
   compilation-root gate.
6. **The file item is not gated on the compilation root.** It matches
   `open-typst-preview`, which opens a preview for any Typst file and lets the
   compile report the root problem. `New Typst file` gates on the root because
   creating a file outside it hands the user something nothing can compile;
   opening a preview only reports.
7. **Both entry points reuse the existing preview opener.** They route through
   the same code path as `open-typst-preview`, so a preview leaf is reused when
   one exists and split off when it does not.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`.
