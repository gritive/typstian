import { resolveCompilerEntryPath } from "./path-policy";

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
  for (const buffer of buffers) {
    const compilerPath = resolveCompilerEntryPath(vaultRoot, compilationRoot, buffer.path);
    if (compilerPath === null) continue;
    overlay.set(compilerPath, encoder.encode(buffer.text));
  }
  return overlay;
}
