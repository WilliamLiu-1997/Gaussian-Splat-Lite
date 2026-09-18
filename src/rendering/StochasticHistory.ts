import * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "./rendererUtils";

// Positive integer: per-pixel history limit while the camera is stationary.
export const HISTORY_SAMPLES = 32;
// Positive integer: per-pixel history limit during movement.
export const MOVING_HISTORY_SAMPLES = 16;
// Positive integer, at most HISTORY_SAMPLES: frames until presentation
// smoothing reaches its minimum weight after the camera stops.
export const HISTORY_TRANSITION_FRAMES = 16;
// Spatial color filter width: 0 disables it; 2, 3, or 4 select the kernel size.
// History validation always keeps its 4x4 neighborhood.
export const SPATIAL_SMOOTHING: 0 | 2 | 3 | 4 = 4;
// [0, 1]: stationary presentation smoothing after enough valid samples.
// 0 fades smoothing out completely; 1 keeps its full strength.
export const SPATIAL_SMOOTHING_MIN_WEIGHT = 0;

/** History for the opt-in, non-XR compose path. Coordinates include backend Y/depth conventions. */
export class StochasticHistory {
  readonly active = { value: false };
  readonly stationary = { value: false };
  readonly weight = { value: 0 };
  readonly color: { value: THREE.Texture };
  readonly depth: { value: THREE.DepthTexture };
  readonly samples: { value: THREE.Texture };
  readonly spatialWeight = { value: 0 };
  readonly reproject = new THREE.Matrix4();
  readonly depthToView = new THREE.Matrix4();
  private targets: THREE.RenderTarget[] = [];
  private index = 0;
  private frames = 0;
  private stationaryFrames = 0;
  private renderer: GaussianSplatCompatibleRenderer | null = null;
  private camera: THREE.Camera | null = null;
  private colorConfiguration = "";
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly previousProjection = new THREE.Matrix4();
  private readonly previousWorld = new THREE.Matrix4();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly textureToClip = new THREE.Matrix4();
  private readonly clipToTexture = new THREE.Matrix4();
  private readonly fallbackColor: THREE.Texture;
  private readonly fallbackDepth: THREE.DepthTexture;
  private readonly fallbackSamples = new THREE.DataTexture(
    new Uint16Array(2),
    1,
    1,
    THREE.RGFormat,
    THREE.HalfFloatType,
  );

  constructor(color: THREE.Texture, depth: THREE.DepthTexture) {
    // TSL deduplicates texture bindings by texture UUID when compiling. Current
    // and history inputs must stay distinct, even before history is available.
    this.fallbackColor = color.clone();
    this.fallbackDepth = depth.clone();
    this.color = { value: this.fallbackColor };
    this.depth = { value: this.fallbackDepth };
    this.fallbackSamples.needsUpdate = true;
    this.samples = { value: this.fallbackSamples };
  }

  get needsFrame() {
    // Bound automatic redraws. An externally requested compose still validates
    // and updates history after this warm-up has finished.
    return this.frames > 0 && this.stationaryFrames < HISTORY_SAMPLES;
  }

  get result() {
    return this.targets[1 - this.index];
  }

  /** Only vary coverage after a complete, unchanged camera frame. */
  prepare(camera: THREE.Camera, settling = false) {
    this.stationary.value =
      !settling &&
      this.frames > 0 &&
      camera === this.camera &&
      camera.matrixWorld.equals(this.previousWorld) &&
      camera.projectionMatrix.equals(this.previousProjection);
    if (!this.stationary.value) this.stationaryFrames = 0;
    return this.stationary.value ? this.stationaryFrames + 1 : 0;
  }

  reset() {
    this.frames = 0;
    this.stationaryFrames = 0;
    this.stationary.value = false;
    this.spatialWeight.value = 0;
  }

  begin(
    renderer: GaussianSplatCompatibleRenderer,
    camera: THREE.Camera,
    input: THREE.RenderTarget,
  ) {
    const configuration = `${THREE.ColorManagement.workingColorSpace}/${renderer.outputColorSpace}/${renderer.toneMapping}/${renderer.toneMappingExposure}`;
    if (renderer !== this.renderer) {
      this.dispose();
      this.renderer = renderer;
    }
    if (
      camera !== this.camera ||
      configuration !== this.colorConfiguration ||
      !camera.projectionMatrix.equals(this.previousProjection)
    )
      this.reset();
    this.camera = camera;
    this.colorConfiguration = configuration;

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
        // R: sample count; G: 2 only while all accumulated color is Splat-only.
        samples.format = THREE.RGFormat;
        samples.name = `StochasticResolvePass.samples${index}`;
        target.textures.push(samples);
        return target;
      });
    }
    for (const target of this.targets) {
      if (target.width !== input.width || target.height !== input.height) {
        target.setSize(input.width, input.height);
        this.reset();
      }
    }

    const zeroToOne =
      camera.reversedDepth ||
      camera.coordinateSystem === THREE.WebGPUCoordinateSystem;
    const y = isWebGPURenderer(renderer) ? -2 : 2;
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
    this.viewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.reproject
      .copy(this.viewProjection)
      .invert()
      .multiply(this.textureToClip)
      .premultiply(this.previousViewProjection)
      .premultiply(this.clipToTexture);
    this.depthToView
      .copy(this.previousProjection)
      .invert()
      .multiply(this.textureToClip);
    const history = this.targets[1 - this.index];
    this.spatialWeight.value = this.stationary.value
      ? Math.max(0, 1 - (this.stationaryFrames + 1) / HISTORY_TRANSITION_FRAMES)
      : 0;
    this.color.value = this.frames > 0 ? history.texture : this.fallbackColor;
    this.depth.value =
      this.frames > 0
        ? (history.depthTexture as THREE.DepthTexture)
        : this.fallbackDepth;
    this.samples.value =
      this.frames > 0 ? history.textures[1] : this.fallbackSamples;
    this.weight.value = this.frames > 0 ? 1 : 0;
    this.active.value = true;
    return this.targets[this.index];
  }

  commit(camera: THREE.Camera) {
    this.previousViewProjection.copy(this.viewProjection);
    this.previousProjection.copy(camera.projectionMatrix);
    this.previousWorld.copy(camera.matrixWorld);
    this.index = 1 - this.index;
    this.frames += 1;
    if (this.stationary.value) this.stationaryFrames += 1;
  }

  dispose() {
    for (const target of this.targets) target.dispose();
    this.targets = [];
    this.renderer = null;
    this.camera = null;
    this.color.value = this.fallbackColor;
    this.depth.value = this.fallbackDepth;
    this.samples.value = this.fallbackSamples;
    this.fallbackColor.dispose();
    this.fallbackDepth.dispose();
    this.fallbackSamples.dispose();
    this.reset();
  }
}
