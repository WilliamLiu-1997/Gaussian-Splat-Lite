import * as THREE from "three";
import {
  HISTORY_SAMPLES,
  HISTORY_TRANSITION_FRAMES,
  MOVING_HISTORY_SAMPLES,
  SPATIAL_SMOOTHING,
  SPATIAL_SMOOTHING_MIN_WEIGHT,
} from "../StochasticHistory";
import type { ResolveState } from "../StochasticResolvePass";

const resolveVertexShader = /* glsl */ `
precision highp float;

void main() {
    gl_Position = vec4(position, 1.0);
}
`;

const resolveFragmentShader = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D sourceTexture;
uniform sampler2D splatMask;
uniform float spatialStrength;
uniform sampler2D sourceDepth;
uniform ivec4 sourceRect;
uniform ivec2 outputOrigin;
uniform bool copyDepth;
uniform bool resolveStochastic;
uniform bool resolveDepth;
uniform bool sourceEncoded;
uniform bool temporalActive;
uniform bool stationaryHistory;
uniform float historyWeight;
uniform sampler2D historyColor;
uniform sampler2D historyDepth;
uniform sampler2D historySamples;
uniform bool presentHistory;
uniform mat4 historyReproject;
uniform mat4 historyDepthToView;

layout(location = 0) out vec4 fragColor;
#ifdef WRITE_HISTORY
layout(location = 1) out vec2 fragSamples;
#endif
const float historySampleLimit = float(${HISTORY_SAMPLES});
const float movingHistorySampleLimit = float(${MOVING_HISTORY_SAMPLES});
const int spatialKernel = ${SPATIAL_SMOOTHING};
float sampleCount = 1.0;
float sampleMarker = 0.0;

vec4 loadSource(ivec2 coord) {
    return texelFetch(sourceTexture,
        sourceRect.xy + clamp(coord, ivec2(0), sourceRect.zw - 1), 0);
}

vec4 sourceColor(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    // Keep history in the scene's blend space, matching the node renderers.
    return vec4(alpha > 0.0 ? texel.rgb : vec3(0.0), alpha);
}

float spatialWeight(int tap, int pixel, float quadWeight) {
    if (spatialKernel == 2) {
        int quadStart = (pixel / 2) * 2;
        return tap >= quadStart && tap < quadStart + 2 ? 0.5 : 0.0;
    }
    if (spatialKernel == 3) return max(0.0, 2.0 - abs(float(tap - pixel))) * 0.25;
    return quadWeight;
}

