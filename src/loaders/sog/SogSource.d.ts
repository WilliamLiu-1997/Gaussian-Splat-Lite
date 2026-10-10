import type { SplatSourceArgs } from "../loadTypes.js";
import type { ByteSource as Source } from "../source.js";
export declare function openSogSource(
  args: SplatSourceArgs,
  progress: (bytes: number, total?: number) => void,
  signal: AbortSignal,
): Promise<Source>;
/** Resolve and read an external property image; ZIP entries stay with the archive reader. */
export declare function readSogAsset(
  name: string,
  args: SplatSourceArgs,
  sourceUrl: string | undefined,
  progress: (bytes: number) => void,
  signal: AbortSignal,
): Promise<Uint8Array[]>;
