import { area } from "../rad/math.js";
import { PAGE_BYTES } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";

const bandRows = new Uint16Array(PAGE_BYTES / Uint16Array.BYTES_PER_ELEMENT);

function readBands(source, first, count, sh, dims) {
  if (source.maxSh === 1) {
    source.sh[0].consume(first * dims, sh, sh.length);
    return;
  }
  let offset = 0;
  for (let band = 0; band < source.maxSh; band++) {
    const width = SH_DIMS[band];
    const batch = Math.floor(bandRows.length / width);
    for (let base = 0; base < count; base += batch) {
      source.workspace.check();
      const rows = Math.min(batch, count - base);
      source.sh[band].consume((first + base) * width, bandRows, rows * width);
      for (let i = 0, from = 0; i < rows; i++) {
        const to = (base + i) * dims + offset;
        for (let d = 0; d < width; d++) sh[to + d] = bandRows[from++];
      }
    }
    offset += width;
  }
}

// gather() reuses one page-aligned buffer per encoder. Only SH clustering
// needs a weight for every row.
export function chunkBufferBytes(count, dims, blindCount, weigh) {
  const stride = 64 + dims * 2 + blindCount * 4 + (weigh ? 8 : 0);
  return Math.ceil((count * stride) / PAGE_BYTES) * PAGE_BYTES;
}

// Consume a contiguous chunk into its encoder's buffer.
export function gather(source, first, count, weigh, buffer, blind) {
  source.workspace.check();
  const dims = SH_DIMS.slice(0, source.maxSh).reduce((a, b) => a + b, 0);
  const weights = new Float64Array(buffer, 0, weigh ? count : 0);
  const records = new Float32Array(buffer, weights.byteLength, count * 16);
  const blindWords = new Uint32Array(
    buffer,
    records.byteOffset + records.byteLength,
    count * (blind?.textures.length ?? 0),
  );
  const sh = new Uint16Array(
    buffer,
    blindWords.byteOffset + blindWords.byteLength,
    count * dims,
  );
  source.records.consume(first * 16, records, records.length);
  readBands(source, first, count, sh, dims);
  if (weigh) {
    for (let i = 0; i < count; i++) {
      if ((i & 4095) === 0) source.workspace.check();
      weights[i] =
        records[i * 16 + 3] *
        area(
          Math.exp(records[i * 16 + 7]),
          Math.exp(records[i * 16 + 8]),
          Math.exp(records[i * 16 + 9]),
        );
    }
  }
  const blindTextures = blind?.pack(
    source.blindValues,
    first,
    count,
    blindWords,
  );
  return { records, sh, weights, dims, blindWords, blindTextures };
}
