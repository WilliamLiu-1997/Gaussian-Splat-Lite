const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16 = supportsFloat16Array
  ? new globalThis["Float16Array" as keyof typeof globalThis](1)
  : null;
const u16 = new Uint16Array(f16?.buffer);

function toHalfNative(value: number): number {
  f16[0] = value;
  return u16[0];
}

function toHalfJs(value: number): number {
  f32[0] = value;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const fraction = bits & 0x7f_ffff;

  if (exponent === 0xff) {
    return sign | (fraction === 0 ? 0x7c00 : 0x7fff);
  }

  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    return sign | ((fraction | 0x80_0000) >>> (1 - halfExponent + 13));
  }
  return sign | (halfExponent << 10) | (fraction >>> 13);
}

function fromHalfNative(value: number): number {
  u16[0] = value;
  return f16[0];
}

function fromHalfJs(value: number): number {
  const sign = (value >>> 15) & 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  let bits: number;

  if (exponent === 0) {
    if (fraction === 0) {
      bits = sign << 31;
    } else {
      let mantissa = fraction;
      let adjustedExponent = -14;
      while ((mantissa & 0x400) === 0) {
        mantissa <<= 1;
        adjustedExponent -= 1;
      }
      bits =
        (sign << 31) |
        ((adjustedExponent + 127) << 23) |
        ((mantissa & 0x3ff) << 13);
    }
  } else if (exponent === 0x1f) {
    bits = (sign << 31) | (fraction === 0 ? 0x7f80_0000 : 0x7fc0_0000);
  } else {
    bits = (sign << 31) | ((exponent - 15 + 127) << 23) | (fraction << 13);
  }

  u32[0] = bits;
  return f32[0];
}

export const toHalf = supportsFloat16Array ? toHalfNative : toHalfJs;
export const fromHalf = supportsFloat16Array ? fromHalfNative : fromHalfJs;

const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);

// Reinterpret the bits of a float32 as a uint32
export function floatBitsToUint(f: number): number {
  f32buffer[0] = f;
  return u32buffer[0];
}

// Reinterpret the bits of a uint32 as a float32
export function uintBitsToFloat(u: number): number {
  u32buffer[0] = u;
  return f32buffer[0];
}
