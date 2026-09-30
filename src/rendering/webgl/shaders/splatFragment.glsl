
precision highp float;
precision highp int;

uniform float minAlpha;
uniform bool stochastic;
uniform vec4 stochasticTemporalSample;
uniform bool stochasticResolve;
uniform bool depthOnly;
uniform highp usampler2D stochasticNoise;
uniform vec2 viewportOrigin;
#if GSL_LAYERED_COMPOSITE
uniform bool layeredComposite;
// Premultiplied RGB and remaining transmittance.
uniform highp sampler2D layers;
#endif

out vec4 fragColor;

flat in uvec4 vSplat;
in vec2 vSplatUv;
flat in uint vStochasticHash;

#include <logdepthbuf_pars_fragment>

void main() {
    #if GSL_LAYERED_COMPOSITE
    if (layeredComposite) {
        vec4 layer = texelFetch(layers, ivec2(gl_FragCoord.xy), 0);
        float coverage = 1.0 - layer.a;
        if (coverage <= 0.0) {
            discard;
        }
        // Either sorted blend mode then adds the accumulated premultiplied RGB
        // over the remaining destination.
        #ifdef PREMULTIPLIED_ALPHA
            fragColor = vec4(layer.rgb, coverage);
        #else
            fragColor = vec4(layer.rgb / coverage, coverage);
        #endif
        return;
    }
    #endif

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
        if (stochastic && !depthOnly) offset += uvec2(stochasticTemporalSample.zw);
        ivec2 coord = ivec2((pixel + offset) & uvec2(31u));
        float randomValue = (float(texelFetch(stochasticNoise, coord, 0).r) + 0.5) / 1024.0;
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
        // Alpha 2 marks accepted stochastic samples for the optional resolve
        // pass. Without an attached pass, keep regular opaque output.
        fragColor = vec4(rgba.rgb, stochasticResolve ? 2.0 : 1.0);
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
