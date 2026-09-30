
precision highp float;
precision highp int;

uniform float minAlpha;

out vec4 fragColor;

flat in uvec4 vSplat;
in vec2 vSplatUv;

#include <logdepthbuf_pars_fragment>

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

    // Decode color only after the fragment survives coverage tests.
    vec4 rgba = vec4(unpackHalf2x16(vSplat.x), blueKernelPower.x, alpha);

    #ifdef PREMULTIPLIED_ALPHA
        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);
    #else
        fragColor = rgba;
    #endif

    #include <logdepthbuf_fragment>
}
