import * as THREE from "three";
import { SPLAT_TEX_WIDTH } from "./defines";

/** One opacity per source block, with the same layers as the packed source.
 * Block size 1 supports RAD nodes; larger blocks cover SOG regions. */
export class SplatOpacityTable {
  private values: Float32Array;
  private readonly blockSize: number;
  private readonly blocksPerLayer: number;
  private readonly opacityTexture: THREE.DataArrayTexture;
  private dirtyLayers: Uint8Array;
  private dirty = false;

  constructor(capacity: number, layerSize: number, blockBits: number) {
    const layerBits = Math.log2(layerSize);
    if (
      !Number.isInteger(layerBits) ||
      !Number.isInteger(blockBits) ||
      blockBits < 0 ||
      blockBits > layerBits ||
      !Number.isSafeInteger(capacity) ||
      capacity < layerSize ||
      capacity % layerSize !== 0
    )
      throw new Error("Invalid Splat opacity table layout");
    this.blockSize = 2 ** blockBits;
    this.blocksPerLayer = layerSize / this.blockSize;
    this.values = new Float32Array(capacity / this.blockSize);
    const width = Math.min(SPLAT_TEX_WIDTH, this.blocksPerLayer);
    this.opacityTexture = new THREE.DataArrayTexture(
      new Uint32Array(this.values.buffer),
      width,
      this.blocksPerLayer / width,
      capacity / layerSize,
    );
    this.opacityTexture.format = THREE.RedIntegerFormat;
    this.opacityTexture.type = THREE.UnsignedIntType;
    this.opacityTexture.magFilter = THREE.NearestFilter;
    this.opacityTexture.minFilter = THREE.NearestFilter;
    this.opacityTexture.generateMipmaps = false;
    this.opacityTexture.needsUpdate = true;
    this.dirtyLayers = new Uint8Array(capacity / layerSize);
  }

  /** CPU values and GPU storage each occupy this many bytes. */
  get byteLength() {
    return this.values.byteLength;
  }

  getOpacity(source: number) {
    return this.values[Math.floor(source / this.blockSize)];
  }

  /** Source owners supply validated ranges aligned to their allocation blocks. */
  setOpacity(start: number, count: number, opacity: number) {
    const first = Math.floor(start / this.blockSize);
    const last = Math.ceil((start + count) / this.blockSize);
    const value = Math.fround(opacity);
    let changed = false;
    for (let block = first; block < last; block++) {
      if (this.values[block] === value) continue;
      this.values[block] = value;
      this.dirtyLayers[Math.floor(block / this.blocksPerLayer)] = 1;
      changed = true;
    }
    this.dirty ||= changed;
    return changed;
  }

  get texture() {
    if (this.dirty) {
      for (let layer = 0; layer < this.dirtyLayers.length; layer++) {
        if (!this.dirtyLayers[layer]) continue;
        this.opacityTexture.addLayerUpdate(layer);
        this.dirtyLayers[layer] = 0;
      }
      this.opacityTexture.needsUpdate = true;
      this.dirty = false;
    }
    return this.opacityTexture;
  }

  dispose() {
    this.opacityTexture.dispose();
    this.opacityTexture.image.data = new Uint32Array(0);
    this.values = new Float32Array(0);
    this.dirtyLayers = new Uint8Array(0);
    this.dirty = false;
  }
}
