export interface LccBounds {
  min: [number, number, number];
  max: [number, number, number];
}
export type LccFileType = "Portable" | "Quality";
export interface LccManifest {
  version: "5.0";
  encoding: "COMPRESS";
  fileType: LccFileType;
  totalSplats: number;
  totalLevel: number;
  indexDataSize: number;
  indexStride: number;
  cellLengthX: number;
  cellLengthY: number;
  splats: number[];
  boundingBox: LccBounds;
  maxShDegree: 0 | 3;
  environmentStride: 32 | 96;
  scaleRange: LccBounds;
  shRange?: LccBounds;
  environmentScaleRange?: LccBounds;
  environmentShRange?: LccBounds;
  /** Preserved metadata, including EPSG; no reprojection is applied. */
  [key: string]: unknown;
}
export interface LccParseOptions {
  maxManifestBytes?: number;
  maxLevels?: number;
  maxIndexBytes?: number;
  maxUnits?: number;
  /** Explicit compatibility override, only for missing fileType. */
  fileType?: LccFileType;
}
export interface LccRepresentation {
  level: number;
  count: number;
  offset: number;
  byteLength: number;
  shOffset?: number;
  shByteLength?: number;
}
export interface LccUnit {
  index: number;
  x: number;
  y: number;
  boundingBox: LccBounds;
  representations: LccRepresentation[];
}
export interface LccDecodeContext {
  version: "5.0";
  encoding: "COMPRESS";
  fileType: LccFileType;
  count: number;
  maxPoints: number;
  environment: boolean;
  scaleMin: [number, number, number];
  scaleMax: [number, number, number];
  shMin?: [number, number, number];
  shMax?: [number, number, number];
}
/** Bounded JSON text/UTF-8 parser. Rejects unverified global transforms. */
export function parseLccManifest(
  input: string | Uint8Array,
  options?: LccParseOptions,
): LccManifest;
export function parseLccIndex(
  input: ArrayBuffer | Uint8Array,
  manifest: LccManifest,
  options?: LccParseOptions & {
    dataByteLength?: number;
    shByteLength?: number;
  },
): LccUnit[];
/** Environment input is interleaved; pass an empty SH array to decodeLcc. */
export function createLccDecodeContext(
  manifest: LccManifest,
  count: number,
  options?: { environment?: boolean; maxPoints?: number },
): LccDecodeContext;
