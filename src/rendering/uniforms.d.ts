import type * as THREE from "three";
export type Uniforms = Record<string, THREE.IUniform>;
export declare const ORDERING_TEXTURE_WIDTH = 4096;
export declare const SPLATS_PER_ORDERING_ROW: number;
export declare const emptyOrdering: THREE.DataTexture;
export declare const DEFAULT_MIN_ALPHA: number;
export declare function makeSplatUniforms(): {
  renderSize: {
    value: THREE.Vector2;
  };
  viewportOrigin: {
    value: THREE.Vector2;
  };
  renderOrigin: {
    value: THREE.Vector3;
  };
  near: {
    value: number;
  };
  far: {
    value: number;
  };
  renderToViewQuat: {
    value: THREE.Quaternion;
  };
  renderToViewPos: {
    value: THREE.Vector3;
  };
  renderToViewScale: {
    value: number;
  };
  maxStdDev: {
    value: number;
  };
  minPixelRadius: {
    value: number;
  };
  minAlpha: {
    value: number;
  };
  edgeFade: {
    value: THREE.Vector2;
  };
  preBlurAmount: {
    value: number;
  };
  blurAmount: {
    value: number;
  };
  clipXY: {
    value: number;
  };
  focalAdjustment: {
    value: number;
  };
  encodeLinear: {
    value: boolean;
  };
  splatCount: {
    value: number;
  };
  ordering: {
    type: string;
    value: THREE.DataTexture;
  };
  splats: {
    type: string;
    value: THREE.Texture<unknown, THREE.TextureEventMap>;
  };
  splats2: {
    type: string;
    value: THREE.Texture<unknown, THREE.TextureEventMap>;
  };
  stochasticSeeds: {
    type: string;
    value: THREE.Texture<unknown, THREE.TextureEventMap>;
  };
  stochasticNoise: {
    value: THREE.DataTexture;
  };
  stochasticSample: {
    value: number;
  };
  stochastic: {
    value: boolean;
  };
  stochasticOrdering: {
    value: boolean;
  };
};
export declare function makeGenerateUniforms(): Uniforms;
