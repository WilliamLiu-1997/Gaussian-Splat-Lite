import * as THREE from "three";
import { type SplatLayer, createSplatLayer } from "./SplatLayer";
import { createSplatLayerPresentation } from "./SplatLayerPresentation";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  isXRRenderTarget,
} from "./rendererUtils";

export type SplatLayerView<Filter> = {
  /** Camera passed to compose() or supplied by the XR rig. */
  readonly sourceCamera: THREE.Camera;
  /** Camera that draws this view into its own origin-zero targets. */
  readonly camera: THREE.Camera;
  readonly rect: THREE.Vector4;
  readonly size: THREE.Vector2;
  readonly layer: SplatLayer;
  readonly filter: Filter;
};

export type SplatLayerOutput = {
  destination: THREE.RenderTarget | null;
  /** Whether the destination expects output color space and tone mapping. */
  outputEncoded: boolean;
  /** Whether views, sizes or color configuration invalidated history. */
  reset: boolean;
};

/**
 * Per-view Splat layers for compose(): resolves the destination and XR eyes,
 * keeps each view's targets and filter, and presents the composited views.
 */
export function createSplatLayerViews<Filter extends { dispose(): void }>(
  createFilter: (
    renderer: GaussianSplatCompatibleRenderer,
    view: { camera: THREE.Camera; size: THREE.Vector2; layer: SplatLayer },
  ) => Filter,
) {
  let views: SplatLayerView<Filter>[] = [];
  let presentation: ReturnType<typeof createSplatLayerPresentation> | null =
    null;
  let currentRenderer: GaussianSplatCompatibleRenderer | null = null;
  let currentScene: THREE.Scene | null = null;
  let currentCamera: THREE.Camera | null = null;
  let xrSession: object | null = null;
  let colorConfiguration = "";
  const viewport = new THREE.Vector4();

  const disposeViews = () => {
    presentation?.dispose();
    presentation = null;
    for (const view of views) {
      view.filter.dispose();
      view.layer.dispose();
    }
    views = [];
  };

  return {
    get views(): readonly SplatLayerView<Filter>[] {
      return views;
    },
    /** Prepares this frame's views; null when the camera has none. */
    update(
      renderer: GaussianSplatCompatibleRenderer,
      scene: THREE.Scene,
      camera: THREE.Camera,
    ): SplatLayerOutput | null {
      const previousTarget = renderer.getRenderTarget();
      let destination = previousTarget;
      let xrOutput = false;
      if (renderer.xr.isPresenting) {
        if (isWebGPURenderer(renderer)) {
          const target = renderer.getOutputRenderTarget();
          if (previousTarget === null || previousTarget === target) {
            destination = target;
            xrOutput = true;
          }
        } else {
          xrOutput = isXRRenderTarget(previousTarget);
        }
      }
      let renderCamera = camera;
      if (xrOutput) {
        if (renderer.xr.cameraAutoUpdate)
          renderer.xr.updateCamera(camera as THREE.PerspectiveCamera);
        renderCamera = renderer.xr.getCamera();
      }
      const eyes = (renderCamera as THREE.ArrayCamera).isArrayCamera
        ? (renderCamera as THREE.ArrayCamera)
        : null;
      const cameras = eyes ? eyes.cameras : [camera];
      if (cameras.length === 0) return null;
      const outputEncoded = destination === null || xrOutput;
      let reset = false;
      if (
        currentRenderer !== renderer ||
        currentScene !== scene ||
        currentCamera !== renderCamera ||
        views.length !== cameras.length ||
        views.some((view, i) => view.sourceCamera !== cameras[i])
      ) {
        disposeViews();
        currentRenderer = renderer;
        currentScene = scene;
        currentCamera = renderCamera;
        views = cameras.map((sourceCamera) => {
          const viewCamera = eyes
            ? new (sourceCamera.constructor as new () => THREE.Camera)().copy(
                sourceCamera,
                false,
              )
            : sourceCamera;
          if (eyes)
            (viewCamera as THREE.PerspectiveCamera).viewport =
              new THREE.Vector4();
          const size = new THREE.Vector2();
          const layer = createSplatLayer(renderer);
          return {
            sourceCamera,
            camera: viewCamera,
            rect: new THREE.Vector4(),
            size,
            layer,
            filter: createFilter(renderer, { camera: viewCamera, size, layer }),
          };
        });
        presentation = createSplatLayerPresentation(renderer, views);
        reset = true;
      }
      const session = xrOutput ? renderer.xr.getSession() : null;
      const logarithmic = isWebGPURenderer(renderer)
        ? renderer.logarithmicDepthBuffer
        : renderer.capabilities.logarithmicDepthBuffer;
      const configuration = `${THREE.ColorManagement.workingColorSpace}/${renderer.outputColorSpace}/${renderer.toneMapping}/${renderer.toneMappingExposure}/${outputEncoded}/${xrOutput}/${logarithmic}`;
      if (configuration !== colorConfiguration || session !== xrSession) {
        xrSession = session;
        colorConfiguration = configuration;
        reset = true;
      }
      // WebGL scene targets blend in the canvas's output space, as a direct
      // canvas draw does; node renderers encode during presentation instead.
      const outputSpace =
        outputEncoded && !isWebGPURenderer(renderer)
          ? renderer.outputColorSpace
          : null;
      if (!eyes) {
        if (destination) viewport.copy(destination.viewport);
        else
          renderer
            .getViewport(viewport)
            .multiplyScalar(renderer.getPixelRatio())
            .floor();
      }
      for (const view of views) {
        const rect = eyes
          ? (view.sourceCamera as THREE.PerspectiveCamera).viewport
          : viewport;
        if (!rect || rect.z <= 0 || rect.w <= 0)
          throw new Error("Splat layer views require a non-empty viewport");
        // Projection changes reproject history; only a changed viewport resets it.
        if (!view.rect.equals(rect)) reset = true;
        view.rect.copy(rect);
        view.size.set(rect.z, rect.w);
        if (eyes) {
          view.camera.copy(view.sourceCamera, false);
          view.camera.matrixWorldAutoUpdate = false;
          // Camera.copy() omits this flag. Without it Three rebuilds a reversed
          // eye projection and loses the XR runtime's asymmetric frustum.
          (
            view.camera as THREE.Camera & { _reversedDepth: boolean }
          )._reversedDepth = view.sourceCamera.reversedDepth;
          // Each view renders into its own origin-zero targets, preserving the
          // eye's asymmetric projection and world transform.
          (
            view.camera as THREE.Camera & { viewport: THREE.Vector4 }
          ).viewport.set(0, 0, rect.z, rect.w);
        }
        view.layer.setSize(rect.z, rect.w);
        view.layer.setOutputSpace(outputSpace);
      }
      return { destination, outputEncoded, reset };
    },
    /** Writes every view's composited scene to its viewport or XR layer. */
    present(destination: THREE.RenderTarget | null, outputEncoded: boolean) {
      presentation?.render(destination, outputEncoded);
    },
    dispose: disposeViews,
  };
}
