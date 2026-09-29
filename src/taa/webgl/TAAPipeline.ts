import * as THREE from "three";
import { setRendererRenderTarget } from "../../rendering/rendererUtils";
import { TAA_DEPTH_PROBES, createTAAHistory } from "../TAAHistory";

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
bool isHit(float alpha, float z) {
    return alpha > 0.0 && (reversed && depthParams.x == 0.0 ? z > 0.0 : z < 1.0);
}
bool hitAt(ivec2 p) { return isHit(texelFetch(source, p, 0).a, texelFetch(sourceDepth, p, 0).r); }
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
const ivec2 depthProbes[${TAA_DEPTH_PROBES.length}] = ivec2[](${TAA_DEPTH_PROBES.map(([x, y]) => `ivec2(${x},${y})`).join(", ")});
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
    // Catmull-Rom without its four corner taps (each weight <= (2/27)^2 ~ 0.0055).
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
        if ((x == 0 || x == 3) && (y == 0 || y == 3)) continue;
        sum += decodeColor(texelFetch(historyColor, bounded(base + ivec2(x-1, y-1)), 0).rg) * wx[x] * wy[y];
    }
    // The corners sum to (wx.x + wx.w) * (wy.x + wy.w); renormalise without them.
    return sum / (1.0 - (wx.x + wx.w) * (wy.x + wy.w));
}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 center = texelFetch(source, p, 0);
    float centerDepth = texelFetch(sourceDepth, p, 0).r;
    bool hit = isHit(center.a, centerDepth), moving = params.z > 0.5;
    float d = viewDepth(centerDepth);
    vec2 own = params.y > 0.5 ? decodeInfo(texelFetch(historyInfo, p, 0).r) : vec2(0.0);
    vec4 sampleValue = moving ? quadSample(p) : hit ? vec4(center.rgb, 1.0) : vec4(0.0);
    vec2 uv = (vec2(p) + 0.5) / size, previousUV = uv;
    float depthMin = 1.0, depthMax = -1.0, nearDepth = 0.0, farDepth = 0.0;
    vec4 m1 = vec4(0), m2 = vec4(0);
    if (moving && sampleValue.a > 0.0) {
        // Read the 4x4 block quadSample covers once (zero coverage means no hits):
        // misses borrow its nearest depth so every covered pixel reprojects,
        // occluders use its depth range, and the clamp its inner 3x3 moments.
        ivec2 block = ivec2(floor((vec2(p) - 0.5) * 0.5)) * 2;
        for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
            ivec2 o = block + ivec2(x,y), q = bounded(o);
            vec4 s = texelFetch(source, q, 0);
            float z = texelFetch(sourceDepth, q, 0).r;
            if (!isHit(s.a, z)) continue;
            depthMin = min(depthMin, z); depthMax = max(depthMax, z);
            if (all(lessThanEqual(abs(o - p), ivec2(1)))) {
                vec4 n = vec4(s.rgb, 1.0);
                m1 += n; m2 += n*n;
            }
        }
        if (depthMax >= 0.0) {
            float a = viewDepth(depthMin), b = viewDepth(depthMax);
            nearDepth = min(a,b); farDepth = max(a,b);
        }
    }
    // Misses without their own depth borrow the nearest hit in that block, so
    // sparse edges keep reprojecting instead of resetting every other frame.
    float carryDepth = hit ? d : own.x > 0.0 ? own.x : nearDepth;
    // A sparse edge entering empty screen has no depth here or in the block:
    // guess from the closest surface around it in the previous history instead.
    bool guessed = moving && params.y > 0.5 && carryDepth <= 0.0;
    if (guessed) for (int i = 0; i < ${TAA_DEPTH_PROBES.length}; ++i) {
        vec2 n = decodeInfo(texelFetch(historyInfo, bounded(p + depthProbes[i]), 0).r);
        if (n.y > 0.0 && n.x > 0.0) { carryDepth = n.x; break; }
    }
    float previousDepth = carryDepth;
    bool valid = params.y > 0.5;
    if (moving) {
        valid = valid && (hit || carryDepth > 0.0);
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
    if (valid && moving) {
        hist = historyAt(previousUV);
        // Take the most-sampled texel under the footprint: a nearest lookup lets
        // one reset neighbour restart a sparse edge pixel's sample count.
        ivec2 base = ivec2(floor(previousUV * size - 0.5));
        for (int y = 0; y < 2; ++y) for (int x = 0; x < 2; ++x) {
            vec2 n = decodeInfo(texelFetch(historyInfo, bounded(base + ivec2(x,y)), 0).r);
            if (n.y > info.y) info = n;
        }
        // Accept a guessed depth only where the history holds a surface at it;
        // this also keeps trailing edges from dragging history behind them.
        if (guessed && abs(info.x - previousDepth) > previousDepth * 0.25) info = vec2(0);
    } else if (valid) {
        hist = decodeColor(texelFetch(historyColor, p, 0).rg);
        info = own;
    }
    vec4 color = sampleValue;
    float mean = hit ? d : 0.0, count = hit ? 1.0 : 0.0;
    if (!valid || info.y <= 0.5) {
        if (hit && !moving && params.y > 0.5) {
            count = clamp(params.w, 1.0, params.x);
            color = sampleValue / count;
        }
        // Seed covered misses as well: otherwise the quadSample rim beyond the last
        // hit never joins the history and keeps flickering outside it.
        if (moving && valid && !hit && sampleValue.a > 0.0) {
            count = 1.0;
            mean = carryDepth;
        }
    } else {
        float cap = params.x;
        if (moving) {
            vec4 mu = m1 / 9.0, sd = sqrt(max(m2 / 9.0 - mu*mu, vec4(0)));
            // An empty 3x3 is expected where coverage is sparse and would clamp the
            // history to zero. Let the upper bound admit the binomial noise that the
            // history's own coverage predicts for 9 samples, so sparse edges persist
            // while dense history keeps the tight bounds.
            float a = clamp(hist.a, 1e-4, 1.0);
            vec4 noise = max(hist, vec4(0)) * (1.5 * sqrt((1.0 - a) / (9.0 * a)));
            hist = clamp(hist, mu - sd*1.25, mu + max(sd*1.25, noise));
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
            if (depthMax >= 0.0) mean = clamp(mean, nearDepth, farDepth);
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
