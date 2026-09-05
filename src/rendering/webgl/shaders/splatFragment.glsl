
precision highp float;
precision highp int;

#include <splatDefines>

uniform float near;
uniform float far;
#ifndef GSL_COLOR_IN_VERTEX
uniform bool encodeLinear;
#endif
uniform float time;
uniform bool debugFlag;
uniform float minAlpha;
uniform bool stochastic;
uniform bool stochasticResolve;
#ifdef GSL_DEPTH_ONLY
const bool depthOnly = true;
#else
const bool depthOnly = false;
#endif
uniform vec2 viewportOrigin;

out vec4 fragColor;

in vec4 vRgba;
in vec2 vSplatUv;
flat in uint vSplatIndex;
flat in float vSupportRadiusSquared;
flat in float vKernelPower;

#include <logdepthbuf_pars_fragment>

// Chris Wellons' "prospector" integer mix. The stable splat id is part of the
// seed so overlapping Gaussians do not share the same coverage decision.
uint hashU32(uint value) {
    value ^= value >> 16u;
    value *= 0x7feb352du;
    value ^= value >> 15u;
    value *= 0x846ca68bu;
    value ^= value >> 16u;
    return value;
}

void main() {
    vec4 rgba = vRgba;

    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > vSupportRadiusSquared) {
        discard;
    }

    float kernelAlpha = exp(-0.5 * z2);
    if (vKernelPower != 0.0) {
        kernelAlpha = 1.0 - pow(1.0 - kernelAlpha, vKernelPower);
    }
    rgba.a *= kernelAlpha;

    if (rgba.a < minAlpha) {
        discard;
    }
    if (stochastic || depthOnly) {
        // One stochastic transparency sample per pixel. The four pixels in
        // each 2x2 quad use a scrambled set of four strata to decorrelate
        // adjacent coverage decisions. The sorted depth-only pass reuses it
        // so transparent edges do not become solid.
        uvec2 pixel = uvec2(gl_FragCoord.xy - viewportOrigin);
        uvec2 quad = pixel >> 1u;
        uint hash = hashU32(
            (quad.x * 1973u) ^
            (quad.y * 9277u) ^
            ((vSplatIndex + 1u) * 26699u)
        );
        uint stratum = (((pixel.y & 1u) * 2u) + (pixel.x & 1u)) ^ (hash & 3u);
        float randomValue = (
            float(stratum) + float(hash >> 8u) * (1.0 / 16777216.0)
        ) * 0.25;
        if (randomValue >= rgba.a) {
            discard;
        }

        if (depthOnly) {
            fragColor = vec4(0.0);
            #include <logdepthbuf_fragment>
            return;
        }
    }
    #ifndef GSL_COLOR_IN_VERTEX
    if (encodeLinear) {
        rgba.rgb = srgbToLinear(rgba.rgb);
    }
    #endif

    if (stochastic) {
        // Alpha 2 marks accepted stochastic samples for the optional resolve
        // pass. Without an attached pass, keep regular opaque output.
        fragColor = vec4(rgba.rgb, stochasticResolve ? 2.0 : 1.0);
        #include <logdepthbuf_fragment>
        return;
    }

    #ifdef PREMULTIPLIED_ALPHA
        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);
    #else
        fragColor = rgba;
    #endif

    #include <logdepthbuf_fragment>
}
