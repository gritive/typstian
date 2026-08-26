declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: {
    initializeFromPort(port: { close(): void }): void;
  };
}
