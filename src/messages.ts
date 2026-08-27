import type { CompilationRootProblem } from "./path-policy";

export const MESSAGES = {
  commands: {
    createTypstFile: "Create a Typst file",
    openPreview: "Open Typst preview",
    savePdf: "Save the compiled PDF to the vault",
    checkEnvironment: "Check Typst environment",
    newTypstFile: "New Typst file",
  },
  editor: {
    title: "Typst editor",
  },
  preview: {
    title: "Typst preview",
    unableToRender: "Unable to render the compiled PDF.",
    idle: "Open a Typst file to preview it.",
    compiling: "Compiling Typst document…",
    failedUnexpectedly: "Typst preview failed unexpectedly.",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    fit: "Fit",
    fitTitle: "Fit pages to the preview width",
    save: "Save",
    saving: "Saving…",
  },
  pdf: {
    pageError: "Could not render PDF page.",
    retry: "Retry",
    source: "Source",
  },
  settings: {
    compilationRoot: "Compilation root",
    rootPlaceholder: "projects/book",
    rootDescription: "Optional path relative to the vault. Empty uses the vault root.",
    rootReady: "Ready: this folder is inside the vault.",
  },
  status: {
    compiling: "Typst: compiling…",
    idle: "Typst: idle",
    failed: "Typst: failed",
  },
  notices: {
    tooManyUntitled: "Too many untitled Typst files sit in this folder; rename some and try again.",
    entryOutsideRoot: "The Typst entry file must be inside the configured compilation root.",
    sourceUnreadable: "Unable to read the Typst source to reveal the matching spot in the preview.",
    saveBeforeReveal: "Save the Typst file to reveal the matching spot in the preview.",
    openPreviewBeforeReveal: "Open a preview of this Typst source to reveal the matching spot in it.",
    sourceOutsideRoot: "The Typst source must be inside the configured compilation root.",
    staleSourceLocation: "That source location is no longer valid for the current file.",
    sourceOutsideVault: "The source location points outside this vault.",
    compilerUnavailable: "Unable to initialize the bundled Typstian WASM compiler.",
    tooManySavedPdfs: "Too many saved PDFs sit beside this Typst file; remove some and try again.",
  },
} as const;

export const COMPILATION_ROOT_PROBLEM: Record<CompilationRootProblem, string> = {
  "missing": "No folder at this path yet. Create it, or type a path that exists.",
  "not-a-folder": "This path is a file, not a folder. Type the path of a folder instead.",
  "broken-link": "This link points at nothing. Fix the link, or type another path.",
  "unreadable": "This path cannot be read. Check its permissions, or type another path.",
  "outside-vault": "This path leaves the vault. Type a path inside the vault instead.",
};

export const previewTitle = (sourcePath: string | null): string => sourcePath === null
  ? MESSAGES.preview.title
  : `${MESSAGES.preview.title}: ${sourcePath.split("/").at(-1) ?? sourcePath}`;

export const failedCompileStatus = (errorCount: number): string =>
  `${MESSAGES.status.failed} (${errorCount} ${errorCount === 1 ? "error" : "errors"})`;

export const diagnosticText = (
  path: string,
  line: number,
  column: number,
  message: string,
): string => `${path}:${line}:${column} — ${message}`;

export const diagnosticLabel = (
  path: string,
  line: number,
  column: number,
  message: string,
): string => `Go to ${path}, line ${line}, column ${column}: ${message}`;

export const pdfPageLabel = (page: number): string => `PDF page ${page}`;
export const pdfTextLayerLabel = (page: number): string => `Selectable text for PDF page ${page}`;
export const pdfSourceLabel = (page: number): string => `Jump to source from PDF page ${page}`;
export const pdfRetryLabel = (page: number): string => `Retry PDF page ${page}`;

export const createFailedNotice = (path: string, reason: string): string =>
  `Unable to create ${path}: ${reason}`;
export const sourceNotFoundNotice = (path: string): string => `Typst source not found: ${path}`;
export const environmentNotice = (version: string, root: string): string =>
  `Typstian WASM compiler; Typst ${version}\nRoot: ${root}`;
export const savedPdfNotice = (path: string): string => `Saved the compiled PDF to ${path}`;
export const savePdfFailedNotice = (path: string): string =>
  `Unable to save the compiled PDF to ${path}`;
