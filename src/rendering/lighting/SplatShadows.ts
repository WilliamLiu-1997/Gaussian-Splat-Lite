import * as THREE from "three";
import { SplatMesh } from "../../scene/SplatMesh";
import type { GaussianSplatRenderer } from "../GaussianSplatRenderer";
import { SplatAccumulator, collectGlobalSplatEdits } from "../SplatAccumulator";
import { SplatGeometry } from "../SplatGeometry";
import { isWebGPURenderer, usesNativeWebGPU } from "../rendererUtils";
import {
  type Uniforms,
  makeGenerateUniforms,
  makeSplatUniforms,
} from "../uniforms";
import { ShadowBlocks } from "./ShadowBlocks";
import { createShadowMaterial } from "./ShadowMaterial";

// Scene callbacks run before Three's shadow pass. Register at matrix update,
// when ordinary scene.add() has attached the renderer and all source objects.
const scenes = new WeakMap<
  THREE.Scene,
  {
    owners: Set<SplatShadows>;
    previous: THREE.Scene["onBeforeRender"];
    callback: THREE.Scene["onBeforeRender"];
  }
>();

class ShadowDraw extends THREE.Mesh<SplatGeometry, THREE.Material> {
  readonly uniforms: Uniforms = {
    ...makeSplatUniforms(),
    ...makeGenerateUniforms(),
    minPixelRadius: { value: 0 },
    maxPixelRadius: { value: Number.POSITIVE_INFINITY },
    maxStdDev: { value: Math.sqrt(8) },
  };
  private readonly accumulator = new SplatAccumulator();
  private readonly blocks: ShadowBlocks;
  private readonly viewScale = new THREE.Vector3();

  constructor(
    readonly source: SplatMesh,
    readonly owner: GaussianSplatRenderer,
  ) {
    super(new SplatGeometry());
    const node = isWebGPURenderer(owner.renderer);
    this.blocks = new ShadowBlocks(this.geometry, this.uniforms, node);
    this.material = createShadowMaterial(
      this.uniforms,
      node,
      node && owner.renderer.logarithmicDepthBuffer,
    );
    this.material.shadowSide = THREE.DoubleSide;
    this.customDepthMaterial = this.material;
    this.customDistanceMaterial = this.material;
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    this.castShadow = true;
    this.frustumCulled = false;
    this.geometry.setSplatCount(0);
    this.name = "Gaussian shadow draw";
  }

  onBeforeShadow(
    _renderer: THREE.WebGLRenderer,
    _object: THREE.Object3D,
    _camera: THREE.Camera,
    camera: THREE.Camera,
  ) {
    const { owner, source, uniforms } = this;
    if (!owner.lighting || !source.castShadow || source.opacity <= 0) {
      this.geometry.setSplatCount(0);
      return;
    }
    this.accumulator.viewOrigin.setFromMatrixPosition(source.matrixWorld);
    this.matrixWorld.makeTranslation(this.accumulator.viewOrigin);
    this.modelViewMatrix.multiplyMatrices(
      camera.matrixWorldInverse,
      this.matrixWorld,
    );
    this.accumulator.prepareUniforms(source, uniforms);
    uniforms.numSh.value = 0;
    uniforms.targetCount.value = source.numSplats;
    uniforms.near.value = (camera as THREE.PerspectiveCamera).near;
    uniforms.far.value = (camera as THREE.PerspectiveCamera).far;
    uniforms.maxStdDev.value = owner.maxStdDev;
    uniforms.minAlpha.value = owner.minAlpha;
    this.modelViewMatrix.decompose(
      uniforms.renderToViewPos.value,
      uniforms.renderToViewQuat.value,
      this.viewScale,
    );
    uniforms.renderToViewScale.value =
      (this.viewScale.x + this.viewScale.y + this.viewScale.z) / 3;
    const target = owner.renderer.getRenderTarget();
    if (target) {
      uniforms.renderSize.value.set(target.viewport.z, target.viewport.w);
      uniforms.viewportOrigin.value.set(target.viewport.x, target.viewport.y);
    } else {
      owner.renderer.getDrawingBufferSize(uniforms.renderSize.value);
      uniforms.viewportOrigin.value.set(0, 0);
    }
    this.blocks.update(
      source.numSplats,
      source.matrixWorld,
      camera,
      uniforms.clipXY.value,
    );
    if (this.material instanceof THREE.ShaderMaterial)
      this.material.uniformsNeedUpdate = true;
  }