vec4 resolveStochasticFrame(ivec2 source, float strength) {
    vec4 sourceTexel = loadSource(source);
    vec4 current = sourceColor(sourceTexel);
    sampleMarker = sourceTexel.a == 2.0 ? 2.0 : 0.0;
    vec2 u = (vec2(source) - vec2(0.5)) * 0.5;
    vec2 quad = floor(u);
    vec2 fraction = u - quad;
    ivec2 base = ivec2(quad) * 2;

    vec2 nearWeights = (vec2(1.0) - fraction) * 0.5;
    vec2 farWeights = fraction * 0.5;

    // The depth companion writes no alpha marker. Its coverage noise is in
    // the final scene color, so this mode resolves the complete frame.
    bool hasSplat = resolveDepth;
    bool allSplat = true;
    vec4 accumulated = vec4(0.0);
    vec4 neighborhoodMin = vec4(1e20);
    vec4 neighborhoodMax = vec4(-1e20);
    float depthMin = 1.0;
    float depthMax = 0.0;
    float previousDepthMin = 1.0;
    float previousDepthMax = 0.0;

    for (int y = 0; y < 4; ++y) {
        float weightY = spatialWeight(base.y + y, source.y, y < 2 ? nearWeights.y : farWeights.y);
        for (int x = 0; x < 4; ++x) {
            float weightX = spatialWeight(base.x + x, source.x, x < 2 ? nearWeights.x : farWeights.x);
            ivec2 coord = clamp(base + ivec2(x, y), ivec2(0), sourceRect.zw - 1);
            vec4 sourceTexel = texelFetch(sourceTexture, sourceRect.xy + coord, 0);
            float weight = weightX * weightY;
            // Filter in the source's blend space. Alpha-2 marks an opaque sample.
            vec4 texel = sourceColor(sourceTexel);
            // Keep the full neighborhood for coverage detection and history clipping.
            float marker = presentHistory
                ? texelFetch(splatMask, sourceRect.xy + coord, 0).a
                : sourceTexel.a;
            hasSplat = hasSplat || marker > 1.0;
            allSplat = allSplat && sourceTexel.a == 2.0;
            if (spatialKernel > 0) accumulated += weight * texel;
            if (temporalActive) {
                neighborhoodMin = min(neighborhoodMin, texel);
                neighborhoodMax = max(neighborhoodMax, texel);
                if (stationaryHistory) {
                    float tapDepth = texelFetch(sourceDepth, coord, 0).r;
                    float previousDepth = texelFetch(historyDepth, coord, 0).r;
                    depthMin = min(depthMin, tapDepth);
                    depthMax = max(depthMax, tapDepth);
                    previousDepthMin = min(previousDepthMin, previousDepth);
                    previousDepthMax = max(previousDepthMax, previousDepth);
                }
            }
        }
    }

    // Stationary history uses raw samples; spatial smoothing only fades over
    // the presentation. History validation still runs for every scene pixel.
    if (spatialKernel > 0 && hasSplat && !(temporalActive && stationaryHistory)) {
        current = mix(current, sourceColor(accumulated), strength);
        // Moving-frame filtering can mix ordinary pixels into a Splat.
        sampleMarker = allSplat ? 2.0 : 0.0;
    }
    if (temporalActive && hasSplat && historyWeight > 0.0) {
        vec2 uv = (vec2(source) + 0.5) / vec2(sourceRect.zw);
        float depth = texelFetch(sourceDepth, source, 0).r;
        vec4 projected = stationaryHistory
            ? vec4(uv, depth, 1.0)
            : historyReproject * vec4(uv, depth, 1.0);
        if (projected.w > 0.0) {
            vec3 previous = projected.xyz / projected.w;
            if (all(greaterThanEqual(previous, vec3(0.0))) && all(lessThanEqual(previous, vec3(1.0)))) {
                vec4 expected = historyDepthToView * vec4(previous, 1.0);
                if (stationaryHistory || abs(expected.w) > 1e-8) {
                    float viewZ = expected.z / expected.w;
                    vec2 position = previous.xy * vec2(sourceRect.zw) - 0.5;
                    // Avoid bilinear rounding/blur for an unchanged camera.
                    ivec2 historyBase = stationaryHistory ? source : ivec2(floor(position));
                    vec2 historyFraction = stationaryHistory ? vec2(0.0) : fract(position);
                    vec4 historySum = vec4(0.0);
                    float validWeight = 0.0;
                    float sampleSum = 0.0;
                    bool historyIsSplat = true;
                    // Reject individual depths before interpolating history.
                    for (int y = 0; y < 2; ++y) {
                        for (int x = 0; x < 2; ++x) {
                            ivec2 coord = historyBase + ivec2(x, y);
                            float tapWeight = (x == 0 ? 1.0 - historyFraction.x : historyFraction.x)
                                * (y == 0 ? 1.0 - historyFraction.y : historyFraction.y);
                            if (tapWeight > 0.0 && all(greaterThanEqual(coord, ivec2(0))) && all(lessThan(coord, sourceRect.zw))) {
                                vec2 tapUv = (vec2(coord) + 0.5) / vec2(sourceRect.zw);
                                float oldDepth = texelFetch(historyDepth, coord, 0).r;
                                vec4 actual = historyDepthToView * vec4(tapUv, oldDepth, 1.0);
                                // Stochastic coverage can switch surfaces at one
                                // pixel. A static camera compares both frames'
                                // neighborhood depth ranges instead.
                                bool validDepth = stationaryHistory
                                    ? depthMin <= previousDepthMax && previousDepthMin <= depthMax
                                    : abs(actual.w) > 1e-8 && abs(actual.z / actual.w - viewZ) < max(0.01, abs(viewZ) * 0.02);
                                if (validDepth) {
                                    vec4 historyTap = texelFetch(historyColor, coord, 0);
                                    historySum += historyTap * tapWeight;
                                    validWeight += tapWeight;
                                    vec2 historyInfo = texelFetch(historySamples, coord, 0).rg;
                                    historyIsSplat = historyIsSplat && historyInfo.g == 2.0;
                                    sampleSum += historyInfo.r * tapWeight;
                                }
                            }
                        }
                    }
                    if (validWeight > 0.0) {
                        vec4 previousColor = historySum / validWeight;
                        // Random coverage can vary pure Splat colors. Mixed history
                        // must keep clipping and updating until it is discarded.
                        bool pureSplatHistory = stationaryHistory && sampleMarker == 2.0 && historyIsSplat;
                        vec4 history = pureSplatHistory ? previousColor
                            : clamp(previousColor, neighborhoodMin, neighborhoodMax);
                        float motion = stationaryHistory ? 0.0 : length((previous.xy - uv) * vec2(sourceRect.zw));
                        float limit = stationaryHistory ? historySampleLimit : movingHistorySampleLimit;
                        float count = min(sampleSum / validWeight, pureSplatHistory ? limit : limit - 1.0) * max(0.0, 1.0 - motion / 64.0);
                        // Color clipping also invalidates the old sample count,
                        // including transparent changes that leave depth intact.
                        if (any(greaterThan(abs(history - previousColor), vec4(1e-4)))) count = 0.0;
                        // Track the entire accumulated color, not just the last frame.
                        if (count > 0.0 && !historyIsSplat) sampleMarker = 0.0;
                        sampleCount = min(count + 1.0, limit);
                        current = mix(current, history, count / sampleCount);
                    }
                }
            }
        }
    }
    return current;
}

