import {
  ColorManagement,
  DepthTexture,
  FloatType,
  HalfFloatType,
  NoBlending,
  Vector2,
  WebGLCoordinateSystem,
} from "three";
import * as N from "three/tsl";
import {
  Node,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RenderTarget,
  RendererUtils,
} from "three/webgpu";
import { applyThreeR186Patch } from "../patches/threeR186.js";
import { createTAAState } from "./taaShared.js";
/** Camera/depth TAA for WebGPURenderer, including its WebGL2 fallback. */
export class TAANode extends Node {
  static get type() {
    return "TAANode";
  }
  constructor(scene, camera) {
    super("vec4");
    this.scene = scene;
    this.camera = camera;
    this.depthThreshold = 0.0005;
    this.edgeDepthDiff = 0.001;
    this.maxMotionLength = 128;
    this.useSubpixelCorrection = true;
    this.source = this.makeTarget("TAA.scene");
    this.history = [
      this.makeTarget("TAA.history0"),
      this.makeTarget("TAA.history1"),
    ];
    this.historyColor = N.texture(this.history[0].texture, N.screenUV);
    this.historyDepth = N.texture(this.history[0].depthTexture, N.screenUV);
    this.textureNode = N.passTexture(this, this.history[0].texture);
    this.material = new NodeMaterial();
    this.quad = new QuadMesh(this.material);
    this.state = createTAAState(
      N.uniform,
      [this.source, ...this.history],
      true,
    );
    this.zeroToOne = N.uniform(true);
    this.drawingSize = new Vector2();
    this.workingColorSpace = ColorManagement.workingColorSpace;
    this.pipelineStates = new WeakSet();
    this.pipelineRendering = false;
    this.capturePending = true;
    this.updateBeforeType = NodeUpdateType.RENDER;
    this.material.name = "TAA.resolve";
    this.material.blending = NoBlending;
    this.material.depthTest = true;
    this.material.depthWrite = true;
    this.material.toneMapped = false;
    this.quad.name = "TAA.resolve";
  }
  makeTarget(name) {
    const target = new RenderTarget(1, 1, {
      type: HalfFloatType,
      depthTexture: new DepthTexture(1, 1, FloatType),
      samples: 0,
    });
    target.texture.name = name;
    return target;
  }
  get depthTexture() {
    return this.source.depthTexture;
  }
  get projectionMatrix() {
    return this.state.uniforms.projection.value;
  }
  getTextureNode() {
    return this.textureNode;
  }
  setSize(width, height) {
    this.state.setSize(width, height);
  }
  reset() {
    this.state.reset();
  }
  updateBefore(frame) {
    if (this.pipelineRendering && !this.capturePending) return;
    const renderer = frame.renderer;
    if (this.workingColorSpace !== ColorManagement.workingColorSpace) {
      this.workingColorSpace = ColorManagement.workingColorSpace;
      this.reset();
    }
    const rendererState = RendererUtils.saveRendererState(renderer);
    const xrEnabled = renderer.xr.enabled;
    const { camera, state } = this;
    const { uniforms } = state;
    if (this.pipelineRendering) {
      this.setSize(this.drawingSize.x, this.drawingSize.y);
    } else if (rendererState.renderTarget) {
      this.setSize(
        rendererState.renderTarget.width,
        rendererState.renderTarget.height,
      );
    } else {
      renderer.getDrawingBufferSize(this.drawingSize);
      this.setSize(this.drawingSize.x, this.drawingSize.y);
    }
    state.setStencil(renderer.stencil);
    try {
      renderer.xr.enabled = false;
      renderer.setMRT(null);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      const reversedDepth = camera.reversedDepth;
      const coordinateSystem = camera.coordinateSystem;
      state.beginCapture(camera);
      try {
        renderer.setRenderTarget(this.source);
        renderer.render(this.scene, camera);
      } finally {
        state.endCapture(camera);
        // Three may initialize the camera's depth convention on its first draw.
        if (
          camera.reversedDepth !== reversedDepth ||
          camera.coordinateSystem !== coordinateSystem
        )
          camera.updateProjectionMatrix();
      }
      uniforms.reversed.value = renderer.reversedDepthBuffer;
      this.zeroToOne.value =
        renderer.coordinateSystem !== WebGLCoordinateSystem ||
        renderer.reversedDepthBuffer;
      uniforms.logarithmic.value =
        renderer.logarithmicDepthBuffer &&
        "isPerspectiveCamera" in camera &&
        camera.isPerspectiveCamera;
      this.material.depthFunc = state.prepareResolve(camera, this);
      if (!uniforms.valid.value)
        for (const target of this.history) renderer.initRenderTarget(target);
      const previous = this.history[state.historyIndex];
      this.historyColor.value = previous.texture;
      this.historyDepth.value = previous.depthTexture;
      const output = this.history[1 - state.historyIndex];
      renderer.setRenderObjectFunction(null);
      renderer.setRenderTarget(output);
      this.quad.render(renderer);
      this.textureNode.value = output.texture;
      state.advance(camera);
      this.capturePending = false;
    } finally {
      RendererUtils.restoreRendererState(renderer, rendererState);
      renderer.xr.enabled = xrEnabled;
    }
    return undefined;
  }
  setup(builder) {
    applyThreeR186Patch(builder.renderer);
    const pipelineState = builder.context.renderPipelineState;
    if (pipelineState && !this.pipelineStates.has(pipelineState)) {
      this.pipelineStates.add(pipelineState);
      const begin = () => {
        this.pipelineRendering = true;
        this.capturePending = true;
        const renderer = builder.renderer;
        const target =
          renderer.getRenderTarget() ?? renderer.getOutputRenderTarget();
        if (target) this.drawingSize.set(target.width, target.height);
        else renderer.getDrawingBufferSize(this.drawingSize);
      };
      // The first pipeline render builds its callbacks after the before phase.
      begin();
      N.OnBeforeRenderPipeline(begin);
      N.OnAfterRenderPipeline(() => {
        this.pipelineRendering = false;
      });
    }
    const u = this.state.uniforms;
    // Explicit screen UVs avoid identity texture matrices on every sample/load.
    const source = N.texture(this.source.texture, N.screenUV);
    const sourceDepth = N.texture(this.depthTexture, N.screenUV);
    const history = this.historyColor;
    const historyDepth = this.historyDepth;
    const bounded = (p) => p.clamp(N.ivec2(0), N.ivec2(u.renderSize).sub(1));
    // TSL texture coordinates have a top-left origin on both backends.
    const viewPosition = (uv, depth, p, far, near) => {
      const z = N.select(this.zeroToOne, depth, depth.mul(2).sub(1));
      const orientation = N.select(u.reversed, -1, 1);
      const viewZ = p
        .element(3)
        .z.sub(z.mul(p.element(3).w))
        .mul(orientation)
        .toVar();
      const viewW = z
        .mul(p.element(2).w)
        .sub(p.element(2).z)
        .mul(orientation)
        .toVar();
      N.If(u.logarithmic, () => {
        viewZ.assign(near.mul(depth.mul(far).exp2()).negate());
        viewW.assign(1);
      });
      const clipW = p.element(2).w.mul(viewZ).add(p.element(3).w.mul(viewW));
      const xy = uv
        .mul(2)
        .sub(1)
        .mul(N.vec2(1, -1))
        .mul(clipW)
        .sub(p.element(2).xy.mul(viewZ))
        .sub(p.element(3).xy.mul(viewW))
        .div(N.vec2(p.element(0).x, p.element(1).y));
      return N.vec4(xy, viewZ, viewW);
    };
    const forwardDepth = (position) => {
      const clip = u.projection.mul(position).toVar();
      const depth = clip.z.div(clip.w);
      return N.select(
        u.reversed,
        N.float(1).sub(depth),
        N.select(this.zeroToOne, depth, depth.mul(0.5).add(0.5)),
      );
    };
    const pixel = N.ivec2(N.screenCoordinate.xy);
    this.material.depthNode = sourceDepth.load(pixel).r;
    this.material.colorNode = N.Fn(() => {
      const currentColor = source.load(pixel).toVar();
      const result = currentColor.toVar();
      N.If(u.valid, () => {
        const closestDepth = N.float(2).toVar();
        const farthestDepth = N.float(-1).toVar();
        const closestRawDepth = sourceDepth.load(pixel).r.toVar();
        const closestPixel = pixel.toVar();
        const moment1 = currentColor.toVar();
        const moment2 = currentColor.mul(currentColor).toVar();
        for (let x = -1; x <= 1; x++) {
          for (let y = -1; y <= 1; y++) {
            const p = bounded(pixel.add(N.ivec2(x, y))).toVar();
            const rawDepth = sourceDepth.load(p).r.toVar();
            const depth = N.select(
              u.reversed.and(u.logarithmic.not()),
              N.float(1).sub(rawDepth),
              rawDepth,
            ).toVar();
            N.If(depth.lessThan(closestDepth), () => {
              closestDepth.assign(depth);
              closestRawDepth.assign(rawDepth);
              closestPixel.assign(p);
            });
            farthestDepth.assign(farthestDepth.max(depth));
            if (x !== 0 || y !== 0) {
              const neighbor = source.load(p).max(0).toVar();
              moment1.addAssign(neighbor);
              moment2.addAssign(neighbor.mul(neighbor));
            }
          }
        }
        const closestUV = N.vec2(closestPixel).add(0.5).div(u.renderSize);
        const positionView = viewPosition(
          closestUV,
          closestRawDepth,
          u.projection,
          u.logFar.x,
          u.logNear.x,
        );
        const previousClip = u.viewToPreviousClip.mul(positionView).toVar();
        N.If(previousClip.w.greaterThan(0), () => {
          const currentClip = u.unjitteredProjection.mul(positionView).toVar();
          const offsetUV = currentClip.xy
            .div(currentClip.w)
            .sub(previousClip.xy.div(previousClip.w))
            .mul(N.vec2(0.5, -0.5))
            .toVar();
          const historyUV = N.screenUV.sub(offsetUV).toVar();
          N.If(
            historyUV
              .greaterThanEqual(0)
              .all()
              .and(historyUV.lessThan(1).all()),
            () => {
              const oldDepth = historyDepth.sample(historyUV).r.toVar();
              const previousView = viewPosition(
                historyUV,
                oldDepth,
                u.previousProjection,
                u.logFar.y,
                u.logNear.y,
              );
              const previousDepth = forwardDepth(
                u.previousViewToView.mul(previousView),
              );
              N.If(u.logarithmic, () => {
                closestDepth.assign(forwardDepth(positionView));
                const farthestZ = u.logNear.x
                  .mul(farthestDepth.mul(u.logFar.x).exp2())
                  .negate();
                farthestDepth.assign(forwardDepth(N.vec4(0, 0, farthestZ, 1)));
              });
              const isEdge = farthestDepth
                .sub(closestDepth)
                .greaterThan(u.edgeDepthDiff);
              const isDisocclusion = closestDepth
                .sub(previousDepth)
                .greaterThan(u.depthThreshold);
              N.If(isEdge.or(isDisocclusion.not()), () => {
                const motionFactor = offsetUV
                  .mul(u.renderSize)
                  .length()
                  .div(u.maxMotionLength)
                  .clamp(0, 1)
                  .toVar();
                const currentWeight = N.float(0.05).toVar();
                N.If(u.useSubpixelCorrection, () => {
                  const phase = offsetUV.mul(u.renderSize).fract();
                  const weight = phase.max(N.vec2(1).sub(phase));
                  currentWeight.addAssign(
                    N.float(1).sub(weight.x.mul(weight.y)).div(0.75).mul(0.25),
                  );
                });
                currentWeight.assign(
                  currentWeight.add(motionFactor).clamp(0, 1),
                );
                const gamma = N.mix(
                  0.5,
                  1,
                  N.float(1).sub(motionFactor).pow(2),
                );
                const mean = moment1.div(9).toVar();
                const extent = moment2
                  .div(9)
                  .sub(mean.mul(mean))
                  .max(0)
                  .sqrt()
                  .mul(gamma);
                const historyColor = history.sample(historyUV).toVar();
                const delta = historyColor.sub(mean).toVar();
                const unit = delta.rgb.div(extent.rgb.add(1e-7)).abs();
                const maxUnit = unit.x.max(unit.y).max(unit.z);
                N.If(maxUnit.greaterThan(1), () => {
                  historyColor.assign(mean.add(delta.div(maxUnit)));
                });
                const compressedCurrent = currentColor.rgb.div(
                  currentColor.r.max(currentColor.g).max(currentColor.b).add(1),
                );
                const compressedHistory = historyColor.rgb.div(
                  historyColor.r.max(historyColor.g).max(historyColor.b).add(1),
                );
                const weightCurrent = currentWeight.div(
                  compressedCurrent.dot(u.luminanceCoefficients).add(1),
                );
                const weightHistory = N.float(1)
                  .sub(currentWeight)
                  .div(compressedHistory.dot(u.luminanceCoefficients).add(1));
                result.assign(
                  currentColor
                    .mul(weightCurrent)
                    .add(historyColor.mul(weightHistory))
                    .div(weightCurrent.add(weightHistory).max(0.00001)),
                );
              });
            },
          );
        });
      });
      return result;
    })();
    return this.textureNode;
  }
  dispose() {
    super.dispose();
    this.source.dispose();
    for (const target of this.history) target.dispose();
    this.material.dispose();
  }
}