  onAfterShadow() {
    // Only onBeforeShadow enables drawing; every other pass keeps zero quads.
    this.geometry.setSplatCount(0);
    if (
      isWebGPURenderer(this.owner.renderer) &&
      !usesNativeWebGPU(this.owner.renderer)
    ) {
      const backend = this.owner.renderer.backend as unknown as {
        state: { setColorMask(value: boolean): void };
      };
      backend.state.setColorMask(true);
    }
  }

  dispose() {
    this.removeFromParent();
    super.dispose();
    this.blocks.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.accumulator.dispose();
    this.uniforms.stochasticNoise.value.dispose();
  }
}

export class SplatShadows {
  private scene: THREE.Scene | null = null;
  private readonly draws = new Map<SplatMesh, ShadowDraw>();

  private readonly onAttachment = () => this.sync();

  constructor(private readonly owner: GaussianSplatRenderer) {
    owner.addEventListener("added", this.onAttachment);
    owner.addEventListener("removed", this.onAttachment);
  }

  sync() {
    let root: THREE.Object3D = this.owner;
    while (root.parent) root = root.parent;
    const scene =
      root instanceof THREE.Scene && this.owner.lighting ? root : null;
    if (this.scene !== scene) {
      this.detach();
      this.scene = scene;
      if (scene) {
        let entry = scenes.get(scene);
        if (!entry) {
          const previous = scene.onBeforeRender;
          const owners = new Set<SplatShadows>();
          const callback: THREE.Scene["onBeforeRender"] = function (
            this: THREE.Scene,
            ...args
          ) {
            previous.apply(this, args);
            const shadowPass =
              (
                scene.overrideMaterial as
                  | (THREE.Material & { isShadowPassMaterial?: boolean })
                  | null
              )?.isShadowPassMaterial === true;
            for (const item of owners) {
              if (!shadowPass) {
                item.sync();
                if (item.scene !== scene || args[0] !== item.owner.renderer)
                  continue;
                if (item.owner.visible)
                  item.owner.prepareLightingFrame(scene, args[2]);
                item.updateDraws(args[2]);
              }
              // Node shadows call renderer.render(scene, shadowCamera). Keep
              // these helper materials out of the main render list entirely.
              if (isWebGPURenderer(item.owner.renderer)) {
                for (const draw of item.draws.values())
                  draw.material.visible = shadowPass;
              }
            }
          };
          entry = { owners, previous, callback };
          scenes.set(scene, entry);
          scene.onBeforeRender = callback;
        }
        entry.owners.add(this);
      }
    }
    if (!scene) this.clearDraws();
  }

  private updateDraws(camera: THREE.Camera) {
    const scene = this.scene;
    const globalEdits =
      scene && this.owner.autoUpdate ? collectGlobalSplatEdits(scene) : [];
    const sources = new Set<SplatMesh>();
    scene?.traverseVisible((node) => {
      if (
        node instanceof SplatMesh &&
        node.isInitialized &&
        node.castShadow &&
        (!this.owner.filter || this.owner.filter(node))
      )
        sources.add(node);
    });
    for (const source of sources) {
      // A worker sort may still be pending on WebGL. Shadow edits and stream
      // updates use this frame's source state rather than that older display.
      if (this.owner.autoUpdate)
        source.updateFrameState({ camera, globalEdits });
      let draw = this.draws.get(source);
      if (!draw) {
        draw = new ShadowDraw(source, this.owner);
        this.draws.set(source, draw);
        this.owner.add(draw);
      }
      draw.layers.mask = source.layers.mask;
      draw.visible = this.owner.layers.test(camera.layers);
    }
    for (const [key, draw] of this.draws) {
      if (!sources.has(key)) {
        draw.dispose();
        this.draws.delete(key);
      }
    }
  }

  private detach() {
    if (!this.scene) return;
    const entry = scenes.get(this.scene);
    if (entry) {
      entry.owners.delete(this);
      if (!entry.owners.size) {
        if (this.scene.onBeforeRender === entry.callback)
          this.scene.onBeforeRender = entry.previous;
        scenes.delete(this.scene);
      }
    }
    this.scene = null;
  }

  private clearDraws() {
    for (const draw of this.draws.values()) draw.dispose();
    this.draws.clear();
  }

  dispose() {
    this.owner.removeEventListener("added", this.onAttachment);
    this.owner.removeEventListener("removed", this.onAttachment);
    this.detach();
    this.clearDraws();
  }
}
