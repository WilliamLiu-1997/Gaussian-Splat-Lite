/** Shared admission rule for uploads and pending copies. */
export class StreamByteBudget {
  constructor(
    readonly limit: number,
    public used = 0,
  ) {}

  reserve(bytes: number) {
    if (bytes === 0) return true;
    if (this.used > 0 && this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }
}
