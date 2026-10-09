import * as THREE from "three";
import {
  ORDERING_TEXTURE_WIDTH,
  SPLATS_PER_ORDERING_ROW,
} from "../uniforms.js";
/** CPU ordering storage shared by both WebGL backends; uploads stay backend-specific. */
export class OrderingTexture {
  constructor() {
    this.texture = null;
  }
  getCapacity(count) {
    return (
      Math.max(1, Math.ceil(count / SPLATS_PER_ORDERING_ROW)) *
      SPLATS_PER_ORDERING_ROW
    );
  }
  get data() {
    return this.texture?.image.data ?? null;
  }
  update({ ordering, activeSplats, requiredCapacity, shrink }, uploadRows) {
    const rows = requiredCapacity / SPLATS_PER_ORDERING_ROW;
    if (
      this.texture &&
      (rows > this.texture.image.height ||
        (shrink && rows !== this.texture.image.height))
    )
      this.dispose();
    if (!this.texture) {
      this.texture = new THREE.DataTexture(
        ordering,
        ORDERING_TEXTURE_WIDTH,
        rows,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
      );
      this.texture.needsUpdate = true;
    } else {
      this.texture.image.data = ordering;
      if (activeSplats > 0)
        uploadRows(
          this.texture,
          Math.ceil(activeSplats / SPLATS_PER_ORDERING_ROW),
        );
    }
    return this.texture;
  }
  dispose() {
    this.texture?.dispose();
    this.texture = null;
  }
}
