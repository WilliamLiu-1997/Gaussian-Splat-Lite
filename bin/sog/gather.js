import { sharedBuffer } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";
import { ellipsoidAreaFromScales } from "./voxel/extents.js";

// The most places that fit beside a row in a number: a row is below 2^32.
const PLACES = 2 ** 21;
// The places of a chunk's splats sorted by row, kept from chunk to chunk:
// as garbage, each chunk's would take room from the cache until collected.
let sorted = new Float64Array(0);

function sortPlaces(places, index) {
  if (places.length > PLACES) {
    places.sort((a, b) => index(a) - index(b));
    return;
  }
  for (let i = 0; i < places.length; i++) places[i] = index(i) * PLACES + i;
  places.sort();
  // PLACES is a power of two: the quotient is exact.
  for (let i = 0; i < places.length; i++)
    places[i] -= Math.floor(places[i] / PLACES) * PLACES;
}

// Bytes of a gathered splat with SH of `dims` coefficients: its record, its
// SH clustering weight and its SH as half bits.
export const chunkRowBytes = (dims, blindCount = 0) =>
  72 + dims * 2 + blindCount * 4;

// Shared memory for a thread's chunks of up to `count` splats, like a
// simplifier's blocks: gather() fills it chunk after chunk and the thread
// reads it in place. Arrays made for each chunk stayed in memory: handed
// over, as freed heap on macOS; shared, until this thread collected its own
// reference to them, which it rarely does.
export const chunkBuffer = (count, dims, blindCount = 0) =>
  sharedBuffer(count * chunkRowBytes(dims, blindCount));

// Reads the splats `order` of `source` into arrays in `buffer`, each splat
// at its place in `order`; see chunkBuffer(). With `weigh`, also each
// splat's SH clustering weight.
export function gather(source, order, weigh, buffer, blind) {
  const count = order.length;
  const dims = SH_DIMS.slice(0, source.maxSh).reduce((a, b) => a + b, 0);
  const weightBytes = weigh ? count * 8 : 0;
  const recordBytes = count * 64;
  const weights = new Float64Array(buffer, 0, weigh ? count : 0);
  const records = new Float32Array(buffer, weightBytes, count * 16);
  const blindWords = new Uint32Array(
    buffer,
    weightBytes + recordBytes,
    count * (blind?.textures.length ?? 0),
  );
  const sh = new Uint16Array(
    buffer,
    weightBytes + recordBytes + blindWords.byteLength,
    count * dims,
  );
  // Pages are read in the order of the rows: the places sorted by row, as
  // numbers of row and place where those fit.
  let places;
  if (count <= PLACES) {
    if (sorted.length < count) sorted = new Float64Array(count);
    places = sorted.subarray(0, count);
  } else {
    places = Uint32Array.from(order, (_, i) => i);
  }
  sortPlaces(places, (i) => order[i]);
  for (let i = 0; i < count; i++) {
    const place = places[i];
    const index = order[place];
    source.records.read(index * 16, records, 16, place * 16);
    if (weigh)
      weights[place] =
        records[place * 16 + 3] *
        ellipsoidAreaFromScales(
          Math.exp(records[place * 16 + 7]),
          Math.exp(records[place * 16 + 8]),
          Math.exp(records[place * 16 + 9]),
        );
    if (dims) {
      let offset = place * dims;
      for (let band = 0; band < source.maxSh; band++) {
        const size = SH_DIMS[band];
        source.sh[band].read(index * size, sh, size, offset);
        offset += size;
      }
    }
  }
  let blindTextures;
  if (blind) {
    const rowIndex = source.blind
      ? (i) => order[i]
      : (i) => records[i * 16 + 14] + records[i * 16 + 15] * 65536;
    // Input records and Blind rows already share the same order.
    if (!source.blind) sortPlaces(places, rowIndex);
    blindTextures = blind.gather(places, rowIndex, blindWords);
  }
  return { records, sh, weights, dims, blindWords, blindTextures };
}
