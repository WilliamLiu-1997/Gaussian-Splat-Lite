import type { SplatBlindField, SplatBlindTexture } from "./defines.js";

export declare function getBlindFieldLayout(fields: SplatBlindField[]): {
  lookup: Map<
    string,
    { shift: number; mask: number; encoding: number; range: [number, number] }
  >;
  key: string;
};
export declare function getBlindLayoutKey(blind?: SplatBlindTexture[]): string;
