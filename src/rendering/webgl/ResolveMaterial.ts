import * as THREE from "three";
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

out vec4 fragColor;

vec4 loadSource(ivec2 coord) {
    return texelFetch(sourceTexture,
        sourceRect.xy + clamp(coord, ivec2(0), sourceRect.zw - 1), 0);
}

vec3 perceptualToLinear(vec3 color) {
    return pow(max(color, vec3(0.0)), vec3(2.2));
}

vec4 physicalSource(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 color = texel.rgb;
    if (sourceEncoded) {
        vec3 straight = alpha > 0.0 ? color / alpha : vec3(0.0);
        color = perceptualToLinear(straight) * alpha;
    }
    return vec4(color, alpha);
}

vec4 resolveStochasticFrame(ivec2 source) {
    vec2 u = (vec2(source) - vec2(0.5)) * 0.5;
    vec2 quad = floor(u);
    vec2 fraction = u - quad;
    ivec2 base = ivec2(quad) * 2;

    vec2 nearWeights = (vec2(1.0) - fraction) * 0.5;
    vec2 farWeights = fraction * 0.5;

    bool hasSplat = false;
    vec4 accumulated = vec4(0.0);

    for (int y = 0; y < 4; ++y) {
        float weightY = y < 2 ? nearWeights.y : farWeights.y;
        for (int x = 0; x < 4; ++x) {
            float weightX = x < 2 ? nearWeights.x : farWeights.x;
            vec4 sourceTexel = loadSource(base + ivec2(x, y));
            float weight = weightX * weightY;
            // Filter in the source's blend space. Alpha-2 marks an opaque sample.
            float alpha = clamp(sourceTexel.a, 0.0, 1.0);
            vec4 texel = vec4(alpha > 0.0 ? sourceTexel.rgb : vec3(0.0), alpha);
            // Integer pixel coordinates give fractions of 1/4 or 3/4, so all
            // tap weights are positive; only marker presence matters.
            hasSplat = hasSplat || sourceTexel.a > 1.0;
            accumulated += weight * texel;
        }
    }

    return physicalSource(hasSplat ? accumulated : loadSource(source));
}

vec4 workingToOutput(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 color = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
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
        : physicalSource(loadSource(source));
    fragColor = workingToOutput(result);
    gl_FragDepth = copyDepth
        ? texelFetch(sourceDepth, sourceRect.xy + source, 0).r
        : gl_FragCoord.z;
}
`;

export function createWebGLResolveMaterial(state: ResolveState) {
  return new THREE.ShaderMaterial({
    name: "GaussianSplatStochasticResolve",
    glslVersion: THREE.GLSL3,
    vertexShader: resolveVertexShader,
    fragmentShader: resolveFragmentShader,
    uniforms: {
      sourceTexture: state.sourceTexture,
      sourceDepth: state.sourceDepth,
      sourceRect: { value: state.sourceRect },
      outputOrigin: { value: state.outputOrigin },
      copyDepth: state.copyDepth,
      resolveStochastic: state.resolve,
      sourceEncoded: state.sourceEncoded,
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
