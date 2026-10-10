import {
  AlwaysDepth,
  ColorManagement,
  DepthFormat,
  DepthStencilFormat,
  Matrix4,
  NeverDepth,
  Vector2,
  Vector3,
} from "three";
export function createTAAState(
  makeUniform,
  targets,
  // Logarithmic depth is log2(distance + 1) / log2(far + 1) on WebGLRenderer
  // and log2(distance / near) / log2(far / near) on the node renderers.
  nodeLogDepth = false,
  // How many pixels wider and taller than the image the capture target is.
  margin = 0,
) {
  const uniforms = {
    renderSize: makeUniform(new Vector2(1, 1)),
    projection: makeUniform(new Matrix4()),
    unjitteredProjection: makeUniform(new Matrix4()),
    previousProjection: makeUniform(new Matrix4()),
    viewToPreviousClip: makeUniform(new Matrix4()),
    previousViewToView: makeUniform(new Matrix4()),
    valid: makeUniform(false),
    reversed: makeUniform(false),
    logarithmic: makeUniform(false),
    // Log-depth parameters: x is the current frame, y is the previous frame.
    logFar: makeUniform(new Vector2()),
    logNear: makeUniform(new Vector2()),
    // Parameters are copied from the owner before each resolve.
    depthThreshold: makeUniform(0),
    edgeDepthDiff: makeUniform(0),
    maxMotionLength: makeUniform(0),
    useSubpixelCorrection: makeUniform(false),
    luminanceCoefficients: makeUniform(new Vector3()),
  };
  const baseProjection = new Matrix4();
  const previousViewProjection = new Matrix4();
  const previousWorld = new Matrix4();
  const viewMatrix = new Matrix4();
  return {
    uniforms,
    historyIndex: 0,
    jitterIndex: 0,
    reset() {
      uniforms.valid.value = false;
      this.jitterIndex = 0;
    },
    setSize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      const [source, ...others] = targets;
      if (source.width === w + margin && source.height === h + margin) return;
      source.setSize(w + margin, h + margin);
      for (const target of others) target.setSize(w, h);
      uniforms.renderSize.value.set(w, h);
      this.reset();
    },
    // Only the capture target takes stencil; history stores plain depth.
    setStencil(stencil) {
      const source = targets[0];
      const depthTexture = source.depthTexture;
      if (source.stencilBuffer === stencil) return;
      source.dispose();
      source.stencilBuffer = stencil;
      depthTexture.format = stencil ? DepthStencilFormat : DepthFormat;
    },
    beginCapture(camera) {
      jitterProjection(
        camera,
        baseProjection,
        this.jitterIndex,
        uniforms.renderSize.value.x,
        uniforms.renderSize.value.y,
      );
    },
    endCapture(camera) {
      uniforms.projection.value.copy(camera.projectionMatrix);
      restoreProjection(camera, baseProjection);
    },
    prepareResolve(camera, parameters) {
      // Three.js clamps the near plane the same way.
      const near = Math.max(camera.near, 1e-6);
      uniforms.logFar.value.x = Math.log2(
        nodeLogDepth ? camera.far / near : camera.far + 1,
      );
      uniforms.logNear.value.x = near;
      uniforms.unjitteredProjection.value.copy(camera.projectionMatrix);
      uniforms.viewToPreviousClip.value.multiplyMatrices(
        previousViewProjection,
        camera.matrixWorld,
      );
      uniforms.previousViewToView.value.multiplyMatrices(
        viewMatrix.copy(camera.matrixWorld).invert(),
        previousWorld,
      );
      uniforms.depthThreshold.value = parameters.depthThreshold;
      uniforms.edgeDepthDiff.value = parameters.edgeDepthDiff;
      uniforms.maxMotionLength.value = parameters.maxMotionLength;
      uniforms.useSubpixelCorrection.value = parameters.useSubpixelCorrection;
      ColorManagement.getLuminanceCoefficients(
        uniforms.luminanceCoefficients.value,
      );
      // Three reverses AlwaysDepth/NeverDepth on both node backends.
      return uniforms.reversed.value ? NeverDepth : AlwaysDepth;
    },
    advance(camera) {
      previousViewProjection.multiplyMatrices(
        camera.projectionMatrix,
        viewMatrix,
      );
      previousWorld.copy(camera.matrixWorld);
      uniforms.previousProjection.value.copy(uniforms.projection.value);
      uniforms.logFar.value.y = uniforms.logFar.value.x;
      uniforms.logNear.value.y = uniforms.logNear.value.x;
      this.historyIndex = 1 - this.historyIndex;
      uniforms.valid.value = true;
      this.jitterIndex = (this.jitterIndex + 1) % taaJitterOffsets.length;
    },
  };
}
function halton(index, base) {
  let i = index;
  let fraction = 1;
  let result = 0;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}
const taaJitterOffsets = Array.from({ length: 32 }, (_, i) => [
  halton(i + 1, 2) - 0.5,
  halton(i + 1, 3) - 0.5,
]);
// Native Splat projection uses the unjittered matrix for its compute cache.
const projections = new WeakMap();
export const getTAAProjection = (camera) => projections.get(camera);
function jitterProjection(camera, base, index, width, height) {
  base.copy(camera.projectionMatrix);
  projections.set(camera, base);
  const [x, y] = taaJitterOffsets[index];
  const elements = camera.projectionMatrix.elements;
  for (let column = 0; column < 16; column += 4) {
    elements[column] -= ((2 * x) / width) * elements[column + 3];
    elements[column + 1] += ((2 * y) / height) * elements[column + 3];
  }
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
function restoreProjection(camera, base) {
  projections.delete(camera);
  camera.projectionMatrix.copy(base);
  camera.projectionMatrixInverse.copy(base).invert();
}
