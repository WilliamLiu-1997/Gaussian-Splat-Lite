/** Bound pending copies while allowing one oversized item to make progress. */
export declare class StreamByteBudget {
  readonly limit: number;
  used: number;
  constructor(limit: number, used?: number);
  reserve(bytes: number): boolean;
}
