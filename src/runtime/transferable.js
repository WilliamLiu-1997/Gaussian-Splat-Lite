// Recursively finds all ArrayBuffers in an object for structured-clone transfer.
export function getTransferable(ctx) {
  const buffers = new Set();
  const seen = new Set();
  function traverse(obj) {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    seen.add(obj);
    if (obj instanceof ArrayBuffer) {
      buffers.add(obj);
    } else if (ArrayBuffer.isView(obj)) {
      buffers.add(obj.buffer);
    } else {
      Object.values(obj).forEach(traverse);
    }
  }
  traverse(ctx);
  return [...buffers];
}
