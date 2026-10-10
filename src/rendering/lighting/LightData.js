import * as THREE from "three";
import { StorageBufferAttribute } from "three/webgpu";
import { usesNativeWebGPU } from "../rendererUtils.js";
import { N } from "../tsl/shaderUtils.js";
import { LIGHT_HEADER, createLightRecords } from "./SceneLights.js";

/**
 * Records per row of the light texture. Every WebGL2 device supports this
 * width, so shaders address a record without reading the texture's size.
 */
export const LIGHT_TEXTURE_WIDTH = 2048;

/** Shared light storage; resizing never changes the draw's shader interface. */
export class LightData {
  constructor(lights, renderer) {
    this.lights = lights;
    this.views = 1;
    this.records = createLightRecords(LIGHT_HEADER);
    this.stride = N.uniform(LIGHT_HEADER, "uint");
    this.buffer = null;
    this.texture = null;
    if (usesNativeWebGPU(renderer)) {
      const { limits } = renderer.backend.device;
      this.limit = Math.floor(
        Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize) / 16,
      );
      this.buffer = N.storage(
        new StorageBufferAttribute(this.records, 4).setUsage(
          THREE.DynamicDrawUsage,
        ),
        "vec4",
      ).toReadOnly();
    } else {
      // As many rows as a row is wide, which every device supports as well.
      this.limit = LIGHT_TEXTURE_WIDTH * LIGHT_TEXTURE_WIDTH;
      this.texture = new THREE.DataTexture(
        this.records,
        LIGHT_HEADER,
        1,
        THREE.RGBAFormat,
        THREE.FloatType,
      );
    }
  }

  /** Fill active views, retaining storage until explicit shrinking. */
  update(views, shrink = false) {
    const viewCount = shrink
      ? views.length
      : Math.max(this.views, views.length);
    const count = this.lights.vectors * viewCount;
    if (count > this.limit) {
      throw new RangeError(
        `Scene lights require ${count} vec4 records; device storage limit is ${this.limit}`,
      );
    }
    this.views = viewCount;
    this.stride.value = this.lights.vectors;
    // Amortize allocation when lights arrive one at a time.
    const capacity = this.records.length / 4;
    const size = shrink
      ? count
      : count > capacity
        ? Math.min(this.limit, Math.max(count, capacity * 2))
        : capacity;
    let resized = false;
    if (this.buffer) {
      if (capacity !== size) {
        const old = this.buffer.value;
        this.records = createLightRecords(size);
        this.buffer.value = new StorageBufferAttribute(
          this.records,
          4,
        ).setUsage(THREE.DynamicDrawUsage);
        old.dispose();
        resized = true;
      }
    } else {
      const width = Math.min(size, LIGHT_TEXTURE_WIDTH);
      const height = Math.ceil(size / width);
      if (
        this.texture.image.width !== width ||
        this.texture.image.height !== height
      ) {
        this.texture.dispose();
        this.records = createLightRecords(width * height);
        this.texture.image = { data: this.records, width, height };
        resized = true;
      }
    }
    const changed = this.lights.fill(this.records, views);
    if (resized || changed) {
      if (this.buffer) this.buffer.value.needsUpdate = true;
      else this.texture.needsUpdate = true;
    }
  }

  dispose() {
    this.buffer?.value.dispose();
    this.texture?.dispose();
  }
}
