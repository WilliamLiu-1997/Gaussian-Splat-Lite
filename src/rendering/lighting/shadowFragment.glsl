precision highp float;
precision highp int;
precision highp usampler2D;
flat in vec3 shadowKernel;
flat in uint shadowSeed;
in vec2 shadowUv;
uniform usampler2D stochasticNoise;
uniform vec2 viewportOrigin;
uniform float minAlpha;
out vec4 fragColor;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
in vec2 shadowDepth;
uniform float logDepthBufFC;
#endif

void main() {
    float r2 = dot(shadowUv, shadowUv);
    if (r2 > shadowKernel.z) discard;
    float coverage = exp(-0.5 * r2);
    if (shadowKernel.y > 0.0) coverage = 1.0 - pow(1.0 - coverage, shadowKernel.y);
    coverage *= shadowKernel.x;
    if (coverage < minAlpha) discard;
    uvec2 pixel = uvec2(gl_FragCoord.xy - viewportOrigin);
    ivec2 coord = ivec2((pixel + uvec2(shadowSeed, shadowSeed >> 5u)) & uvec2(31u));
    if ((float(texelFetch(stochasticNoise, coord, 0).r) + 0.5) / 1024.0 >= coverage) discard;
    fragColor = vec4(0.0);
    #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    gl_FragDepth = isOrthographic ? 0.5 * shadowDepth.x + 0.5
        : log2(1.0 + 1.0 / shadowDepth.y) * logDepthBufFC * 0.5;
    #endif
}
