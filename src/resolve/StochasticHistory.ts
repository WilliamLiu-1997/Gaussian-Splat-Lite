import * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "../rendering/rendererUtils";

export const MOVING_HISTORY_SAMPLES = 8;

type HistoryView = {
  camera: THREE.Camera | null;
  rect: THREE.Vector4;
  previousProjection: THREE.Matrix4;
  previousWorld: THREE.Matrix4;
  previousViewProjection: THREE.Matrix4;
  viewProjection: THREE.Matrix4;
  reproject: THREE.Matrix4;
  depthToView: THREE.Matrix4;
  logDepth: THREE.Vector3;
  depthProjection: THREE.Vector2;
  weight: number;
  reversed: boolean;
};

/** Camera-reprojected history, with independent views in a packed XR target. */
export class StochasticHistory {
  readonly weight = { value: 0 };
  readonly sorted = { value: false };
  readonly reversed = { value: false };
  readonly color: { value: THREE.Texture };
  readonly depth: { value: THREE.DepthTexture };
  readonly samples: { value: THREE.Texture };
  readonly reproject = new THREE.Matrix4();
  readonly depthToView = new THREE.Matrix4();
  readonly logDepth = new THREE.Vector3();
  readonly depthProjection = new THREE.Vector2();
  readonly views: HistoryView[] = [];
  private targets: THREE.RenderTarget[] = [];
  private index = 0;
  private valid = false;
  private renderer: GaussianSplatCompatibleRenderer | null = null;
  private camera: THREE.Camera | null = null;
  private session: XRSession | null = null;
  private colorConfiguration = "";
  private readonly textureToClip = new THREE.Matrix4();
  private readonly clipToTexture = new THREE.Matrix4();
  private readonly fallbackColor: THREE.Texture;
  private readonly fallbackDepth: THREE.DepthTexture;
  private readonly fallbackSamples = new THREE.DataTexture(
    new Uint16Array(1),
    1,
    1,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );

  constructor(color: THREE.Texture, depth: THREE.DepthTexture) {
    // TSL deduplicates texture bindings by UUID. Keep current and history
    // inputs distinct even before the first history frame is available.
    this.fallbackColor = color.clone();
    this.fallbackDepth = depth.clone();
    this.color = { value: this.fallbackColor };
    this.depth = { value: this.fallbackDepth };
    this.fallbackSamples.needsUpdate = true;
    this.samples = { value: this.fallbackSamples };
  }

  reset() {
    this.valid = false;
    this.weight.value = 0;
    this.sorted.value = false;
  }

