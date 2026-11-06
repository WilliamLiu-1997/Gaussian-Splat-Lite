import * as THREE from "three";
import { SPLAT_TEX_WIDTH_BITS } from "./defines.js";
import { getShPaletteLayout } from "./shPaletteData.js";
import { SH_ARRAY_COUNTS } from "./splatData.js";
import { disposeDataTexture } from "./textureLayout.js";

const TILE_WIDTH_BITS = 2;
const COLUMN_BITS = SPLAT_TEX_WIDTH_BITS - TILE_WIDTH_BITS;
const COLUMNS = 1 << COLUMN_BITS;

/** One owner per ordinary model, streamed chunk, or RAD input. */
export class ShPalette {
  constructor(data, degree) {
    this.stride = SH_ARRAY_COUNTS[degree];
    // Workers supply tiled R32UI data, ready to upload without another copy.
    this.data = data;
    const count = data.length / (this.stride * 4);
    const { width, height, depth, layerBits } = getShPaletteLayout(
      count,
      degree,
    );
    this.width = width;
    this.height = height;
    this.depth = depth;
    // Entry column mask and bits, then layer mask and bits.
    this.layout = [COLUMNS - 1, COLUMN_BITS, 2 ** layerBits - 1, layerBits];
    this.uploaded = false;
  }

  get texture() {
    if (this.dataTexture) return this.dataTexture;
    const texture = new THREE.DataArrayTexture(
      this.data,
      this.width,
      this.height,
      this.depth,
    );
    texture.format = THREE.RedIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.dataTexture = texture;
    return texture;
  }

  get byteLength() {
    return this.data.byteLength;
  }

  get pendingUploadBytes() {
    return this.uploaded ? 0 : this.byteLength;
  }

  /** A shared palette must be uploaded before its pages or regions can display. */
  prepareUpload(queue) {
    if (this.uploaded) return true;
    if (!queue.has(this) && queue.canAdd(this.byteLength)) {
      this.uploadQueue = queue;
      queue.add(this);
    }
    return false;
  }

  uploadPending(renderer) {
    renderer.initTexture(this.texture);
    this.uploaded = true;
    this.uploadQueue = undefined;
  }

  word(label, coefficient) {
    const [mask, bits, layerMask, layerBits] = this.layout;
    const rowWords = 1 << TILE_WIDTH_BITS;
    const offset =
      (label & mask) * rowWords +
      ((label & layerMask) >>> bits) * this.stride * this.width +
      (label >>> layerBits) * this.width * this.height +
      (coefficient & (rowWords - 1)) +
      (coefficient >>> TILE_WIDTH_BITS) * this.width;
    return this.data[offset];
  }

  bind(uniforms) {
    uniforms.shPaletteStride.value = this.stride;
    uniforms.shPaletteLayout.value.fromArray(this.layout);
    uniforms.shBlock0Texture.value = this.texture;
  }

  dispose() {
    // A cached SOG chunk can outlive its batch and bind this data again.
    this.uploadQueue?.delete(this);
    this.uploadQueue = undefined;
    if (this.dataTexture) disposeDataTexture(this.dataTexture);
    this.dataTexture = undefined;
    this.uploaded = false;
  }
}
