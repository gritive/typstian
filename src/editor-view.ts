import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { TextFileView, type WorkspaceLeaf } from "obsidian";

import { typstLanguage } from "./language";

export const TYPST_VIEW_TYPE = "typst-editor";

export interface TypstForwardSearchRequest {
  sourcePath: string;
  sourceText: string;
  byteOffset: number;
}

export interface TypstEditorViewOptions {
  onDirty?: () => void;
  onForwardSearch?: (request: TypstForwardSearchRequest) => void;
  onClose?: () => void;
}

export function utf8ByteOffset(sourceText: string, position: number): number | null {
  if (!Number.isSafeInteger(position) || position < 0 || position > sourceText.length) return null;
  if (
    position > 0
    && position < sourceText.length
    && /[\uD800-\uDBFF]/u.test(sourceText[position - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(sourceText[position] ?? "")
  ) {
    return null;
  }
  return new TextEncoder().encode(sourceText.slice(0, position)).length;
}

const editorExtensions: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  // Obsidian's own find bar never reaches a custom TextFileView, so this view
  // carries its own search panel.
  search(),
  // Search binds ahead of the defaults so Escape closes the panel instead of
  // being eaten by the selection-simplifying Escape in `defaultKeymap`.
  keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
  highlightActiveLine(),
  EditorView.lineWrapping,
  typstLanguage,
];

export class TypstEditorView extends TextFileView {
  readonly editorView: EditorView;
  private readonly onDirty: () => void;
  private applyingExternalData = false;

  private readonly onForwardSearch: (request: TypstForwardSearchRequest) => void;
  private readonly onClosed: () => void;
  private dirty = false;
  private editGeneration = 0;
  constructor(leaf: WorkspaceLeaf, options: TypstEditorViewOptions = {}) {
    super(leaf);
    this.onDirty = options.onDirty ?? (() => undefined);
    this.onForwardSearch = options.onForwardSearch ?? (() => undefined);
    this.onClosed = options.onClose ?? (() => undefined);
    this.contentEl.classList.add("typstian-editor");
    this.editorView = new EditorView({
      parent: this.contentEl,
      state: this.createState(""),
    });
  }

  getViewType(): string {
    return TYPST_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? "Typst editor";
  }

  override getViewData(): string {
    return this.editorView.state.doc.toString();
  }

  markSaved(data: string): boolean {
    if (data !== this.getViewData()) return false;
    this.dirty = false;
    return true;
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  canDiscardUncommittedOpen(): boolean {
    return !this.dirty && this.editGeneration === 0;
  }

  override setViewData(data: string, clear: boolean): void {
    if (clear) {
      this.editorView.setState(this.createState(data));
      this.editGeneration = 0;
    } else if (data !== this.getViewData()) {
      this.applyingExternalData = true;
      try {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: data },
        });
      } finally {
        this.applyingExternalData = false;
      }
    }
    this.data = data;
    this.dirty = false;
  }

  override clear(): void {
    this.editorView.setState(this.createState(""));
    this.data = "";
    this.editGeneration = 0;
  }

  revealDiagnostic(line: number, column: number): void {
    const document = this.editorView.state.doc;
    const lineNumber = Math.min(Math.max(Math.trunc(line), 1), document.lines);
    const targetLine = document.line(lineNumber);
    const columnOffset = Math.min(
      Math.max(Math.trunc(column) - 1, 0),
      targetLine.length,
    );

    this.editorView.dispatch({
      selection: { anchor: targetLine.from + columnOffset },
      scrollIntoView: true,
    });
    this.editorView.focus();
  }

  revealByteOffset(byteOffset: number): boolean {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return false;
    const encoded = new TextEncoder().encode(this.editorView.state.doc.toString());
    if (byteOffset > encoded.length) return false;

    let position: number;
    try {
      position = new TextDecoder("utf-8", { fatal: true })
        .decode(encoded.subarray(0, byteOffset)).length;
    } catch {
      return false;
    }

    this.editorView.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    });
    this.editorView.focus();
    return true;
  }

  override onClose(): Promise<void> {
    this.onClosed();
    this.editorView.destroy();
    return Promise.resolve();
  }

  private createState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        editorExtensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.applyingExternalData) {
            this.data = update.state.doc.toString();
            this.dirty = true;
            this.editGeneration += 1;
            this.onDirty();
            this.requestSave();
          }

          const pointerSelection = update.transactions.some(
            (transaction) => transaction.isUserEvent("select.pointer"),
          );
          if (
            !pointerSelection
            || this.file?.extension !== "typ"
            || this.dirty
          ) {
            return;
          }

          const sourceText = update.state.doc.toString();
          const byteOffset = utf8ByteOffset(
            sourceText,
            update.state.selection.main.head,
          );
          if (byteOffset === null) return;
          this.onForwardSearch({
            sourcePath: this.file.path,
            sourceText,
            byteOffset,
          });
        }),
      ],
    });
  }
}