  begin(
    renderer: GaussianSplatCompatibleRenderer,
    camera: THREE.Camera,
    input: THREE.RenderTarget,
    sorted: boolean,
    rects?: readonly THREE.Vector4[],
  ) {
    if (renderer !== this.renderer) {
      this.dispose();
      this.renderer = renderer;
    }
    const webGPU = isWebGPURenderer(renderer);
    const logarithmic = webGPU
      ? renderer.logarithmicDepthBuffer
      : renderer.capabilities.logarithmicDepthBuffer;
    const session = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    const cameras = (camera as THREE.ArrayCamera).isArrayCamera
      ? (camera as THREE.ArrayCamera).cameras
      : [camera];
    const configuration = `${THREE.ColorManagement.workingColorSpace}/${input.texture.colorSpace}/${renderer.outputColorSpace}/${renderer.toneMapping}/${renderer.toneMappingExposure}/${logarithmic}`;
    if (
      camera !== this.camera ||
      session !== this.session ||
      configuration !== this.colorConfiguration ||
      this.views.length !== cameras.length ||
      this.views.some((view, i) =>
        rects
          ? !view.rect.equals(rects[i])
          : view.rect.z !== input.width || view.rect.w !== input.height,
      ) ||
      (this.targets.length > 0 &&
        (this.targets[0].width !== input.width ||
          this.targets[0].height !== input.height))
    )
      this.reset();
    this.camera = camera;
    this.session = session;
    this.colorConfiguration = configuration;
    this.views.length = cameras.length;

    let moving = false;
    cameras.forEach((viewCamera, i) => {
      this.views[i] ??= {
        camera: null,
        rect: new THREE.Vector4(),
        previousProjection: new THREE.Matrix4(),
        previousWorld: new THREE.Matrix4(),
        previousViewProjection: new THREE.Matrix4(),
        viewProjection: new THREE.Matrix4(),
        reproject: new THREE.Matrix4(),
        depthToView: new THREE.Matrix4(),
        logDepth: new THREE.Vector3(),
        depthProjection: new THREE.Vector2(),
        weight: 0,
        reversed: false,
      };
      const view = this.views[i];
      const projectionChanged = !viewCamera.projectionMatrix.equals(
        view.previousProjection,
      );
      const cameraChanged = viewCamera !== view.camera;
      const viewMoving =
        cameraChanged ||
        projectionChanged ||
        !viewCamera.matrixWorld.equals(view.previousWorld);
      moving ||= viewMoving;
      view.weight =
        this.valid &&
        !sorted &&
        !cameraChanged &&
        !projectionChanged &&
        viewMoving
          ? 1
          : 0;
      view.camera = viewCamera;
      view.reversed = viewCamera.reversedDepth;
      view.previousProjection.copy(viewCamera.projectionMatrix);
      view.previousWorld.copy(viewCamera.matrixWorld);
      if (rects) view.rect.copy(rects[i]);
      else view.rect.set(0, 0, input.width, input.height);
    });
    // Static eyes use only the current frame, even if another eye is moving.
    if (!moving && !sorted) {
      this.reset();
      return null;
    }

    cameras.forEach((viewCamera, i) => {
      const view = this.views[i];
      const zeroToOne =
        viewCamera.reversedDepth ||
        viewCamera.coordinateSystem === THREE.WebGPUCoordinateSystem;
      const y = webGPU ? -2 : 2;
      this.textureToClip.set(
        2,
        0,
        0,
        -1,
        0,
        y,
        0,
        -y / 2,
        0,
        0,
        zeroToOne ? 1 : 2,
        zeroToOne ? 0 : -1,
        0,
        0,
        0,
        1,
      );
      this.clipToTexture.copy(this.textureToClip).invert();
      view.viewProjection.multiplyMatrices(
        viewCamera.projectionMatrix,
        viewCamera.matrixWorldInverse,
      );
      view.depthToView
        .copy(viewCamera.projectionMatrixInverse)
        .multiply(this.textureToClip);
      view.reproject
        .multiplyMatrices(viewCamera.matrixWorld, view.depthToView)
        .premultiply(view.previousViewProjection)
        .premultiply(this.clipToTexture);

      // WebGL uses log2(1 - viewZ); NodeMaterial uses log2(-viewZ / near).
      const perspective = viewCamera as THREE.PerspectiveCamera;
      if (logarithmic && perspective.isPerspectiveCamera) {
        const near = Math.max(perspective.near, 1e-6);
        view.logDepth.set(
          webGPU ? near : 1,
          webGPU ? 0 : 1,
          Math.log2(webGPU ? perspective.far / near : perspective.far + 1),
        );
      } else {
        view.logDepth.set(0, 0, 0);
      }
      const projection = viewCamera.projectionMatrix.elements;
      const scale = zeroToOne ? 1 : 0.5;
      view.depthProjection.set(
        -projection[10] * scale + (zeroToOne ? 0 : 0.5),
        -projection[14] * scale,
      );
    });
    if (this.targets.length === 0) {
      this.targets = [0, 1].map((index) => {
        const target = new THREE.RenderTarget(input.width, input.height, {
          type: THREE.HalfFloatType,
          depthTexture: new THREE.DepthTexture(
            input.width,
            input.height,
            THREE.FloatType,
          ),
        });
        target.texture.name = `StochasticResolvePass.history${index}`;
        const samples = target.texture.clone();
        samples.format = THREE.RedFormat;
        samples.name = `StochasticResolvePass.samples${index}`;
        target.textures.push(samples);
        return target;
      });
    }
    for (const target of this.targets)
      target.setSize(input.width, input.height);
    const history = this.targets[1 - this.index];
    this.color.value = this.valid ? history.texture : this.fallbackColor;
    this.depth.value = this.valid
      ? (history.depthTexture as THREE.DepthTexture)
      : this.fallbackDepth;
    this.samples.value = this.valid
      ? history.textures[1]
      : this.fallbackSamples;
    return this.targets[this.index];
  }

  selectView(index: number) {
    const view = this.views[index];
    this.weight.value = view.weight;
    this.reversed.value = view.reversed;
    this.reproject.copy(view.reproject);
    this.depthToView.copy(view.depthToView);
    this.logDepth.copy(view.logDepth);
    this.depthProjection.copy(view.depthProjection);
    return view.rect;
  }

  commit(sorted: boolean) {
    for (const view of this.views)
      view.previousViewProjection.copy(view.viewProjection);
    this.index = 1 - this.index;
    this.valid = true;
    this.sorted.value = sorted;
  }

  dispose() {
    for (const target of this.targets) target.dispose();
    this.targets = [];
    this.views.length = 0;
    this.renderer = null;
    this.camera = null;
    this.session = null;
    this.color.value = this.fallbackColor;
    this.depth.value = this.fallbackDepth;
    this.samples.value = this.fallbackSamples;
    this.fallbackColor.dispose();
    this.fallbackDepth.dispose();
    this.fallbackSamples.dispose();
    this.reset();
  }
}
