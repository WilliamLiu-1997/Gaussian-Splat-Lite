import { fromHalf, uintBitsToFloat } from "../utils/numeric.js";

const TYPES = {
  u8: [1, 0],
  u16: [2, 0],
  u24: [3, 0],
  u32: [4, 0],
  f16: [2, 1],
  f32: [4, 2],
  unorm8: [1, 3],
  unorm16: [2, 3],
};
const layouts = new WeakMap();

// Decoded field definitions stay fixed for the lifetime of their source.
export function getBlindFieldLayout(fields) {
  let layout = layouts.get(fields);
  if (layout) return layout;
  const lookup = new Map();
  let offset = 0;
  for (const { name, type, range } of fields) {
    const format = TYPES[type];
    if (!format) break;
    const [bytes, encoding] = format;
    lookup.set(name, {
      shift: offset * 8,
      mask: 2 ** (bytes * 8) - 1,
      encoding,
      range: range ?? [0, 1],
    });
    offset += bytes;
  }
  layout = { lookup, key: JSON.stringify(fields) };
  layouts.set(fields, layout);
  return layout;
}

export function getBlindLayoutKey(blind = []) {
  return `[${blind.map(({ fields }) => getBlindFieldLayout(fields).key).join(",")}]`;
}

export function decodeBlindFields(blind, index) {
  if (!blind?.length) return;
  const values = new Map();
  for (const { fields, data } of blind) {
    const word = data[index];
    for (const [name, { shift, mask, encoding, range }] of getBlindFieldLayout(
      fields,
    ).lookup) {
      // Match SplatEditBlindField's first group when a name occurs more than once.
      if (values.has(name)) continue;
      const bits = ((word >>> shift) & mask) >>> 0;
      let value = bits;
      if (encoding === 1) value = fromHalf(bits);
      else if (encoding === 2) value = uintBitsToFloat(bits);
      else if (encoding === 3)
        value = range[0] + (range[1] - range[0]) * (bits / mask);
      values.set(name, value);
    }
  }
  return Object.fromEntries(values);
}
