import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "./defines.js";
import { getTextureSize } from "./textureLayout.js";

/** Pack ordinary sources before transfer; reuse already aligned, owned storage. */
export function packBlindData(blind, count, capacity) {
  if (!blind?.length) return;
  const { depth, maxSplats } = getTextureSize(capacity * blind.length);
  if (depth > 256) throw new Error("Blind data exceeds texture array capacity");
  const buffer = blind[0].data.buffer;
  if (
    buffer.byteLength === maxSplats * 4 &&
    blind.every(
      ({ data }, index) =>
        data.buffer === buffer &&
        data.byteOffset === index * capacity * 4 &&
        data.length === capacity,
    )
  )
    return;
  const packed = new Uint32Array(maxSplats);
  blind.forEach((group, index) => {
    const data = packed.subarray(index * capacity, (index + 1) * capacity);
    data.set(group.data.subarray(0, count));
    group.data = data;
  });
}

/** Keep streaming uploads small while fitting all fields in one texture array. */
export function getBlindTextureLayout(capacity, groups, sourceLayerSize) {
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    sourceLayerSize / width,
    2 ** Math.ceil(Math.log2(Math.ceil((capacity * groups) / (256 * width)))),
  );
  if (height > SPLAT_TEX_HEIGHT)
    throw new Error("Blind data exceeds texture array capacity");
  const depth = Math.ceil((capacity * groups) / (width * height));
  return { width, height, depth, maxSplats: width * height * depth };
}

export function getBlindLayerUpdates(
  capacity,
  groups,
  start,
  count,
  layerSize,
) {
  const layers = new Set();
  for (let group = 0; group < groups; group++) {
    const base = group * capacity + start;
    const end = Math.ceil((base + count) / layerSize);
    for (let layer = Math.floor(base / layerSize); layer < end; layer++)
      layers.add(layer);
  }
  return layers;
}

/** Additional Blind upload bytes for source layers in [firstLayer, lastLayer). */
export function getBlindUploadBytes(
  capacity,
  groups,
  sourceLayerSize,
  firstLayer,
  lastLayer,
  dirtyLayers,
) {
  if (!groups) return 0;
  const { width, height } = getBlindTextureLayout(
    capacity,
    groups,
    sourceLayerSize,
  );
  const layerSize = width * height;
  const layers = getBlindLayerUpdates(
    capacity,
    groups,
    firstLayer * sourceLayerSize,
    (lastLayer - firstLayer) * sourceLayerSize,
    layerSize,
  );
  let bytes = 0;
  for (const layer of layers)
    if (!dirtyLayers?.has(layer)) bytes += layerSize * 4;
  return bytes;
}
