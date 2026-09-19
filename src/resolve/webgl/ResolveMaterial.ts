import * as THREE from "three";
import { MOVING_HISTORY_SAMPLES } from "../StochasticHistory";
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
uniform sampler2D sourceDepth;
uniform ivec4 sourceRect;
uniform ivec2 outputOrigin;
uniform bool copyDepth;
uniform bool resolveStochastic;
uniform bool sourceEncoded;

layout(location = 0) out vec4 fragColor;
#ifdef WRITE_HISTORY
layout(location = 1) out float fragSamples;
uniform float historyWeight;
uniform sampler2D historyColor;
uniform sampler2D historyDepth;
uniform sampler2D historySamples;
uniform mat4 historyReproject;
uniform mat4 historyDepthToView;
uniform vec3 historyLogDepth;
uniform vec2 historyDepthProjection;
float sampleCount = 1.0;

float hardwareDepth(float depth) {
    if (historyLogDepth.x == 0.0) return depth;
    float viewZ = historyLogDepth.y - historyLogDepth.x * exp2(depth * historyLogDepth.z);
    return historyDepthProjection.x + historyDepthProjection.y / viewZ;
}

vec4 reprojectHistory(ivec2 source, vec4 current, vec4 neighborhoodMin, vec4 neighborhoodMax) {
    if (historyWeight == 0.0) return current;
    vec2 uv = (vec2(source) + 0.5) / vec2(sourceRect.zw);
    float depth = hardwareDepth(texelFetch(sourceDepth, sourceRect.xy + source, 0).r);
    vec4 projected = historyReproject * vec4(uv, depth, 1.0);
    if (projected.w <= 0.0) return current;
    vec3 previous = projected.xyz / projected.w;
    if (any(lessThan(previous, vec3(0.0))) || any(greaterThan(previous, vec3(1.0)))) return current;
    vec4 expected = historyDepthToView * vec4(previous, 1.0);
    if (abs(expected.w) <= 1e-8) return current;
    float viewZ = expected.z / expected.w;
    vec2 position = previous.xy * vec2(sourceRect.zw) - 0.5;
    ivec2 base = ivec2(floor(position));
    vec2 fraction = fract(position);
    vec4 historySum = vec4(0.0);
    float validWeight = 0.0;
    float sampleSum = 0.0;
    // Validate each depth before bilinear interpolation, so newly exposed
    // surfaces do not inherit color from the old foreground.
    for (int y = 0; y < 2; ++y) {
        for (int x = 0; x < 2; ++x) {
            ivec2 coord = base + ivec2(x, y);
            float weight = (x == 0 ? 1.0 - fraction.x : fraction.x)
                * (y == 0 ? 1.0 - fraction.y : fraction.y);
            if (weight > 0.0 && all(greaterThanEqual(coord, ivec2(0))) && all(lessThan(coord, sourceRect.zw))) {
                vec2 tapUv = (vec2(coord) + 0.5) / vec2(sourceRect.zw);
                float oldDepth = hardwareDepth(texelFetch(historyDepth, sourceRect.xy + coord, 0).r);
                vec4 actual = historyDepthToView * vec4(tapUv, oldDepth, 1.0);
                if (abs(actual.w) > 1e-8 && abs(actual.z / actual.w - viewZ) < max(0.01, abs(viewZ) * 0.02)) {
                    historySum += texelFetch(historyColor, sourceRect.xy + coord, 0) * weight;
                    sampleSum += texelFetch(historySamples, sourceRect.xy + coord, 0).r * weight;
                    validWeight += weight;
                }
            }
        }
    }
    if (validWeight == 0.0) return current;
    vec4 previousColor = historySum / validWeight;
    vec4 history = clamp(previousColor, neighborhoodMin, neighborhoodMax);
    // Fade small color excursions; reject changes beyond 10% of the local
    // range, with a 0.01 floor for nearly uniform neighborhoods.
    vec4 colorTolerance = max((neighborhoodMax - neighborhoodMin) * 0.1, vec4(0.01));
    vec4 colorError = abs(history - previousColor) / colorTolerance;
    float colorConfidence = max(0.0, 1.0 - max(max(colorError.r, colorError.g), max(colorError.b, colorError.a)));
    if (colorConfidence == 0.0) return current;
    float motion = length((previous.xy - uv) * vec2(sourceRect.zw));
    float count = min(sampleSum / validWeight, float(${MOVING_HISTORY_SAMPLES - 1}))
        * colorConfidence
        * max(0.0, 1.0 - motion / 64.0);
    sampleCount = count + 1.0;
    return mix(current, history, count / sampleCount);
}
#endif

