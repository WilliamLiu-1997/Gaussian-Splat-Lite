import * as THREE from "three";
import type { GaussianSplatRenderer } from "./GaussianSplatRenderer";
import type { SplatGeometry } from "./SplatGeometry";
import type { SplatBackend, SplatMaterial } from "./backend";

/** Owns the lazy depth companion; geometry and projection data belong to the host. */
export class SplatDepthPass {
  private _mesh: THREE.Mesh<SplatGeometry, SplatMaterial> | null = null;
  private disposed = false;

  constructor(
    private readonly host: GaussianSplatRenderer,
    private readonly backend: SplatBackend,
    private readonly getActiveRenderer: () => GaussianSplatRenderer,
  ) {}

  get enabled() {
    return (
      (this.host.autoStochastic || this.host.renderDepth) &&
      !this.host.depthWrite
    );
  }

  get mesh() {
    if (this.disposed) throw new Error("GaussianSplatRenderer is disposed");
    if (this._mesh) return this._mesh;

    const { host, backend } = this;
    const uniforms = {
      ...host.uniforms,
      stochastic: { value: false },
      stochasticResolve: { value: false },
      depthOnly: { value: true },
      splatCount: { value: 0 },
    };
    const material = backend.createDepthMaterial(uniforms);
    material.blending = THREE.NoBlending;
    material.colorWrite = false;

    const mesh = new THREE.Mesh(host.geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers = host.layers;
    mesh.renderOrder = Number.POSITIVE_INFINITY;
    mesh.visible = this.enabled;
    mesh.onBeforeRender = () => {
      const activeRenderer = this.getActiveRenderer();
      const compiling =
        backend.kind === "webgpu" && backend.precompile !== null;
      const splatCount =
        compiling ||
        activeRenderer.stochasticActive ||
        activeRenderer.activeSplats === 0
          ? 0
          : activeRenderer.display.numSplats;
      mesh.geometry.setSplatCount(splatCount);
      uniforms.splatCount.value = splatCount;
    };
    if (backend.kind === "webgl-fallback") {
      // Three's fallback clear does not restore the color mask after a
      // depth-only draw, leaving the next frame's color buffer uncleared.
      const glBackend = backend.renderer.backend as unknown as {
        state: { setColorMask(enabled: boolean): void };
      };
      mesh.onAfterRender = () => glBackend.state.setColorMask(true);
    }
    this._mesh = mesh;
    host.add(mesh);
    return mesh;
  }

  updateVisibility() {
    if (this.enabled) this.mesh.visible = true;
    else if (this._mesh) this._mesh.visible = false;
  }

  dispose() {
    this._mesh?.removeFromParent();
    this._mesh?.material.dispose();
    this._mesh = null;
    this.disposed = true;
  }
}
