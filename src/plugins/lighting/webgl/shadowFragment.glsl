precision highp float;
precision highp int;

uniform float minAlpha;
uniform highp usampler2D stochasticNoise;

flat in vec4 vKernel;
flat in uint vStochasticOffset;
in vec2 vSplatUv;

out vec4 fragColor;

// The coverage of splatFragment.glsl, tested against one fixed slice of the
// noise atlas per Splat, so a shadow's grain does not flicker.
void main() {
    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > vKernel.z) {
        discard;
    }
    float kernelAlpha = exp(-0.5 * z2);
    if (vKernel.y != 0.0) {
        kernelAlpha = 1.0 - pow(1.0 - kernelAlpha, vKernel.y);
    }
    float alpha = (vKernel.x + vKernel.w) * kernelAlpha - vKernel.w;
    if (alpha < minAlpha) {
        discard;
    }
    uvec2 offset = uvec2(vStochasticOffset, vStochasticOffset >> 5u);
    ivec2 coord = ivec2((uvec2(gl_FragCoord.xy) + offset) & uvec2(31u));
    coord.y += int(vStochasticOffset >> 10u) * 32;
    float randomValue = (float(texelFetch(stochasticNoise, coord, 0).r) + 0.5) / 32768.0;
    if (randomValue >= alpha) {
        discard;
    }
    // Depth stays the plane's projective depth, also with a logarithmic depth
    // buffer: WebGLRenderer compares shadow maps in projective depth.
    fragColor = vec4(0.0);
}