vec4 loadSource(ivec2 coord) {
    return texelFetch(sourceTexture,
        sourceRect.xy + clamp(coord, ivec2(0), sourceRect.zw - 1), 0);
}

vec4 sourceColor(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    return vec4(alpha > 0.0 ? texel.rgb : vec3(0.0), alpha);
}

vec4 resolveStochasticFrame(ivec2 source) {
    const int filterSize = SPATIAL_FILTER_SIZE;
    // Odd kernels split into unequal blocks; interpolate between their centers.
    const int nearSize = filterSize / 2;
    const float centerDistance = float(filterSize) * 0.5;
    const float nearCenter = float(nearSize - 1) * 0.5;
    vec2 u = (vec2(source) - vec2(nearCenter)) / centerDistance;
    ivec2 base = ivec2(floor(floor(u) * centerDistance));
    vec2 fraction = (vec2(source - base) - vec2(nearCenter)) / centerDistance;

    vec2 nearWeights = (vec2(1.0) - fraction) / float(nearSize);
    vec2 farWeights = fraction / float(filterSize - nearSize);

    bool hasSplat = false;
    vec4 accumulated = vec4(0.0);
    #ifdef WRITE_HISTORY
        vec4 neighborhoodMin = vec4(1e20);
        vec4 neighborhoodMax = vec4(-1e20);
    #endif

    for (int y = 0; y < filterSize; ++y) {
        float weightY = y < nearSize ? nearWeights.y : farWeights.y;
        for (int x = 0; x < filterSize; ++x) {
            float weightX = x < nearSize ? nearWeights.x : farWeights.x;
            float weight = weightX * weightY;
            if (weight <= 0.0) continue;
            vec4 sourceTexel = loadSource(base + ivec2(x, y));
            // Filter in the source's blend space. Alpha-2 marks an opaque sample.
            vec4 texel = sourceColor(sourceTexel);
            hasSplat = hasSplat || sourceTexel.a > 1.0;
            accumulated += weight * texel;
            #ifdef WRITE_HISTORY
                neighborhoodMin = min(neighborhoodMin, texel);
                neighborhoodMax = max(neighborhoodMax, texel);
            #endif
        }
    }

    if (!hasSplat) return sourceColor(loadSource(source));
    #ifdef WRITE_HISTORY
        return reprojectHistory(source, accumulated, neighborhoodMin, neighborhoodMax);
    #else
        return accumulated;
    #endif
}

vec4 sourceToOutput(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 color = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
    if (sourceEncoded) {
        // Decode after averaging in the scene's blend space.
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
    vec4 result = resolveStochastic
        ? resolveStochasticFrame(source)
        : sourceColor(loadSource(source));
    #ifdef WRITE_HISTORY
        fragColor = result;
        fragSamples = sampleCount;
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
  filterSize: number,
  writeHistory = false,
) {
  return new THREE.ShaderMaterial({
    name: "GaussianSplatStochasticResolve",
    glslVersion: THREE.GLSL3,
    vertexShader: resolveVertexShader,
    fragmentShader: resolveFragmentShader,
    defines: {
      SPATIAL_FILTER_SIZE: filterSize,
      ...(writeHistory ? { WRITE_HISTORY: 1 } : {}),
    },
    uniforms: {
      sourceTexture: state.sourceTexture,
      sourceDepth: state.sourceDepth,
      sourceRect: { value: state.sourceRect },
      outputOrigin: { value: state.outputOrigin },
      copyDepth: state.copyDepth,
      resolveStochastic: state.resolve,
      sourceEncoded: state.sourceEncoded,
      historyWeight: state.history.weight,
      historyColor: state.history.color,
      historyDepth: state.history.depth,
      historySamples: state.history.samples,
      historyReproject: { value: state.history.reproject },
      historyDepthToView: { value: state.history.depthToView },
      historyLogDepth: { value: state.history.logDepth },
      historyDepthProjection: { value: state.history.depthProjection },
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
