import type {
  Camera,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  RenderTarget,
  Vector2,
  Vector3,
} from "three";
type TAACamera = PerspectiveCamera | OrthographicCamera;
type TAAParameters = {
  depthThreshold: number;
  edgeDepthDiff: number;
  maxMotionLength: number;
  useSubpixelCorrection: boolean;
};
export declare function createTAAState<
  FloatUniform extends {
    value: number;
  },
  BoolUniform extends {
    value: boolean;
  },
  Vec2Uniform extends {
    value: Vector2;
  },
  Vec3Uniform extends {
    value: Vector3;
  },
  Mat4Uniform extends {
    value: Matrix4;
  },
>(
  makeUniform: {
    (value: number): FloatUniform;
    (value: boolean): BoolUniform;
    (value: Vector2): Vec2Uniform;
    (value: Vector3): Vec3Uniform;
    (value: Matrix4): Mat4Uniform;
  },
  targets: RenderTarget[],
  nodeLogDepth?: boolean,
): {
  uniforms: {
    renderSize: Vec2Uniform;
    projection: Mat4Uniform;
    unjitteredProjection: Mat4Uniform;
    previousProjection: Mat4Uniform;
    viewToPreviousClip: Mat4Uniform;
    previousViewToView: Mat4Uniform;
    valid: BoolUniform;
    reversed: BoolUniform;
    logarithmic: BoolUniform;
    logFar: Vec2Uniform;
    logNear: Vec2Uniform;
    depthThreshold: FloatUniform;
    edgeDepthDiff: FloatUniform;
    maxMotionLength: FloatUniform;
    useSubpixelCorrection: BoolUniform;
    luminanceCoefficients: Vec3Uniform;
  };
  historyIndex: number;
  jitterIndex: number;
  reset(): void;
  setSize(width: number, height: number): void;
  setStencil(stencil: boolean): void;
  beginCapture(camera: TAACamera): void;
  endCapture(camera: TAACamera): void;
  prepareResolve(camera: TAACamera, parameters: TAAParameters): 0 | 1;
  advance(camera: TAACamera): void;
};
export declare const getTAAProjection: (camera: Camera) => Matrix4 | undefined;
