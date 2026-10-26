/**
 * Streaming groups list sources whose written layers await upload. The Splat
 * renderer finds the list while walking the scene and uploads before drawing,
 * so storage reaches the GPU when written rather than on first display.
 */
export const PENDING_UPLOADS = Symbol("gslPendingUploads");
const MAX_PENDING_UPLOAD_BYTES = 24 * 1024 * 1024;
/** Upload budget until the scheduler's dirty layers are submitted. */
export class PendingUploads extends Set {
  constructor(group) {
    super();
    group[PENDING_UPLOADS] = this;
  }
  get byteLength() {
    let bytes = 0;
    for (const source of this) bytes += source.pendingUploadBytes;
    return bytes;
  }
  canAdd(bytes) {
    if (bytes === 0) return true;
    const pending = this.byteLength;
    // One indivisible oversized write can progress when no uploads are pending.
    return pending === 0 || pending + bytes <= MAX_PENDING_UPLOAD_BYTES;
  }
}
