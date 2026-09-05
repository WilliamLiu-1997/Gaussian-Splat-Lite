import * as THREE from "three";
import { emptySplatTexture } from "../data/textureLayout";
import { SplatEdits } from "../scene/SplatEdit";

export type Uniforms = Record<string, THREE.IUniform>;

export const ORDERING_TEXTURE_WIDTH = 4096;
export const SPLATS_PER_ORDERING_ROW = ORDERING_TEXTURE_WIDTH * 4;

export const emptyOrdering = new THREE.DataTexture(
  new Uint32Array(SPLATS_PER_ORDERING_ROW),
  ORDERING_TEXTURE_WIDTH,
  1,
  THREE.RGBAIntegerFormat,
  THREE.UnsignedIntType,
);
emptyOrdering.needsUpdate = true;

export const DEFAULT_MIN_ALPHA = 0.5 / 255;

export function makeSplatUniforms() {
  const emptySplats: THREE.Texture = emptySplatTexture;
  const uniforms = {
    // Size of render viewport in pixels
    renderSize: { value: new THREE.Vector2() },
    viewportOrigin: { value: new THREE.Vector2() },
    renderOrigin: { value: new THREE.Vector3() },
    // Near and far plane distances
    near: { value: 0.1 },
    far: { value: 1000.0 },
    // SplatAccumulator to view transformation quaternion
    renderToViewQuat: { value: new THREE.Quaternion() },
    // SplatAccumulator to view transformation translation
    renderToViewPos: { value: new THREE.Vector3() },
    // SplatAccumulator to view transformation uniform scale
    renderToViewScale: { value: 1 },
    // Maximum distance (in stddevs) from Gsplat center to render
    maxStdDev: { value: 1.0 },
    // Minimum pixel radius for splat rendering
    minPixelRadius: { value: 1.0 },
    // Maximum pixel radius for splat rendering
    maxPixelRadius: { value: 512.0 },
    // Minimum alpha value for splat rendering
    minAlpha: { value: DEFAULT_MIN_ALPHA },
    // Add to projected 2D splat covariance diagonal (thickens and brightens)
    preBlurAmount: { value: 0.0 },
    // Add to 2D splat covariance diagonal and adjust opacity (anti-aliasing)
    blurAmount: { value: 0.3 },
    // Clip Gsplats that are clipXY times beyond the +-1 frustum bounds
    clipXY: { value: 1.25 },
    // Debug renderSize scale factor
    focalAdjustment: { value: 2.0 },
    // Whether to decode stored sRGB Splat colors before blending
    encodeLinear: { value: false },
    // Mirrors the material flag for WebGPU's output premultiplication.
    premultipliedAlpha: { value: true },
    // Back-to-front sort ordering of splat indices
    ordering: { type: "t", value: emptyOrdering },
    // Gsplat collection to render
    splats: { type: "t", value: emptySplats },
    splats2: { type: "t", value: emptySplats },
    // Time in seconds for time-based effects
    time: { value: 0 },
    // Delta time in seconds since last frame
    deltaTime: { value: 0 },
    // Debug flag that alternates each frame
    debugFlag: { value: false },
    // Sorting-free stochastic transparency for automatic or forced frames
    stochastic: { value: false },
    // Tags accepted samples for an attached StochasticResolvePass.
    stochasticResolve: { value: false },
    // Depth-only companion draw after sorted frames.
    depthOnly: { value: false },
  };
  return uniforms;
}

export function makeGenerateUniforms(): Uniforms {
  return {
    targetLayer: { value: 0 },
    targetBase: { value: 0 },
    targetCount: { value: 0 },
    sourceSplats: { value: emptySplatTexture },
    sourceSplats2: { value: emptySplatTexture },
    numSh: { value: 0 },
    sh1Texture: { value: emptySplatTexture },
    sh2Texture: { value: emptySplatTexture },
    sh3TextureA: { value: emptySplatTexture },
    sh3TextureB: { value: emptySplatTexture },
    objectBasis: { value: new THREE.Matrix3() },
    objectOffset: { value: new THREE.Vector3() },
    objectLnScale: { value: new THREE.Vector3() },
    objectQuaternion: { value: new THREE.Quaternion() },
    recolor: { value: new THREE.Vector4(1, 1, 1, 1) },
    numSdfs: { value: 0 },
    numEdits: { value: 0 },
    sdfTexture: { value: SplatEdits.emptyTexture },
    editTexture: { value: SplatEdits.emptyTexture },
  };
}
