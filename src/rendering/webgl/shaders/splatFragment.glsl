
precision highp float;
precision highp int;

uniform float minAlpha;
uniform bool stochastic;
uniform int stochasticTemporalFrame;
uniform bool depthOnly;
uniform highp usampler2D stochasticNoise;
uniform vec2 viewportOrigin;

out vec4 fragColor;

flat in uvec4 vSplat;
in vec2 vSplatUv;
flat in uint vStochasticHash;

#include <logdepthbuf_pars_fragment>

// SuperSplat's per-quad stratification, independently scrambled for every frame/Splat.
uint temporalHash(uint v) {
    v ^= v >> 16u; v *= 0x7feb352du;
    v ^= v >> 15u; v *= 0x846ca68bu;
    return v ^ (v >> 16u);
}

void main() {
    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > uintBitsToFloat(vSplat.w)) {
        discard;
    }

    vec2 blueKernelPower = unpackHalf2x16(vSplat.y);
    float kernelPower = blueKernelPower.y;
    float kernelAlpha = exp(-0.5 * z2);
    if (kernelPower != 0.0) {
        kernelAlpha = 1.0 - pow(1.0 - kernelAlpha, kernelPower);
    }
    float alpha = uintBitsToFloat(vSplat.z) * kernelAlpha;

    if (alpha < minAlpha) {
        discard;
    }
    #if !GSL_SORTED_FRAGMENT
    if (stochastic || depthOnly) {
        // Stable coverage unless StochasticTAAPass supplies a temporal sample.
        uvec2 pixel = uvec2(gl_FragCoord.xy - viewportOrigin);
        uvec2 offset = uvec2(vStochasticHash, vStochasticHash >> 5u);

        ivec2 coord = ivec2((pixel + offset) & uvec2(31u));
        float randomValue = (float(texelFetch(stochasticNoise, coord, 0).r) + 0.5) / 1024.0;
        if (stochastic && !depthOnly && stochasticTemporalFrame >= 0) {
            uvec2 quad = pixel >> 1u;
            uint h = temporalHash((quad.x * 1973u) ^ (quad.y * 9277u) ^ (vStochasticHash * 26699u) ^ uint(stochasticTemporalFrame));
            uint stratum = ((pixel.y & 1u) * 2u + (pixel.x & 1u)) ^ (h & 3u);
            randomValue = (float(stratum) + float(h >> 8u) / 16777216.0) * 0.25;
        }
        if (randomValue >= alpha) {
            discard;
        }

        if (depthOnly) {
            fragColor = vec4(0.0);
            #include <logdepthbuf_fragment>
            return;
        }
    }
    #endif

    // Decode color only after the fragment survives coverage tests.
    vec4 rgba = vec4(unpackHalf2x16(vSplat.x), blueKernelPower.x, alpha);
    #if !GSL_SORTED_FRAGMENT
    if (stochastic) {
        // Accepted stochastic samples are opaque.
        fragColor = vec4(rgba.rgb, 1.0);
        #include <logdepthbuf_fragment>
        return;
    }
    #endif

    #ifdef PREMULTIPLIED_ALPHA
        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);
    #else
        fragColor = rgba;
    #endif

    #include <logdepthbuf_fragment>
}
