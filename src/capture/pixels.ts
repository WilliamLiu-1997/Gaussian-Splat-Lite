import * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  usesNativeWebGPU,
} from "../rendering/rendererUtils";

/** Packed RGBA8, with the bottom row first on every backend. */
export async function readPixels(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget,
  pixels: Uint8Array,
  face = 0,
) {
  if (
    target.texture.format !== THREE.RGBAFormat ||
    target.texture.type !== THREE.UnsignedByteType
  ) {
    throw new Error(
      "Splat capture readback requires an RGBA UnsignedByte target",
    );
  }

  const { width, height } = target;
  if (!isWebGPURenderer(renderer)) {
    await renderer.readRenderTargetPixelsAsync(
      target as THREE.WebGLRenderTarget,
      0,
      0,
      width,
      height,
      pixels,
      face,
    );
    return;
  }

  const readback = await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    width,
    height,
    0,
    face,
  );
  const source = new Uint8Array(
    readback.buffer,
    readback.byteOffset,
    readback.byteLength,
  );
  if (!usesNativeWebGPU(renderer)) {
    pixels.set(source);
    return;
  }

  // Native WebGPU returns packed rows from the top left.
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const start = (height - y - 1) * rowBytes;
    pixels.set(source.subarray(start, start + rowBytes), y * rowBytes);
  }
}

export function downsamplePixels(
  source: Uint8Array,
  width: number,
  height: number,
  superXY: number,
  output: Uint8Array,
) {
  const subWidth = width / superXY;
  const subHeight = height / superXY;
  const samples = superXY * superXY;
  for (let y = 0; y < subHeight; y++) {
    for (let x = 0; x < subWidth; x++) {
      const outputIndex = (y * subWidth + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let sy = 0; sy < superXY; sy++) {
          const row = (y * superXY + sy) * width;
          for (let sx = 0; sx < superXY; sx++) {
            sum += source[(row + x * superXY + sx) * 4 + channel];
          }
        }
        output[outputIndex + channel] = Math.round(sum / samples);
      }
    }
  }
}
