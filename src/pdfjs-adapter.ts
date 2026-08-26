import {
  getDocument,
  PDFWorker,
  TextLayer,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist";
import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";

import type { PdfEngine, PdfLoadingTask, PdfTextLayerTask, PdfViewport } from "./pdf-preview-renderer";

export interface PdfJsApi {
  getDocument(options: {
    data: Uint8Array;
    isEvalSupported: boolean;
    useWorkerFetch: boolean;
    worker: PdfWorkerResource;
  }): PDFDocumentLoadingTask;
  TextLayer: typeof TextLayer;
  createMessageChannel(): PdfMessageChannel;
  createPdfWorker(port: PdfMessagePort): PdfWorkerResource;
  initializeWorkerFromPort(port: PdfMessagePort): void;
}

interface PdfMessagePort {
  start(): void;
  close(): void;
}

interface PdfMessageChannel {
  port1: PdfMessagePort;
  port2: PdfMessagePort;
}

interface PdfWorkerResource {
  destroy(): void | Promise<void>;
}

async function releaseWorker(
  worker: PdfWorkerResource | undefined,
  channel: PdfMessageChannel
): Promise<void> {
  try {
    await worker?.destroy();
  } catch {
    // Port ownership still has to be released when PDF.js worker cleanup fails.
  } finally {
    try { channel.port1.close(); } catch { /* already closed */ }
    try { channel.port2.close(); } catch { /* already closed */ }
  }
}

const PdfWorkerWithPort = PDFWorker as unknown as new (options: {
  port: PdfMessagePort;
}) => PDFWorker;

const defaultApi: PdfJsApi = {
  createMessageChannel: () => new MessageChannel(),
  createPdfWorker: (port) => new PdfWorkerWithPort({ port }),
  getDocument: (options) => getDocument({
    ...options,
    worker: options.worker as PDFWorker,
  }),
  initializeWorkerFromPort: (port) => {
    WorkerMessageHandler.initializeFromPort(port);
  },
  TextLayer,
};

export function createPdfJsEngine(api: PdfJsApi = defaultApi): PdfEngine {
  return {
    load(data) {
      const channel = api.createMessageChannel();
      let worker: PdfWorkerResource | undefined;
      let loadingTask: PDFDocumentLoadingTask;
      try {
        api.initializeWorkerFromPort(channel.port1);
        worker = api.createPdfWorker(channel.port2);
        channel.port1.start();
        channel.port2.start();
        loadingTask = api.getDocument({
          data,
          isEvalSupported: false,
          useWorkerFetch: false,
          worker,
        });
      } catch (error) {
        void releaseWorker(worker, channel);
        throw error;
      }
      let destroyPromise: Promise<void> | null = null;
      return {
        promise: loadingTask.promise as unknown as PdfLoadingTask["promise"],
        destroy() {
          destroyPromise ??= Promise.resolve(loadingTask.destroy())
            .finally(() => releaseWorker(worker, channel));
          return destroyPromise;
        },
      };
    },
    createTextLayer({ textContentSource, container, viewport }): PdfTextLayerTask {
      const layer = new api.TextLayer({
        textContentSource: textContentSource as never,
        container,
        viewport: viewport as never,
      });
      return {
        render: () => layer.render(),
        cancel: () => layer.cancel(),
      };
    },
  };
}

export type { PdfViewport };
