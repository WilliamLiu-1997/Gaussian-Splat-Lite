const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16 = supportsFloat16Array ? new globalThis.Float16Array(1) : null;
const u16 = new Uint16Array(f16?.buffer);
function toHalfNative(value) {
  f16[0] = value;
  return u16[0];
}
function roundEven(value) {
  const integer = Math.floor(value);
  const fraction = value - integer;
  return (
    integer +
    Number(fraction > 0.5 || (fraction === 0.5 && (integer & 1) !== 0))
  );
}
function toHalfJs(value) {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  if (Number.isNaN(magnitude)) return 0x7e00;
  if (magnitude >= 65520) return sign | 0x7c00;
  if (magnitude < 2 ** -14) return sign | roundEven(magnitude * 2 ** 24);
  // Round the original double, avoiding double rounding through float32.
  f32[0] = magnitude;
  const exponent = ((u32[0] >>> 23) & 0xff) - 127;
  const mantissa = roundEven(magnitude * 2 ** (10 - exponent));
  return sign | ((exponent + 14) * 1024 + mantissa);
}
function fromHalfNative(value) {
  u16[0] = value;
  return f16[0];
}
function fromHalfJs(value) {
  const sign = (value >>> 15) & 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  let bits;
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
export function floatBitsToUint(f) {
  f32buffer[0] = f;
  return u32buffer[0];
}
// Reinterpret the bits of a uint32 as a float32
export function uintBitsToFloat(u) {
  u32buffer[0] = u;
  return f32buffer[0];
}
