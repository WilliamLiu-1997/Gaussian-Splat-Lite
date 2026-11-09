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
