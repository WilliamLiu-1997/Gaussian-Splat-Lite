import { halfBits } from "../rad/math.js";
import { PagedArray } from "../rad/storage.js";

const bytes = {
  u8: 1,
  u16: 2,
  u24: 3,
  u32: 4,
  f16: 2,
  f32: 4,
  unorm8: 1,
  unorm16: 2,
};
const float = new Float32Array(1);
const bits = new Uint32Array(float.buffer);
const integerType = (max) =>
  max < 256 ? "u8" : max < 65536 ? "u16" : max < 16777216 ? "u24" : "u32";

export function parseBlind(values = []) {
  const names = new Set();
  const textures = values.map((value) => {
    const fields = value.split(/,(?![^\[]*\])/).map((text) => {
      const match =
        /^([^\s:,\[\]]+)(?::(u8|u16|u24|u32|f16|f32|unorm8|unorm16)(?:\[([^,]+),([^\]]+)\])?)?$/.exec(
          text.trim(),
        );
      if (!match) throw new Error(`Invalid --sog-blind field: ${text}`);
      const [, name, type, low, high] = match;
      const id = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (!id || names.has(id))
        throw new Error(`Empty or duplicate Blind field identifier: ${name}`);
      names.add(id);
      const field = { name, type };
      if (low !== undefined) {
        const range = [Number(low), Number(high)];
        if (
          !type.startsWith("unorm") ||
          !range.every(Number.isFinite) ||
          range[0] >= range[1] ||
          !Number.isFinite(range[1] - range[0])
        )
          throw new Error(`Invalid Blind range: ${text}`);
        field.range = range;
      }
      return field;
    });
    if (fields.reduce((size, field) => size + (bytes[field.type] ?? 1), 0) > 4)
      throw new Error("Each --sog-blind flag must fit in four bytes");
    return fields;
  });
  if (textures.length > 8)
    console.warn(
      "More than eight Blind textures may exceed some viewers' texture limits",
    );
  return textures;
}

function encoder({ name, type = "u32", range = [0, 1] }) {
  if (type === "f16") return halfBits;
  if (type === "f32")
    return (value) => {
      float[0] = value;
      return bits[0];
    };
  const limit = 2 ** (8 * bytes[type]) - 1;
  if (type.startsWith("unorm")) {
    const [min, max] = range;
    const span = max - min;
    // PLY float values can round just outside a decimal range endpoint.
    const lower = Math.min(min, Math.fround(min));
    const upper = Math.max(max, Math.fround(max));
    return (value) => {
      if (!(value >= lower && value <= upper))
        throw new Error(`Blind field ${name}: ${value} is outside [${range}]`);
      return Math.round(
        ((Math.min(Math.max(value, min), max) - min) / span) * limit,
      );
    };
  }
  return (value) => {
    if (!Number.isInteger(value) || value < 0 || value > limit)
      throw new Error(
        `Blind field ${name}: ${value} does not fit ${type}; specify a suitable encoding`,
      );
    return value;
  };
}

// Encoded fields follow the input's row order; LODs keep row references.
// Only the current decode batch keeps Float64 values, until geometric filtering.
export class BlindInput {
  constructor(workspace, textures, batchSize) {
    this.textures = textures;
    this.fields = textures.flat();
    this.encoders = this.fields.map(encoder);
    this.automatic = this.fields.flatMap((field, i) => (field.type ? [] : [i]));
    this.maxima = new Uint32Array(this.fields.length);
    this.layout = this.automatic.length ? undefined : this.resolveLayout([]);
    this.values = new PagedArray(workspace, Uint32Array);
    this.row = new Uint32Array(this.fields.length);
    this.batch = new Uint32Array(batchSize * this.fields.length);
    this.pending = new Float64Array(0);
    this.base = 0;
  }

  receive(base, values) {
    if (this.pending.length < values.length) {
      const capacity = Math.max(values.length, this.pending.length * 2);
      this.pending = new Float64Array(capacity);
    }
    this.pending.set(values);
    this.base = base;
  }

  keep(index, slot) {
    const { encoders, batch, automatic, maxima } = this;
    const width = encoders.length;
    const offset = (index - this.base) * width;
    for (let i = 0; i < width; i++)
      batch[slot * width + i] = encoders[i](this.pending[offset + i]);
    for (const i of automatic)
      maxima[i] = Math.max(maxima[i], batch[slot * width + i]);
  }

  flush(base, count) {
    const width = this.fields.length;
    this.values.write(base * width, this.batch, count * width);
  }

  resolveLayout(maxima) {
    const shifts = new Uint8Array(this.fields.length);
    let column = 0;
    const textures = this.textures.map((fields) => {
      let size = 0;
      const resolved = fields.map((field) => {
        const type = field.type ?? integerType(maxima[column]);
        shifts[column++] = size * 8;
        size += bytes[type];
        return { ...field, type };
      });
      if (size > 4)
        throw new Error(
          "Blind fields exceed four bytes; split them across --sog-blind flags",
        );
      return {
        fields: resolved,
        end: column,
        padding: size < 4 ? 0xff000000 : 0,
      };
    });
    return { textures, shifts, fields: textures.map(({ fields }) => fields) };
  }

  gather(places, rowIndex, words) {
    const { fields, row, automatic } = this;
    const count = places.length;
    let layout = this.layout;
    if (!layout) {
      const maxima = new Uint32Array(fields.length);
      for (const place of places) {
        this.values.read(rowIndex(place) * fields.length, row);
        for (const i of automatic) maxima[i] = Math.max(maxima[i], row[i]);
      }
      layout = this.resolveLayout(maxima);
    }
    const { textures, shifts } = layout;
    for (const place of places) {
      this.values.read(rowIndex(place) * fields.length, row);
      let column = 0;
      for (let texture = 0; texture < textures.length; texture++) {
        const { end, padding } = textures[texture];
        let word = padding;
        for (; column < end; column++) word |= row[column] << shifts[column];
        words[texture * count + place] = word;
      }
    }
    return layout.fields;
  }

  dispose() {
    this.values.dispose();
  }
}
