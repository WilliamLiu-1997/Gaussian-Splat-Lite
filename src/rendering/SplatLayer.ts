import * as THREE from "three";
import type { GaussianSplatRenderer } from "./GaussianSplatRenderer";
import {
  type GaussianSplatCompatibleRenderer,
  setRendererRenderTarget,
  setXRRenderTargetFlag,
} from "./rendererUtils";

/** Binds the compose in which a GaussianSplatRenderer draws offscreen. */
export const splatLayerFrame = Symbol("splatLayerFrame");

/** Counts compositors that keep the Splats after other opaque geometry. */
export const splatLayerAttach = Symbol("splatLayerAttach");

export type SplatLayerFrame = {
  /** Scene whose SplatMesh objects the offscreen draw gathers. */
  readonly scene: THREE.Scene;
  /** True while the bound renderer may draw directly into the layer target. */
  drawing: boolean;
};

function rendersIn(
  object: THREE.Object3D,
  scene: THREE.Object3D,
  camera: THREE.Camera,
) {
  if (!object.layers.test(camera.layers)) return false;
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === scene) return true;
  }
  return false;
}

/** One view's composed scene and independent Splat color/depth targets. */
export function createSplatLayer(renderer: GaussianSplatCompatibleRenderer) {
  const source = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
  });
  source.texture.name = "SplatLayer.source";
  const splats = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
  });
  splats.texture.name = "TAA.splats";

  return {
    /** Composed scene color and depth, ready for presentation. */
    source,
    /** Only Splat color and depth enter TAA; ordinary geometry stays in source. */
    splats,
    setSize(width: number, height: number) {
      source.setSize(width, height);
      splats.setSize(width, height);
    },
    /**
     * WebGLRenderer: blend in the canvas's output space, as a direct canvas
     * draw does, so transparent meshes over Splats keep their appearance.
     */
    setOutputSpace(colorSpace: string | null) {
      setXRRenderTargetFlag(source, colorSpace !== null);
      source.texture.colorSpace = colorSpace ?? THREE.NoColorSpace;
      setXRRenderTargetFlag(splats, colorSpace !== null);
      splats.texture.colorSpace = colorSpace ?? THREE.NoColorSpace;
    },
    /** Capture/TAA before the scene, then blend its proxy between opaque and transparent draws. */
    renderIsolated(
      scene: THREE.Scene,
      camera: THREE.Camera,
      splatRenderer: GaussianSplatRenderer,
      composite: THREE.Mesh,
      process: () => void,
    ) {
      const frame: SplatLayerFrame = {
        scene,
        drawing: true,
      };
      let drawn = false;
      const shown = rendersIn(splatRenderer, scene, camera);
      const clearColor = renderer.getClearColor(new THREE.Color());
      const matrixWorldAutoUpdate = scene.matrixWorldAutoUpdate;
      const clearAlpha = renderer.getClearAlpha();
      splatRenderer[splatLayerFrame](frame);
      try {
        if (shown) {
          setRendererRenderTarget(renderer, splats);
          renderer.setClearColor(0, 0);
          renderer.clear(true, true, false);
          renderer.setClearColor(clearColor, clearAlpha);
          if (matrixWorldAutoUpdate) scene.updateMatrixWorld();
          scene.matrixWorldAutoUpdate = false;
          renderer.render(splatRenderer, camera);
          // A pending sort can finish while preparing this draw. In that case,
          // draw the clean sorted result normally instead of accumulating it.
          if (splatRenderer.stochasticActive) {
            process();
            drawn = true;
            composite.layers.mask = splatRenderer.layers.mask;
            composite.renderOrder = splatRenderer.renderOrder;
            splatRenderer.add(composite);
          }
        }
        frame.drawing = !drawn;
        setRendererRenderTarget(renderer, source);
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
        renderer.render(scene, camera);
        return drawn;
      } finally {
        scene.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
        composite.removeFromParent();
        renderer.setClearColor(clearColor, clearAlpha);
        splatRenderer[splatLayerFrame](null);
      }
    },
    dispose() {
      source.dispose();
      splats.dispose();
    },
  };
}

export type SplatLayer = ReturnType<typeof createSplatLayer>;
