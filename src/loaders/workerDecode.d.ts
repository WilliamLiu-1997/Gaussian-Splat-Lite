import type { ReorderedSplatResult, SplatResult } from "../data/defines.js";
import type {
  SplatFileInput,
  SplatLoadArgs,
  SplatLoadStatus,
} from "./loadTypes.js";
export interface DecoderLimits {
  maxPoints: number;
  maxInputBytes: number;
  maxDecoderBytes: number;
  maxWasmBytes: number;
}
export type BudgetedSplatLoadArgs = SplatLoadArgs & {
  decoderLimits?: DecoderLimits;
};
/** Decode in source order so streamed SOG can extract file ranges first. */
export declare function decodeSplats(
  args: BudgetedSplatLoadArgs,
  {
    sendStatus,
  }: {
    sendStatus: (data: SplatLoadStatus) => void;
  },
): Promise<SplatResult>;
export declare function loadSplats(
  args: BudgetedSplatLoadArgs,
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
