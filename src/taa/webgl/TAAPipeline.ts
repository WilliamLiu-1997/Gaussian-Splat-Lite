import * as THREE from "three";
import { setXRRenderTargetFlag } from "../../rendering/rendererUtils";

// Match Resolve's maximum history weight of 7/8.
const MAX_HISTORY_SAMPLES = 8;

const vertexShader = /* glsl */ `
void main() { gl_Position = vec4(position, 1.0); }
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D source;
uniform sampler2D sourceDepth;
uniform sampler2D history;
uniform sampler2D historyDepth;
uniform sampler2D historySamples;
uniform vec2 renderSize;
uniform vec4 sampleOffset;
uniform mat4 inverseVP;
uniform mat4 previousVP;
uniform bool valid;
uniform bool stochasticFrame;
uniform bool reversed;
uniform vec2 logDepth;
uniform vec2 depthProjection;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out float fragSamples;

float hardwareDepth(float encoded) {
    if (logDepth.x == 0.0) return encoded;
    float viewZ = -exp2(encoded * logDepth.y) + 1.0;
    return depthProjection.x + depthProjection.y / viewZ;
}

float clipZ(float depth) { return reversed ? depth : depth * 2.0 - 1.0; }
ivec2 bounded(ivec2 p) { return clamp(p, ivec2(0), ivec2(renderSize) - 1); }
vec4 colorAt(ivec2 p) {
    vec4 color = texelFetch(source, bounded(p), 0);
    return vec4(color.rgb, clamp(color.a, 0.0, 1.0));
}

void main() {
    // Sorted output is a clean seed; rejected stochastic history restarts at one.
    fragSamples = stochasticFrame ? 1.0 : float(${MAX_HISTORY_SAMPLES});
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec4 current = colorAt(pixel);
    fragColor = current;
    float centerDepth = texelFetch(sourceDepth, pixel, 0).r;
    gl_FragDepth = centerDepth;
    if (!valid) return;
    bool marked = false;
    vec4 low = current;
    vec4 high = current;
    float closest = reversed ? 0.0 : 1.0;
    ivec2 closestPixel = pixel;
    // Match the node backend's top-left traversal when depths are equal.
    for (int y = 1; y >= -1; --y) {
        for (int x = -1; x <= 1; ++x) {
            ivec2 p = bounded(pixel + ivec2(x, y));
            vec4 raw = texelFetch(source, p, 0);
            marked = marked || raw.a > 1.0;
            vec4 color = vec4(raw.rgb, clamp(raw.a, 0.0, 1.0));
            if (x != 0 || y != 0) color = max(color, vec4(0.0));
            low = min(low, color);
            high = max(high, color);
            float z = hardwareDepth(texelFetch(sourceDepth, p, 0).r);
            if (reversed ? z > closest : z < closest) {
                closest = z;
                closestPixel = p;
            }
        }
    }
    if (!marked) return;
    vec2 uv = (vec2(pixel) + 0.5) / renderSize;
    vec2 closestUV = (vec2(closestPixel) + 0.5) / renderSize;
    vec2 ndc = closestUV * 2.0 - 1.0;
    if (texelFetch(source, closestPixel, 0).a > 1.0) ndc -= sampleOffset.xy;
    vec4 world = inverseVP * vec4(ndc, clipZ(closest), 1.0);
    vec4 projected = previousVP * world;
    if (projected.w <= 0.0) return;
    vec3 previous = projected.xyz / projected.w;
    vec2 previousUV = uv + (previous.xy - ndc) * 0.5;
    if (any(lessThan(previousUV, vec2(0.0))) || any(greaterThanEqual(previousUV, vec2(1.0)))) return;
    float expectedDepth = reversed ? previous.z : previous.z * 0.5 + 0.5;
    vec2 position = previousUV * renderSize - 0.5;
    ivec2 base = ivec2(floor(position));
    vec2 fraction = fract(position);
    vec4 historySum = vec4(0.0);
    float sampleSum = 0.0;
    float validWeight = 0.0;
    // Check each tap before interpolation, including at depth edges.
    // Keep the existing one-sided test for stochastic coverage layers.
    for (int y = 0; y < 2; ++y) {
        for (int x = 0; x < 2; ++x) {
            ivec2 p = base + ivec2(x, y);
            float weight = (x == 0 ? 1.0 - fraction.x : fraction.x)
                * (y == 0 ? 1.0 - fraction.y : fraction.y);
            if (weight > 0.0 && all(greaterThanEqual(p, ivec2(0))) && all(lessThan(p, ivec2(renderSize)))) {
                float oldDepth = hardwareDepth(texelFetch(historyDepth, p, 0).r);
                float disocclusion = reversed ? oldDepth - expectedDepth : expectedDepth - oldDepth;
                if (disocclusion <= 0.0005) {
                    historySum += texelFetch(history, p, 0) * weight;
                    sampleSum += texelFetch(historySamples, p, 0).r * weight;
                    validWeight += weight;
                }
            }
        }
    }
    if (validWeight == 0.0) return;
    float motion = clamp(length((previousUV - uv) * renderSize) / 128.0, 0.0, 1.0);
    vec2 phase = fract((previousUV - uv) * renderSize);
    vec2 coverage = max(phase, 1.0 - phase);
    float subpixel = (1.0 - coverage.x * coverage.y) / 0.75;
    float currentWeight = clamp(0.05 + subpixel * 0.25 + motion, 0.0, 1.0);
    currentWeight = max(currentWeight, 1.0 / (min(sampleSum / validWeight, float(${MAX_HISTORY_SAMPLES - 1})) + 1.0));
    // Count reflects the weight actually retained after motion attenuation.
    fragSamples = 1.0 / currentWeight;
    // Keep the node backend's directional clipping and accumulation weights.
    vec4 center = (low + high) * 0.5;
    vec4 extent = (high - low) * 0.5;
    vec4 oldColor = historySum / validWeight;
    vec4 delta = oldColor - center;
    vec3 unit = abs(delta.rgb / (extent.rgb + 1e-7));
    float maxUnit = max(unit.r, max(unit.g, unit.b));
    if (maxUnit > 1.0) oldColor = center + delta / maxUnit;
    fragColor = mix(oldColor, current, currentWeight);
}
`;

