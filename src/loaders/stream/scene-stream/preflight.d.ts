export declare function preflightScenePayload(
  bytes: Uint8Array,
  codec: string,
  declaredCount: number,
  signal?: AbortSignal,
  limits?: { maxPoints?: number; maxInputBytes?: number },
): Promise<number>;
export declare function validateSceneDecodedSource(
  data: { numSplats: number; sourceIds?: Uint32Array },
  expectedCount: number,
): void;
