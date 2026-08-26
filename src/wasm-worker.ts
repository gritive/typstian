import init, { TypstianWasmSession } from "../helper/wasm/pkg/typstian_wasm.js";

type WorkerMethod =
  | "initialize"
  | "register-font"
  | "environment"
  | "compile"
  | "jump"
  | "forward";

interface WorkerRequest {
  type: "request";
  id: number;
  method: WorkerMethod;
  payload: unknown;
}

interface InputResponse {
  type: "inputs";
  batchId: number;
  files: Array<{
    kind: "vault" | "font";
    path: string;
    bytes: ArrayBuffer | null;
  }>;
  done?: boolean;
  error?: string;
}

interface WorkerDispatchResult {
  value: unknown;
  transfer?: Transferable[];
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest | InputResponse>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const MAX_INPUT_PATHS = 10_000;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const sleep = new Map<number, (message: InputResponse) => void>();
let previousPaths = new Set<string>();
let previousFontPaths = new Set<string>();
let session: TypstianWasmSession | undefined;
let batchId = 0;
let outputLimitBytes: number | undefined;

scope.addEventListener("message", (event: MessageEvent<WorkerRequest | InputResponse>) => {
  const message = event.data;
  if (message.type === "inputs") {
    sleep.get(message.batchId)?.(message);
    return;
  }
  void handleRequest(message);
});

function exceedsUtf8Limit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800
      && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

function boundedOutput(value: string): string {
  const limit = outputLimitBytes;
  if (limit === undefined) {
    throw new Error("Typstian WASM worker is not initialized.");
  }
  if (exceedsUtf8Limit(value, limit)) {
    throw new Error("Typstian compiler output exceeded its limit.");
  }
  return value;
}

function workerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const limit = outputLimitBytes;
  return limit !== undefined && exceedsUtf8Limit(message, limit)
    ? "Typstian compiler output exceeded its limit."
    : message;
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    const result = await dispatch(request.method, request.payload);
    scope.postMessage(
      { type: "response", id: request.id, ok: true, value: result.value },
      result.transfer,
    );
  } catch (error) {
    scope.postMessage({
      type: "response",
      id: request.id,
      ok: false,
      error: workerErrorMessage(error),
    });
  }
}

async function dispatch(
  method: WorkerMethod,
  payload: unknown,
): Promise<WorkerDispatchResult> {
  if (method === "initialize") {
    const initialization = payload as {
      module: WebAssembly.Module;
      maxOutputBytes: unknown;
    };
    if (
      !Number.isSafeInteger(initialization.maxOutputBytes)
      || (initialization.maxOutputBytes as number) <= 0
    ) {
      throw new Error("Typstian compiler output limit is invalid.");
    }
    outputLimitBytes = initialization.maxOutputBytes as number;
    await init({ module_or_path: initialization.module });
    session = new TypstianWasmSession();
    return { value: undefined };
  }

  const activeSession = session;
  if (activeSession === undefined) throw new Error("Typstian WASM worker is not initialized.");

  if (method === "register-font") {
    const font = payload as { path: string; bytes: ArrayBuffer };
    const bytes = new Uint8Array(font.bytes);
    return { value: activeSession.register_font(font.path, bytes) };
  }
  if (method === "environment") {
    return { value: boundedOutput(activeSession.environment()) };
  }
  if (method === "jump") {
    return { value: boundedOutput(activeSession.jump(JSON.stringify(payload))) };
  }
  if (method === "forward") {
    return { value: boundedOutput(activeSession.forward(JSON.stringify(payload))) };
  }
  return compile(activeSession, payload as { revision: number; entryPath: string });
}

function decodeCompileResult(value: unknown): WorkerDispatchResult {
  if (typeof value === "string") {
    const responseText = boundedOutput(value);
    const parsed = JSON.parse(responseText) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Typstian compiler returned an invalid response.");
    }
    if ((parsed as Record<string, unknown>).type === "compiled") {
      throw new Error("Typstian compiler returned a text-encoded PDF artifact.");
    }
    return { value: parsed };
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Typstian compiler returned an invalid response.");
  }
  const response = value as Record<string, unknown>;
  const pdfBuffer = response.pdfBuffer;
  const declaredBytes = response.pdfBytes;
  if (
    response.type !== "compiled"
    || !(pdfBuffer instanceof ArrayBuffer)
    || !Number.isSafeInteger(declaredBytes)
    || (declaredBytes as number) <= 0
    || (declaredBytes as number) > MAX_PDF_BYTES
    || pdfBuffer.byteLength !== declaredBytes
  ) {
    throw new Error("Typstian compiler returned an invalid PDF artifact.");
  }
  boundedOutput(JSON.stringify(response));
  return { value: response, transfer: [pdfBuffer] };
}

async function compile(
  activeSession: TypstianWasmSession,
  request: { revision: number; entryPath: string },
): Promise<WorkerDispatchResult> {
  const fileCache = new Map<string, Uint8Array | null>();
  const fontCache = new Map<string, Uint8Array | null>();
  const currentPaths = new Set<string>();
  const currentFontPaths = new Set<string>();
  const missing = new Set<string>();
  const missingFonts = new Set<string>();
  const readFile = (path: string): Uint8Array | undefined => {
    currentPaths.add(path);
    if (fileCache.has(path)) return fileCache.get(path) ?? undefined;
    missing.add(path);
    return undefined;
  };
  const readFont = (path: string): Uint8Array | undefined => {
    currentFontPaths.add(path);
    if (fontCache.has(path)) return fontCache.get(path) ?? undefined;
    missingFonts.add(path);
    return undefined;
  };

  if (previousPaths.size > 0 || previousFontPaths.size > 0) {
    await requestInputs(
      Array.from(previousPaths),
      Array.from(previousFontPaths),
      fileCache,
      fontCache,
    );
  }

  while (true) {
    missing.clear();
    missingFonts.clear();
    const result: unknown = activeSession.compile(
      JSON.stringify({ revision: request.revision, entry: request.entryPath }),
      readFile,
      readFont,
    );
    if (missing.size === 0 && missingFonts.size === 0) {
      previousPaths = currentPaths;
      previousFontPaths = currentFontPaths;
      return decodeCompileResult(result);
    }
    if (currentPaths.size + currentFontPaths.size > MAX_INPUT_PATHS) {
      throw new Error("Typstian compiler requested too many inputs.");
    }
    await requestInputs(
      Array.from(missing),
      Array.from(missingFonts),
      fileCache,
      fontCache,
    );
    const unresolved = Array.from(missing).some((path) => !fileCache.has(path))
      || Array.from(missingFonts).some((path) => !fontCache.has(path));
    if (unresolved) {
      throw new Error("Typstian compiler input provider made no progress.");
    }
  }
}

function requestInputs(
  vaultPaths: string[],
  fontPaths: string[],
  fileCache: Map<string, Uint8Array | null>,
  fontCache: Map<string, Uint8Array | null>,
): Promise<void> {
  const currentBatch = ++batchId;
  return new Promise((resolve, reject) => {
    sleep.set(currentBatch, (message) => {
      if (typeof message.error === "string") {
        sleep.delete(currentBatch);
        reject(new Error(message.error));
        return;
      }
      for (const file of message.files) {
        const cache = file.kind === "font" ? fontCache : fileCache;
        cache.set(
          file.path,
          file.bytes === null ? null : new Uint8Array(file.bytes),
        );
      }
      if (message.done === true) {
        sleep.delete(currentBatch);
        resolve();
      }
    });
    scope.postMessage({
      type: "need-inputs",
      batchId: currentBatch,
      vaultPaths,
      fontPaths,
    });
  });
}
