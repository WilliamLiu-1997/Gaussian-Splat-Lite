import * as THREE from "three";
import { type Node, NodeMaterial, type WebGPURenderer } from "three/webgpu";
import { N, load2D } from "../../rendering/tsl/shaderUtils";

// Match Resolve's maximum history weight of 7/8.
const MAX_HISTORY_SAMPLES = 8;

/** TSL counterpart of webgl/TAAPipeline.ts; keep the resolve rules in sync. */
export function createNodeTAAPipeline(
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  sample: THREE.Vector4,
  renderSize: THREE.Vector2,
  isStochastic: () => boolean,
) {
  const makeTarget = () =>
    new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
  const sourceTarget = makeTarget();
  const history = [makeTarget(), makeTarget()];
  sourceTarget.texture.name = "TAA.source";
  history.forEach((target, i) => {
    target.texture.name = `TAA.history${i}`;
    const samples = target.texture.clone();
    samples.format = THREE.RedFormat;
    samples.name = `TAA.samples${i}`;
    target.textures.push(samples);
  });
  let index = 0;
  let valid = false;
  const source = N.texture(sourceTarget.texture);
  const depth = N.texture(sourceTarget.depthTexture as THREE.DepthTexture);
  const historyColor = N.texture(history[0].texture).onObjectUpdate(
    () => history[1 - index].texture,
  );
  const historyDepth = N.texture(
    history[0].depthTexture as THREE.DepthTexture,
  ).onObjectUpdate(() => history[1 - index].depthTexture as THREE.DepthTexture);
  const historySamples = N.texture(history[0].textures[1]).onObjectUpdate(
    () => history[1 - index].textures[1],
  );
  const targets = [sourceTarget, ...history];
  const currentVP = new THREE.Matrix4();
  const previousVP = N.uniform(new THREE.Matrix4());
  const inverseVP = N.uniform(new THREE.Matrix4());
  const jitter = N.uniform(sample);
  const size = N.uniform(renderSize);
  const useHistory = N.uniform(false, "bool");
  const stochasticFrame = N.uniform(false, "bool");
  const sampleCount = N.property("float", "taaHistorySamples");
  const logDepth = N.uniform(new THREE.Vector2());
  const depthProjection = N.uniform(new THREE.Vector2());
  const reversed = renderer.reversedDepthBuffer;
  const zeroToOne =
    reversed || renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
  const hardwareDepth = N.Fn(([encoded]: [Node<"float">]) => {
    const value = encoded.toVar();
    N.If(logDepth.x.greaterThan(0), () => {
      const viewZ = logDepth.x.negate().mul(encoded.mul(logDepth.y).exp2());
      value.assign(depthProjection.x.add(depthProjection.y.div(viewZ)));
    });
    return value;
  });
  const pixel = N.ivec2(N.screenCoordinate.xy);
  const material = new NodeMaterial();
  material.vertexNode = N.vec4(N.positionGeometry.xy, 0, 1);
  material.depthNode = load2D(depth, pixel).r;
  const resolve = N.Fn(() => {
    // A sorted image is a clean seed. Unresolved stochastic pixels start at one.
    sampleCount.assign(N.select(stochasticFrame, 1, MAX_HISTORY_SAMPLES));
    const raw = load2D(source, pixel);
    const current = N.vec4(raw.rgb, raw.a.clamp(0, 1)).toVar();
    const result = current.toVar();
    N.If(useHistory, () => {
      const marked = N.bool(false).toVar();
      const low = current.toVar();
      const high = current.toVar();
      const closest = N.float(reversed ? 0 : 1).toVar();
      const closestPixel = pixel.toVar();
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          const p = pixel
            .add(N.ivec2(x, y))
            .clamp(N.ivec2(0), N.ivec2(size).sub(1));
          const texel = load2D(source, p).toVar();
          marked.assign(marked.or(texel.a.greaterThan(1)));
          const color = N.vec4(texel.rgb, texel.a.clamp(0, 1));
          const bounded = x !== 0 || y !== 0 ? color.max(0) : color;
          low.assign(low.min(bounded));
          high.assign(high.max(bounded));
          const z = hardwareDepth(load2D(depth, p).r).toVar();
          N.If(reversed ? z.greaterThan(closest) : z.lessThan(closest), () => {
            closest.assign(z);
            closestPixel.assign(p);
          });
        }
      }
      N.If(marked, () => {
        const uv = N.vec2(pixel).add(0.5).div(size);
        const closestUV = N.vec2(closestPixel).add(0.5).div(size);
        // Node textures use top-left coordinates on both native and GL backends.
        const ndc = closestUV.mul(N.vec2(2, -2)).add(N.vec2(-1, 1)).toVar();
        N.If(load2D(source, closestPixel).a.greaterThan(1), () => {
          ndc.subAssign(jitter.xy);
        });
        const world = inverseVP.mul(
          N.vec4(ndc, zeroToOne ? closest : closest.mul(2).sub(1), 1),
        );
        const projected = previousVP.mul(world).toVar();
        N.If(projected.w.greaterThan(0), () => {
          const previous = projected.xyz.div(projected.w);
          const previousUV = uv
            .add(previous.xy.sub(ndc).mul(N.vec2(0.5, -0.5)))
            .toVar();
          N.If(
            N.all(previousUV.greaterThanEqual(N.vec2(0))).and(
              N.all(previousUV.lessThan(N.vec2(1))),
            ),
            () => {
              const expectedDepth = zeroToOne
                ? previous.z
                : previous.z.mul(0.5).add(0.5);
              const position = previousUV.mul(size).sub(0.5);
              const base = N.ivec2(position.floor());
              const fraction = position.fract();
              const historySum = N.vec4(0).toVar();
              const sampleSum = N.float(0).toVar();
              const validWeight = N.float(0).toVar();
              // Check each tap before interpolation, including at depth edges.
              // Keep the existing one-sided test for stochastic coverage layers.
              for (let y = 0; y < 2; y++) {
                for (let x = 0; x < 2; x++) {
                  const p = base.add(N.ivec2(x, y));
                  const weight = (
                    x === 0 ? N.float(1).sub(fraction.x) : fraction.x
                  ).mul(y === 0 ? N.float(1).sub(fraction.y) : fraction.y);
                  N.If(
                    weight
                      .greaterThan(0)
                      .and(p.x.greaterThanEqual(0))
                      .and(p.y.greaterThanEqual(0))
                      .and(p.x.lessThan(N.int(size.x)))
                      .and(p.y.lessThan(N.int(size.y))),
                    () => {
                      const oldDepth = hardwareDepth(load2D(historyDepth, p).r);
                      const disocclusion = reversed
                        ? oldDepth.sub(expectedDepth)
                        : expectedDepth.sub(oldDepth);
                      N.If(disocclusion.lessThanEqual(0.0005), () => {
                        historySum.addAssign(
                          load2D(historyColor, p).mul(weight),
                        );
                        sampleSum.addAssign(
                          load2D(historySamples, p).r.mul(weight),
                        );
                        validWeight.addAssign(weight);
                      });
                    },
                  );
                }
              }
              N.If(validWeight.greaterThan(0), () => {
                const velocity = previousUV.sub(uv).mul(size);
                const motion = velocity.length().div(128).clamp(0, 1);
                const phase = velocity.fract();
                const coverage = phase.max(N.vec2(1).sub(phase));
                const subpixel = N.float(1)
                  .sub(coverage.x.mul(coverage.y))
                  .div(0.75);
                const currentWeight = subpixel
                  .mul(0.25)
                  .add(0.05)
                  .add(motion)
                  .clamp(0, 1)
                  .max(
                    N.float(1).div(
                      sampleSum
                        .div(validWeight)
                        .min(MAX_HISTORY_SAMPLES - 1)
                        .add(1),
                    ),
                  )
                  .toVar();
                // Store the effective count after motion weighting, not just age.
                sampleCount.assign(N.float(1).div(currentWeight));
                // Sparse stochastic colors need their full neighborhood range,
                // not a narrow variance box that pulls history toward dark holes.
                const center = low.add(high).mul(0.5);
                const extent = high.sub(low).mul(0.5);
                const oldColor = historySum.div(validWeight).toVar();
                const delta = oldColor.sub(center);
                const unit = delta.rgb.div(extent.rgb.add(1e-7)).abs();
                const maxUnit = unit.r.max(unit.g).max(unit.b);
                N.If(maxUnit.greaterThan(1), () => {
                  oldColor.assign(center.add(delta.div(maxUnit)));
                });
                // Coverage already encodes opacity; do not discount bright hits.
                result.assign(N.mix(oldColor, current, currentWeight));
              });
            },
          );
        });
      });
    });
    return result;
  })();
  material.fragmentNode = N.outputStruct(resolve, N.vec4(sampleCount, 0, 0, 1));
  material.blending = THREE.NoBlending;
  material.depthTest = material.depthWrite = true;
  material.depthFunc = reversed ? THREE.NeverDepth : THREE.AlwaysDepth;
  material.toneMapped = false;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    get color() {
      return history[1 - index].texture;
    },
    depth: sourceTarget.depthTexture as THREE.DepthTexture,
    reset() {
      valid = false;
    },
    render() {
      const { x: width, y: height } = renderSize;
      if (
        !valid ||
        sourceTarget.width !== width ||
        sourceTarget.height !== height
      ) {
        valid = false;
        for (const target of targets) target.setSize(width, height);
        for (const target of history) renderer.initRenderTarget(target);
      }
      renderer.setRenderTarget(sourceTarget);
      renderer.autoClear = false;
      renderer.clear(
        renderer.autoClearColor,
        renderer.autoClearDepth,
        renderer.autoClearStencil,
      );
      renderer.render(scene, camera);
      currentVP.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      inverseVP.value.copy(currentVP).invert();
      // The renderer may finish sorting during capture, after compose's prediction.
      stochasticFrame.value = isStochastic();
      useHistory.value = stochasticFrame.value && valid;
      const perspective = camera as THREE.PerspectiveCamera;
      logDepth.value.set(
        renderer.logarithmicDepthBuffer && perspective.isPerspectiveCamera
          ? perspective.near
          : 0,
        Math.log2(perspective.far / perspective.near),
      );
      const projection = camera.projectionMatrix.elements;
      const scale = zeroToOne ? 1 : 0.5;
      depthProjection.value.set(
        -projection[10] * scale + (zeroToOne ? 0 : 0.5),
        -projection[14] * scale,
      );
      renderer.setRenderTarget(history[index]);
      renderer.render(mesh, fullscreenCamera);
      previousVP.value.copy(currentVP);
      index = 1 - index;
      valid = true;
    },
    dispose() {
      sourceTarget.dispose();
      for (const target of history) target.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
