// These paths also resolve from the published dist/converter worker modules.
export const decoderUrl = new URL(
  "../../bin/decoder/decoder_bg.wasm",
  import.meta.url,
).href;
export const clusterUrl = new URL(
  "../../bin/decoder/cluster.wasm",
  import.meta.url,
).href;
