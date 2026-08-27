import { vi } from "vitest";

import type { PdfDocumentHandle, PdfEngine, PdfPageHandle } from "../src/pdf-preview-renderer";

export function makePdfEngine(pageCount = 0) {
  const destroy = vi.fn(() => Promise.resolve());
  const pages: PdfPageHandle[] = Array.from({ length: pageCount }, () => ({
    getViewport: ({ scale }) => ({
      width: 600 * scale,
      height: 800 * scale,
      rotation: 0,
      viewBox: [0, 0, 600, 800],
      convertToPdfPoint: (x, y) => [x / scale, 800 - y / scale]
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(() => Promise.resolve({ items: [] })),
    cleanup: vi.fn()
  }));
  const document: PdfDocumentHandle = {
    numPages: pages.length,
    getPage: vi.fn((page) => Promise.resolve(pages[page - 1]!))
  };
  const load = vi.fn((data: Uint8Array) => {
    void data;
    return { promise: Promise.resolve(document), destroy };
  });
  const engine: PdfEngine = {
    load,
    createTextLayer: vi.fn(() => ({ render: () => Promise.resolve(), cancel: vi.fn() }))
  };
  return { engine, load, destroy, pages };
}

export function setElementRect(element: HTMLElement, width: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({})
  });
}
