import type { Node } from "three/webgpu";
import type { SplatMapping } from "../../../rendering/SplatAccumulator";
import { N, loadArray } from "../../../rendering/tsl/shaderUtils";
import { uintTexture } from "../../../rendering/tsl/tslCompat";
import type { Uniforms } from "../../../rendering/uniforms";
import {
  type ProjectionCache,
  cacheTexCoord,
  makeTexture,
  store,
} from "../../../rendering/webgpu/ProjectionCache";
import type {
  ProjectionCacheExtension,
  ProjectionUniformBinding,
} from "../../../rendering/webgpu/ProjectionCacheExtension";
import type { SplatMesh } from "../../../scene/SplatMesh";
import type { GetLightFlags } from "../LightFlags";
import { type SurfaceOutputs, surfaceProjection } from "../tsl/projection";
import { packSurface } from "../tsl/surface";

/**
 * Lighting records of native projected Splats, beside the projection cache
 * and addressed like it: 16 more bytes per compact slot and eye, and only
 * while lighting is on. See packSurface.
 */
export class SurfaceCache implements ProjectionCacheExtension<SurfaceOutputs> {
  /** Whether projections also write lighting records; SplatLighting sets it. */
  readonly enabled = { value: false };
  private readonly texture = makeTexture();

  constructor(
    private readonly cache: ProjectionCache,
    private readonly flagsOf: GetLightFlags,
  ) {}

  /** Uniforms a projection kernel reads through `kernel`; one set per slot. */
  slotUniforms(): Uniforms {
    return {
      lightingEnabled: this.enabled,
      // Light flags of the mesh the slot projects.
      lightFlags: { value: 0 },
    };
  }

  /** What a kernel adds for lighting; `u` binds the slot's uniforms. */
  kernel(u: ProjectionUniformBinding) {
    // The compute graph is fixed, so lighting is a uniform branch there. The
    // kernel copies the uniform to this variable first: Three.js caches a
    // bool uniform in a temporary where a shader first reads it, and inside
    // one eye's projection the other eye's branches would read it unassigned.
    const lighting = N.property("bool");
    return {
      /** Call first in the kernel. */
      begin: () => {
        lighting.assign(u("lightingEnabled", "bool"));
      },
      projection: surfaceProjection(lighting),
      /** Call for a slot the projection cache wrote. */
      write: (index: Node<"uint">, surface: SurfaceOutputs) => {
        N.If(lighting, () => {
          store(
            this.texture,
            cacheTexCoord(index, this.cache.dimensions),
            packSurface(
              surface.normal,
              surface.gradient,
              u("lightFlags", "uint"),
            ),
          );
        });
      },
    };
  }

  /** The lighting record of a slot. */
  read(index: Node<"uint">) {
    return loadArray(
      uintTexture(this.texture),
      cacheTexCoord(index, this.cache.dimensions),
    );
  }

  /** Follows the projection cache's size; call before projecting. */
  fit() {
    const { size } = this.cache;
    // A texture of its size already keeps what it holds.
    if (this.enabled.value) this.texture.setSize(size.x, size.y, size.z);
    else this.texture.setSize(1, 1, 1);
  }

  setSlot(uniforms: Uniforms, mesh: SplatMesh) {
    uniforms.lightFlags.value = this.flagsOf(mesh);
  }

  /** What cached records depend on, besides the projection's own inputs. */
  appendInputs(inputs: unknown[], mapping: readonly SplatMapping[]) {
    inputs.push(this.enabled.value);
    if (this.enabled.value)
      for (const { node } of mapping) inputs.push(this.flagsOf(node));
  }

  dispose() {
    this.texture.dispose();
  }
}
