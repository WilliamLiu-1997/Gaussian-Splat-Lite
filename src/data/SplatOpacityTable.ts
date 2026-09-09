import * as THREE from "three";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "./defines";

const GROUP_LAYER_SIZE = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;

type OpacityRange = { first: number; last: number; refs: number };

/** Source blocks hold group IDs; a small float32 table holds their opacities. */
export class SplatOpacityTable {
  private blocks: Uint32Array;
  private readonly blockSize: number;
  private readonly blocksPerLayer: number;
  private readonly blockTexture: THREE.DataArrayTexture;
  private dirtyLayers: Uint8Array;
  private dirty = false;
  // Transparent, stable, RAD incoming and RAD outgoing groups.
  private values = new Float32Array([0, 1, 0, 1]);
  private valueTexture = this.createValueTexture();
  private valuesDirty = false;
  private readonly ranges = new Map<number, OpacityRange>();
  private readonly freeGroups: number[] = [];
  private nextGroup = 4;

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
    this.blocks = new Uint32Array(capacity / this.blockSize);
    const width = Math.min(SPLAT_TEX_WIDTH, this.blocksPerLayer);
    this.blockTexture = this.createTexture(
      this.blocks,
      width,
      this.blocksPerLayer / width,
      capacity / layerSize,
    );
    this.dirtyLayers = new Uint8Array(capacity / layerSize);
  }

  private createTexture(
    data: Uint32Array,
    width: number,
    height: number,
    depth: number,
  ) {
    const texture = new THREE.DataArrayTexture(data, width, height, depth);
    texture.format = THREE.RedIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createValueTexture() {
    const count = this.values.length;
    return this.createTexture(
      new Uint32Array(this.values.buffer),
      Math.min(SPLAT_TEX_WIDTH, count),
      Math.min(SPLAT_TEX_HEIGHT, Math.ceil(count / SPLAT_TEX_WIDTH)),
      Math.ceil(count / GROUP_LAYER_SIZE),
    );
  }

  /** CPU arrays and GPU storage each occupy this many bytes. */
  get byteLength() {
    return this.blocks.byteLength + this.values.byteLength;
  }

  getOpacity(source: number) {
    return this.values[this.blocks[Math.floor(source / this.blockSize)]];
  }

  setGroupOpacity(group: number, opacity: number) {
    const value = Math.fround(opacity);
    if (this.values[group] === value) return false;
    this.values[group] = value;
    this.valuesDirty = true;
    return true;
  }

  private releaseBlock(group: number) {
    if (group < 4) return;
    const range = this.ranges.get(group);
    if (range && --range.refs === 0) {
      this.ranges.delete(group);
      this.freeGroups.push(group);
    }
  }

  /** Validated ranges retain their group while only its coefficient changes. */
  setOpacity(start: number, count: number, opacity: number) {
    const first = Math.floor(start / this.blockSize);
    const last = Math.ceil((start + count) / this.blockSize);
    const value = Math.fround(opacity);
    const previous = this.blocks[first];
    const range = this.ranges.get(previous);
    if (
      range?.first === first &&
      range.last === last &&
      range.refs === last - first
    )
      return this.setGroupOpacity(previous, value);

    let block = first;
    while (block < last && this.values[this.blocks[block]] === value) block++;
    if (block === last) return false;
    const group = this.freeGroups.pop() ?? this.nextGroup++;
    if (group >= this.values.length) {
      const values = new Float32Array(this.values.length * 2);
      values.set(this.values);
      this.values = values;
      this.valueTexture.dispose();
      this.valueTexture = this.createValueTexture();
    }
    const nextRange = { first, last, refs: 0 };
    this.ranges.set(group, nextRange);
    this.values[group] = value;
    this.valuesDirty = true;
    for (let index = first; index < last; index++) {
      // Equal signed zeros retain their original bits.
      if (value === 0 && this.values[this.blocks[index]] === 0) continue;
      this.releaseBlock(this.blocks[index]);
      this.blocks[index] = group;
      nextRange.refs++;
    }
    this.dirtyLayers.fill(
      1,
      Math.floor(first / this.blocksPerLayer),
      Math.ceil(last / this.blocksPerLayer),
    );
    this.dirty = true;
    return true;
  }

  /** Validated physical indices for stable, incoming and outgoing RAD groups. */
  setIndexed(indices: Uint32Array, values?: Uint8Array) {
    for (let index = 0; index < indices.length; index++) {
      const source = indices[index];
      const group = (values?.[index] ?? 0) + 1;
      if (this.blocks[source] === group) continue;
      this.releaseBlock(this.blocks[source]);
      this.blocks[source] = group;
      this.dirtyLayers[Math.floor(source / this.blocksPerLayer)] = 1;
      this.dirty = true;
    }
  }

  get texture() {
    if (this.dirty) {
      for (let layer = 0; layer < this.dirtyLayers.length; layer++) {
        if (!this.dirtyLayers[layer]) continue;
        this.blockTexture.addLayerUpdate(layer);
        this.dirtyLayers[layer] = 0;
      }
      this.blockTexture.needsUpdate = true;
      this.dirty = false;
    }
    return this.blockTexture;
  }

  get opacityTexture() {
    if (this.valuesDirty) {
      this.valueTexture.needsUpdate = true;
      this.valuesDirty = false;
    }
    return this.valueTexture;
  }

  dispose() {
    this.blockTexture.dispose();
    this.valueTexture.dispose();
    this.blockTexture.image.data = new Uint32Array(0);
    this.valueTexture.image.data = new Uint32Array(0);
    this.blocks = new Uint32Array(0);
    this.values = new Float32Array(0);
    this.dirtyLayers = new Uint8Array(0);
    this.ranges.clear();
    this.freeGroups.length = 0;
    this.dirty = this.valuesDirty = false;
  }
}