vec4 sourceToOutput(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 color = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
    if (sourceEncoded) {
        // Decode only for output, after spatial and temporal averaging.
        color = sRGBTransferEOTF(vec4(max(color, vec3(0.0)), 1.0)).rgb;
    }
    #if defined(TONE_MAPPING)
        if (!sourceEncoded) color = toneMapping(color);
    #endif
    color = linearToOutputTexel(vec4(color, 1.0)).rgb;
    return vec4(color * alpha, alpha);
}

void main() {
    ivec2 source = ivec2(gl_FragCoord.xy) - outputOrigin;
    float strength = spatialStrength;
    if (presentHistory && stationaryHistory) {
        // Locally rejected history needs smoothing again, even after the camera
        // has stopped for a long time. Fade it by valid samples, not elapsed time.
        float count = texelFetch(historySamples, source, 0).r;
        strength = max(strength, max(0.0, 1.0 - count / float(${HISTORY_TRANSITION_FRAMES})));
        strength = mix(float(${SPATIAL_SMOOTHING_MIN_WEIGHT}), 1.0, strength);
    }
    vec4 result = resolveStochastic || (presentHistory && spatialKernel > 0 && strength > 0.0)
        ? resolveStochasticFrame(source, strength)
        : sourceColor(loadSource(source));
    #ifdef WRITE_HISTORY
        fragColor = result;
        fragSamples = vec2(sampleCount, sampleMarker);
    #else
        fragColor = sourceToOutput(result);
    #endif
    gl_FragDepth = copyDepth
        ? texelFetch(sourceDepth, sourceRect.xy + source, 0).r
        : gl_FragCoord.z;
}
`;

export function createWebGLResolveMaterial(
  state: ResolveState,
  writeHistory = false,
) {
  return new THREE.ShaderMaterial({
    name: "GaussianSplatStochasticResolve",
    glslVersion: THREE.GLSL3,
    vertexShader: resolveVertexShader,
    fragmentShader: resolveFragmentShader,
    defines: writeHistory ? { WRITE_HISTORY: 1 } : {},
    uniforms: {
      sourceTexture: state.sourceTexture,
      splatMask: state.splatMask,
      spatialStrength: state.spatialStrength,
      sourceDepth: state.sourceDepth,
      sourceRect: { value: state.sourceRect },
      outputOrigin: { value: state.outputOrigin },
      copyDepth: state.copyDepth,
      resolveStochastic: state.resolve,
      resolveDepth: state.resolveDepth,
      sourceEncoded: state.sourceEncoded,
      temporalActive: state.history.active,
      stationaryHistory: state.history.stationary,
      historyWeight: state.history.weight,
      historyColor: state.history.color,
      historyDepth: state.history.depth,
      historySamples: state.history.samples,
      presentHistory: state.presentHistory,
      historyReproject: { value: state.history.reproject },
      historyDepthToView: { value: state.history.depthToView },
    },
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    depthFunc: THREE.AlwaysDepth,
    transparent: true,
    premultipliedAlpha: true,
    toneMapped: true,
  });
}
