import { resolveCompilerEntryPath } from "./path-policy";

import {
  MAX_VAULT_INPUT_BYTES,
  MAX_VAULT_INPUT_FILE_BYTES,
} from "./wasm-vault-reader";

export interface DirtyBuffer {
  path: string;
  text: string;
}

export function collectDirtyBuffers(
  vaultRoot: string,
  compilationRoot: string,
  buffers: Iterable<DirtyBuffer>
): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const overlay = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const buffer of buffers) {
    const compilerPath = resolveCompilerEntryPath(vaultRoot, compilationRoot, buffer.path);
    if (compilerPath === null) continue;
    const bytes = encoder.encode(buffer.text);
    if (bytes.byteLength > MAX_VAULT_INPUT_FILE_BYTES) {
      throw new Error(
        `Dirty Typst buffer ${buffer.path} exceeded the 50 MiB file limit.`
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_VAULT_INPUT_BYTES) {
      throw new Error("Dirty Typst buffers exceeded the 70 MiB aggregate limit.");
    }
    overlay.set(compilerPath, bytes);
  }
  return overlay;
}