export function createWebGLTAAPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  sample: THREE.Vector4,
  renderSize: THREE.Vector2,
  isStochastic: () => boolean,
) {
  const makeTarget = () =>
    new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
  const source = makeTarget();
  const history = [makeTarget(), makeTarget()];
  source.texture.name = "TAA.source";
  history.forEach((target, i) => {
    target.texture.name = `TAA.history${i}`;
    const samples = target.texture.clone();
    samples.format = THREE.RedFormat;
    samples.name = `TAA.samples${i}`;
    target.textures.push(samples);
  });
  const targets = [source, ...history];
  const currentVP = new THREE.Matrix4();
  const previousVP = { value: new THREE.Matrix4() };
  const reversed = renderer.capabilities.reversedDepthBuffer;
  const uniforms = {
    source: { value: source.texture },
    sourceDepth: { value: source.depthTexture },
    history: { value: history[0].texture },
    historyDepth: { value: history[0].depthTexture },
    historySamples: { value: history[0].textures[1] },
    renderSize: { value: renderSize },
    sampleOffset: { value: sample },
    inverseVP: { value: new THREE.Matrix4() },
    previousVP,
    valid: { value: false },
    stochasticFrame: { value: false },
    reversed: { value: reversed },
    logDepth: { value: new THREE.Vector2() },
    depthProjection: { value: new THREE.Vector2() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    glslVersion: THREE.GLSL3,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
    depthFunc: reversed ? THREE.NeverDepth : THREE.AlwaysDepth,
    toneMapped: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let index = 0;
  let valid = false;
  return {
    reset() {
      valid = false;
    },
    get color() {
      return history[1 - index].texture;
    },
    depth: source.depthTexture as THREE.DepthTexture,
    render(outputEncoded: boolean) {
      const width = renderSize.x;
      const height = renderSize.y;
      if (!valid || source.width !== width || source.height !== height) {
        valid = false;
        for (const target of targets) target.setSize(width, height);
        // Both ping-pong depths must be allocated before either is sampled.
        for (const target of history) renderer.initRenderTarget(target);
      }
      // Preserve the canvas's output-domain blending, including transparent
      // ordinary meshes over splats, as StochasticResolvePass does.
      setXRRenderTargetFlag(source, outputEncoded);
      source.texture.colorSpace = outputEncoded
        ? renderer.outputColorSpace
        : THREE.NoColorSpace;
      renderer.setRenderTarget(source);
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
      const input = history[1 - index];
      const output = history[index];
      uniforms.history.value = input.texture;
      uniforms.historyDepth.value = input.depthTexture;
      uniforms.historySamples.value = input.textures[1];
      uniforms.inverseVP.value.copy(currentVP).invert();
      const stochastic = isStochastic();
      uniforms.valid.value = stochastic && valid;
      uniforms.stochasticFrame.value = stochastic;
      const perspective = camera as THREE.PerspectiveCamera;
      uniforms.logDepth.value.set(
        renderer.capabilities.logarithmicDepthBuffer &&
          perspective.isPerspectiveCamera
          ? 1
          : 0,
        Math.log2(perspective.far + 1),
      );
      const projection = camera.projectionMatrix.elements;
      const scale = reversed ? 1 : 0.5;
      uniforms.depthProjection.value.set(
        -projection[10] * scale + (reversed ? 0 : 0.5),
        -projection[14] * scale,
      );
      renderer.setRenderTarget(output);
      renderer.render(mesh, fullscreenCamera);
      previousVP.value.copy(currentVP);
      index = 1 - index;
      valid = true;
    },
    dispose() {
      source.dispose();
      for (const target of history) target.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
