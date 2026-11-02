import type { ReorderedSplatResult, SplatResult } from "../data/defines.js";
import type {
  SplatFileInput,
  SplatLoadArgs,
  SplatLoadStatus,
} from "./loadTypes.js";
/** Decode in source order so streamed SOG can extract file ranges first. */
export declare function decodeSplats(
  args: SplatLoadArgs,
  {
    sendStatus,
  }: {
    sendStatus: (data: SplatLoadStatus) => void;
  },
): Promise<SplatResult>;
export declare function loadSplats(
  args: SplatLoadArgs,
  options: {
    sendStatus: (data: SplatLoadStatus) => void;
  },
): Promise<ReorderedSplatResult>;
export declare function resolveFile({
  requestId,
  input,
}: {
  requestId: number;
  input: SplatFileInput;
}): void;
export declare function resolveAsset({
  requestId,
  url,
}: {
  requestId: number;
  url: string;
}): void;
