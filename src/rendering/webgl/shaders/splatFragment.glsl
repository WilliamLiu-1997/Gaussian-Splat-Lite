
precision highp float;
precision highp int;

uniform float minAlpha;
uniform vec2 edgeFade;
#if GSL_STOCHASTIC
uniform highp usampler2D stochasticNoise;
#endif

out vec4 fragColor;

flat in uvec4 vSplat;
in vec2 vSplatUv;
#if GSL_STOCHASTIC
// Noise tile offset: x in bits 0-4, y from bit 5.
flat in uint vStochasticOffset;
#endif

#include <logdepthbuf_pars_fragment>

#pragma GSL_EFFECT_FRAGMENT_PARS

void main() {
    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > uintBitsToFloat(vSplat.w)) {
        discard;
    }

    vec2 blueKernelPower = unpackHalf2x16(vSplat.y);
    float kernelPower = blueKernelPower.y;
    float kernelAlpha = exp(-0.5 * z2);
    float alpha = uintBitsToFloat(vSplat.z);
    // A kernel still above minAlpha where its support ends fades to minAlpha
    // there: it is rescaled about its peak. A Gaussian's fade follows from
    // its alpha; a wide kernel carries its own in the low half of its squared
    // radius.
    float fade;
    if (kernelPower != 0.0) {
        kernelAlpha = 1.0 - pow(1.0 - kernelAlpha, kernelPower);
        fade = unpackHalf2x16(vSplat.w).x;
    } else {
        fade = max(alpha * edgeFade.x - edgeFade.y, 0.0);
    }
    alpha = (alpha + fade) * kernelAlpha - fade;

    #pragma GSL_EFFECT_OPACITY
    if (alpha <= 0.0 || alpha < minAlpha) {
        discard;
    }
    #if GSL_STOCHASTIC
    // Match TSL: quadratic block offsets break short spatial repetitions
    // without changing the STBN time sequence.
    uvec2 offset = uvec2(vStochasticOffset, vStochasticOffset >> 5u) & uvec2(31u);
    uvec2 pixel = uvec2(gl_FragCoord.xy) + offset;
    uvec2 tile = pixel >> 5u;
    uvec2 shift = ((tile * (tile + 1u)) >> 1u) + tile.x * tile.y + tile.yx;
    ivec2 coord = ivec2((pixel + shift) & uvec2(31u));
    coord.y += int(vStochasticOffset >> 10u) * 32;
    float randomValue = (float(texelFetch(stochasticNoise, coord, 0).r) + 0.5) / 32768.0;
    #ifdef GSL_COVERAGE_SAMPLES
    // Matches the four stratified decisions in tsl/stochasticCoverage.js.
    int mask = 0;
    for (int sampleIndex = 0; sampleIndex < 4; sampleIndex++) {
        if (fract(randomValue + float(sampleIndex) * 0.25) < alpha) mask |= 1 << sampleIndex;
    }
    if (mask == 0) discard;
    gl_SampleMask[0] = mask;
    #else
    if (randomValue >= alpha) {
        discard;
    }
    #endif
    #endif

    // Decode color only after the fragment survives coverage tests.
    vec4 rgba = vec4(unpackHalf2x16(vSplat.x), blueKernelPower.x, alpha);

    #pragma GSL_EFFECT_FRAGMENT
    #if GSL_STOCHASTIC
        fragColor = vec4(rgba.rgb, 1.0);
    #elif defined(PREMULTIPLIED_ALPHA)
        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);
    #else
        fragColor = rgba;
    #endif

    #include <logdepthbuf_fragment>
}
