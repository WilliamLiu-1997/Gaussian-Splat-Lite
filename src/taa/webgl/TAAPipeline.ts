import * as THREE from "three";
import { setRendererRenderTarget } from "../../rendering/rendererUtils";
import { TAA_MOVING_SAMPLES, createTAAHistory } from "../TAAHistory";

// Adapted from SuperSplat Viewer temporal accumulation (MIT); see THIRD_PARTY_LICENSES.md.
const vertexShader = "void main() { gl_Position = vec4(position, 1.0); }";
const common = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D source;
uniform sampler2D sourceDepth;
uniform usampler2D historyColor;
uniform usampler2D historyInfo;
uniform vec2 size;
uniform mat4 projection;
uniform vec3 depthParams;
uniform bool reversed;
vec4 decodeColor(uvec2 v) { return vec4(unpackUnorm2x16(v.x), unpackUnorm2x16(v.y)); }
vec2 decodeInfo(uint v) { return vec2(uintBitsToFloat((v >> 9u) << 8u), float(v & 511u)); }
float viewDepth(float z) {
    if (depthParams.x > 0.0) return depthParams.x * exp2(z * depthParams.z) - depthParams.y;
    float clipZ = reversed ? z : z * 2.0 - 1.0;
    return -(projection[3][2] - clipZ * projection[3][3]) / (clipZ * projection[2][3] - projection[2][2]);
}
float deviceDepth(float d) {
    if (d <= 0.0) return reversed && depthParams.x == 0.0 ? 0.0 : 1.0;
    if (depthParams.x > 0.0) return log2((d + depthParams.y) / depthParams.x) / depthParams.z;
    float z = (-projection[2][2] * d + projection[3][2]) / (-projection[2][3] * d + projection[3][3]);
    return reversed ? z : z * 0.5 + 0.5;
}
ivec2 bounded(ivec2 p) { return clamp(p, ivec2(0), ivec2(size) - 1); }
bool hitAt(ivec2 p) {
    float z = texelFetch(sourceDepth, p, 0).r;
    return texelFetch(source, p, 0).a > 0.0 && (reversed && depthParams.x == 0.0 ? z > 0.0 : z < 1.0);
}
float spatialDepth(ivec2 p) {
    float z = texelFetch(sourceDepth, p, 0).r;
    if (!hitAt(p)) {
        ivec2 quad = (p / 2) * 2;
        for (int y = 0; y < 2; ++y) for (int x = 0; x < 2; ++x) {
            float n = texelFetch(sourceDepth, bounded(quad + ivec2(x,y)), 0).r;
            z = reversed && depthParams.x == 0.0 ? max(z,n) : min(z,n);
        }
    }
    return z;
}
vec4 sampleAt(ivec2 p) {
    p = bounded(p);
    return hitAt(p) ? vec4(texelFetch(source, p, 0).rgb, 1.0) : vec4(0.0);
}
vec4 quadSample(ivec2 p) {
    vec2 u = (vec2(p) - 0.5) * 0.5;
    vec2 uv = (floor(u) * 2.0 + 1.0) / size;
    vec2 f = fract(u), stepSize = 2.0 / size;
    return mix(mix(textureLod(source, uv, 0.0), textureLod(source, uv + vec2(stepSize.x, 0.0), 0.0), f.x),
        mix(textureLod(source, uv + vec2(0.0, stepSize.y), 0.0), textureLod(source, uv + stepSize, 0.0), f.x), f.y);
}
`;
const fragmentShader = `${common}
uniform vec4 params;
uniform mat4 viewToPreviousClip;
uniform mat4 viewToPreviousView;
layout(location = 0) out uvec2 outColor;
layout(location = 1) out uint outInfo;
vec4 cubicWeights(float f) {
    float f2 = f * f, f3 = f2 * f;
    return vec4(-0.5*f3+f2-0.5*f, 1.5*f3-2.5*f2+1.0, -1.5*f3+2.0*f2+0.5*f, 0.5*f3-0.5*f2);
}
vec4 historyAt(vec2 uv) {
    vec2 p = uv * size - 0.5;
    ivec2 base = ivec2(floor(p));
    vec2 f = fract(p);
    vec4 wx = cubicWeights(f.x), wy = cubicWeights(f.y), sum = vec4(0.0);
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x)
        sum += decodeColor(texelFetch(historyColor, bounded(base + ivec2(x-1, y-1)), 0).rg) * wx[x] * wy[y];
    return sum;
}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    bool hit = hitAt(p), moving = params.z > 0.5;
    float d = viewDepth(texelFetch(sourceDepth, p, 0).r);
    vec2 own = params.y > 0.5 ? decodeInfo(texelFetch(historyInfo, p, 0).r) : vec2(0.0);
    vec4 sampleValue = moving ? quadSample(p) : sampleAt(p);
    vec2 uv = (vec2(p) + 0.5) / size, previousUV = uv;
    float carryDepth = hit ? d : own.x, previousDepth = carryDepth;
    bool valid = params.y > 0.5;
    if (moving) {
        valid = valid && (hit || own.x > 0.0);
        vec2 ndc = uv * 2.0 - 1.0;
        float viewZ = -carryDepth;
        float clipW = projection[2][3] * viewZ + projection[3][3];
        vec2 xy = (ndc * clipW - projection[2].xy * viewZ - projection[3].xy) / vec2(projection[0][0], projection[1][1]);
        vec4 viewPosition = vec4(xy, viewZ, 1.0);
        previousDepth = -(viewToPreviousView * viewPosition).z;
        vec4 previous = viewToPreviousClip * viewPosition;
        previousUV = previous.xy / max(previous.w, 1e-9) * 0.5 + 0.5;
        valid = valid && previous.w > 0.0 && all(greaterThanEqual(previousUV, vec2(0))) && all(lessThanEqual(previousUV, vec2(1)));
    }
    vec4 hist = vec4(0);
    vec2 info = vec2(0);
    if (valid) {
        hist = moving ? historyAt(previousUV) : decodeColor(texelFetch(historyColor, p, 0).rg);
        info = moving ? decodeInfo(texelFetch(historyInfo, bounded(ivec2(previousUV * size)), 0).r) : own;
    }
    vec4 color = sampleValue;
    float mean = hit ? d : 0.0, count = hit ? 1.0 : 0.0;
    if (!valid || info.y <= 0.5) {
        if (hit && !moving && params.y > 0.5) {
            count = clamp(params.w, 1.0, params.x);
            color = sampleValue / count;
        }
    } else {
        float cap = params.x;
        float depthMin = 1.0, depthMax = -1.0;
        if (moving) {
            vec4 m1 = vec4(0), m2 = vec4(0);
            vec4 spatialMin = sampleValue, spatialMax = sampleValue;
            vec2 quadUV = (vec2((p / 2) * 2) + 1.0) / size;
            for (int y = -1; y <= 1; ++y) for (int x = -1; x <= 1; ++x) {
                ivec2 q = bounded(p + ivec2(x,y));
                vec4 n = sampleAt(q); m1 += n; m2 += n*n;
                vec4 resolved = textureLod(source, quadUV + vec2(x,y) * 2.0 / size, 0.0);
                spatialMin = min(spatialMin, resolved);
                spatialMax = max(spatialMax, resolved);
                if (n.a > 0.0) {
                    float z = texelFetch(sourceDepth, q, 0).r;
                    depthMin = min(depthMin, z); depthMax = max(depthMax, z);
                }
            }
            vec4 mu = m1 / 9.0, sd = sqrt(max(m2 / 9.0 - mu*mu, vec4(0)));
            // Extend the original variance bounds to the resolved coverage. Never
            // tighten them: doing so suppresses sparse edges and temporal smoothing.
            hist = clamp(hist, min(mu - sd*1.25, spatialMin), max(mu + sd*1.25, spatialMax));
            float speed = length((previousUV - uv) * size);
            cap = max(2.0, cap / (1.0 + speed/4.0));
        }
        count = min(info.y + 1.0, cap);
        float w = 1.0 / count;
        color = mix(hist, sampleValue, w);
        if (sampleValue.a == 0.0) color.a = min(color.a, max(hist.a - 1.0/65535.0, 0.0));
        // Average valid hits; misses retain the depth carried into the current view.
        float shifted = max(info.x + carryDepth - previousDepth, 0.0);
        mean = hit ? mix(shifted, d, w) : shifted;
        if (moving) {
            // Old occluders must leave with the current surface, not fade through it.
            if (depthMax >= 0.0) {
                float a = viewDepth(depthMin), b = viewDepth(depthMax);
                mean = clamp(mean, min(a,b), max(a,b));
            }
            // Keep reprojection depth across misses so the sample count survives.
            // Color bounds still reject history outside the sampled coverage.
        }
    }
    color.a = clamp(color.a, 0.0, 1.0);
    color.rgb = clamp(color.rgb, vec3(0), vec3(color.a));
    outColor = uvec2(packUnorm2x16(color.rg), packUnorm2x16(color.ba));
    outInfo = (((floatBitsToUint(max(mean, 0.0)) + 0x80u) >> 8u) << 9u) | min(uint(count), 511u);
}
`;
const composeShader = `${common}
uniform vec4 params;
out vec4 fragColor;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    #ifdef TAA_TEMPORAL
    vec4 color = decodeColor(texelFetch(historyColor, p, 0).rg);
    vec2 info = decodeInfo(texelFetch(historyInfo, p, 0).r);
    if (params.z < 0.5 && info.y > 0.0 && info.y < ${TAA_MOVING_SAMPLES}.0) {
        // Display-only warmup for sparse first hits; keep full-resolution history.
        vec4 smoothColor = vec4(0.0);
        for (int y = -1; y <= 1; ++y) for (int x = -1; x <= 1; ++x) {
            float weight = float((2 - abs(x)) * (2 - abs(y)));
            smoothColor += decodeColor(texelFetch(historyColor, bounded(p + ivec2(x,y)), 0).rg) * weight;
        }
        color = mix(smoothColor / 16.0, color, info.y / ${TAA_MOVING_SAMPLES}.0);
    }
    #else
    vec4 color = quadSample(p);
    #endif
    bool reverseSelection = reversed && depthParams.x == 0.0;
    #ifdef TAA_TEMPORAL
    float sampledDepth = info.x;
    if (color.a <= 0.001) discard;
    #ifdef TAA_DEPTH_ONLY
    if (color.a < 0.1) discard;
    #endif
    float z = deviceDepth(sampledDepth);
    gl_FragDepth = sampledDepth > 0.0 ? (reverseSelection ? max(z, 1e-7) : min(z, 1.0-1e-7)) : z;
    #else
    if (color.a <= 0.001) discard;
    float z = spatialDepth(p);
    gl_FragDepth = reverseSelection ? max(z, 1e-7) : min(z, 1.0-1e-7);
    #endif
    fragColor = color;
}
`;

export function createWebGLTAAPipeline(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  size: THREE.Vector2,
  source: THREE.RenderTarget,
) {
  const history = createTAAHistory(renderer, camera, size);
  const uniforms = {
    source: { value: source.texture },
    sourceDepth: { value: source.depthTexture },
    historyColor: { value: history.input.texture },
    historyInfo: { value: history.input.textures[1] },
    size: { value: size },
    projection: { value: camera.projectionMatrix },
    depthParams: { value: history.depthParams },
    params: { value: history.params },
    reversed: { value: history.reversed },
    viewToPreviousClip: { value: history.viewToPreviousClip },
    viewToPreviousView: { value: history.viewToPreviousView },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    glslVersion: THREE.GLSL3,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const composeUniforms = {
    ...uniforms,
    historyColor: { value: history.output.texture },
    historyInfo: { value: history.output.textures[1] },
  };
  const createCompositeMaterial = (temporal: boolean, depthOnly = false) =>
    new THREE.ShaderMaterial({
      defines: temporal
        ? { TAA_TEMPORAL: 1, ...(depthOnly ? { TAA_DEPTH_ONLY: 1 } : {}) }
        : {},
      uniforms: composeUniforms,
      vertexShader,
      fragmentShader: composeShader,
      glslVersion: THREE.GLSL3,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      depthTest: true,
      depthWrite: !temporal || depthOnly,
      colorWrite: !depthOnly,
      toneMapped: false,
    });
  const compositeMaterial = createCompositeMaterial(true);
  const depthMaterial = createCompositeMaterial(true, true);
  const compositeMaterials = [compositeMaterial, depthMaterial];
  const spatialMaterial = createCompositeMaterial(false);
  // Keep faint color depth-tested without letting it occlude later geometry.
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(0, 3, 1);
  const composite: THREE.Mesh = new THREE.Mesh(geometry, compositeMaterials);
  composite.frustumCulled = false;
  const fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    composite,
    get needsRender() {
      return history.needsRender;
    },
    reset: () => history.reset(),
    resolve(version: number, temporalEnabled = true) {
      composite.material = temporalEnabled
        ? compositeMaterials
        : spatialMaterial;
      if (!temporalEnabled) {
        history.updateDepthParams();
        return;
      }
      history.begin(version);
      uniforms.historyColor.value = history.input.texture;
      uniforms.historyInfo.value = history.input.textures[1];
      setRendererRenderTarget(renderer, history.output);
      renderer.render(mesh, fullscreenCamera);
      composeUniforms.historyColor.value = history.output.texture;
      composeUniforms.historyInfo.value = history.output.textures[1];
      history.commit();
    },
    dispose() {
      history.dispose();
      material.dispose();
      compositeMaterial.dispose();
      depthMaterial.dispose();
      spatialMaterial.dispose();
      geometry.dispose();
    },
  };
}
