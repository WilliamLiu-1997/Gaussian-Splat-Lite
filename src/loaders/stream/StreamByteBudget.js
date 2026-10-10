/** Bound pending copies while allowing one oversized item to make progress. */
export class StreamByteBudget {
  constructor(limit, used = 0) {
    this.limit = limit;
    this.used = used;
  }
  reserve(bytes) {
    if (bytes === 0) return true;
    if (this.used > 0 && this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }
}
