#include <splatSource>

uniform vec2 renderSize;
uniform vec4 renderToViewQuat;
uniform vec3 renderToViewPos;
uniform float renderToViewScale;
uniform float near;
uniform float far;
uniform float maxStdDev;
uniform float minAlpha;
uniform vec2 edgeFade;
uniform float preBlurAmount;
uniform float blurAmount;
uniform float clipXY;
uniform float focalAdjustment;

// Peak alpha, kernel power, squared support radius and edge fade.
flat out vec4 vKernel;
// Noise atlas offset: x in bits 0-4, y in 5-9, slice in 10-14.
flat out uint vStochasticOffset;
out vec2 vSplatUv;

uint hashU32(uint value) {
    value ^= value >> 16u;
    value *= 0x7feb352du;
    value ^= value >> 15u;
    value *= 0x846ca68bu;
    value ^= value >> 16u;
    return value;
}

// Shadow casters draw source records directly, with the projection of
// splatVertex.glsl: no accumulator, ordering or per-light cache.
void main() {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

    int index = gl_InstanceID * SPLATS_PER_INSTANCE + int(position.z);
    if (index >= targetCount) return;
    GeneratedSplat splat = readSplat(index);
    float alpha = clamp(splat.rgba.a, 0.0, 1.0);
    if (!splat.valid || alpha == 0.0 || alpha < minAlpha) return;

    vec3 viewCenter = renderToViewScale * quatVec(renderToViewQuat, splat.center) + renderToViewPos;
    if (viewCenter.z >= -near || viewCenter.z <= -far) return;
    vec4 clipCenter = projectionMatrix * vec4(viewCenter, 1.0);
    float clip = clipXY * clipCenter.w;
    if (abs(clipCenter.x) > clip || abs(clipCenter.y) > clip) return;

    vec3 scales = exp(splat.lnScales) * renderToViewScale;
    if (all(equal(scales, vec3(0.0)))) return;

    float kernelShape = 1.0 + 4.0 * clamp(splat.shapeAmount, 0.0, 1.0);
    float kernelPower = 0.0;
    if (kernelShape > 1.0) {
        kernelPower = exp((kernelShape * kernelShape - 1.0) / 2.718281828459045);
    }
    float maximumSupportRadius = maxStdDev + 0.7 * max(kernelShape - 1.0, 0.0);

    mat3 RS = scaleQuaternionToMatrix(
        scales, quatQuat(renderToViewQuat, normalize(splat.quaternion))
    );
    bool orthographic = projectionMatrix[2][3] == 0.0;
    #include <splatCovariance>

    // Only cover fragments that can reach minAlpha; wide kernels have power > 1.
    float supportRadius = maximumSupportRadius;
    if (minAlpha > 0.0) {
        float radiusSquared = 2.0 * log(alpha * max(kernelPower, 1.0) / minAlpha);
        supportRadius = min(supportRadius, sqrt(max(0.0, radiusSquared)));
    }

    #include <splatFootprint>
    // Shadow maps keep Splats of every size: most cover a texel or less.
    scale1 *= supportScale;
    scale2 *= supportScale;
    vec2 ndcOffset = (2.0 / scaledRenderSize)
        * (position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2);

    // The edge fade of splatFragment.glsl, resolved once per Splat.
    float supportRadiusSquared = supportRadius * supportRadius;
    float fade;
    if (kernelPower != 0.0) {
        float edgeKernel = 1.0 - pow(1.0 - exp(-0.5 * supportRadiusSquared), kernelPower);
        fade = max(0.0, alpha * edgeKernel - minAlpha) / max(1.0 - edgeKernel, 0.001);
    } else {
        fade = max(alpha * edgeFade.x - edgeFade.y, 0.0);
    }
    vKernel = vec4(alpha, kernelPower, supportRadiusSquared, fade);
    vSplatUv = position.xy * supportRadius;
    vStochasticOffset = hashU32(splat.seed) & 0x7fffu;

    // Covariance-plane depth, adapted from SuperSplat's Popless projection:
    // the plane through the center on which each view ray meets the
    // Gaussian's densest point. adj(Sigma) avoids dividing by a near-singular
    // determinant.
    mat3 covariance = RS * transpose(RS);
    vec3 toward = orthographic ? vec3(0.0, 0.0, -1.0) : viewCenter;
    vec3 planeNormal = cross(covariance[1], covariance[2]) * toward.x
        + cross(covariance[2], covariance[0]) * toward.y
        + cross(covariance[0], covariance[1]) * toward.z;
    float denominator = orthographic ? planeNormal.z : dot(planeNormal, viewCenter);
    vec2 planeGradient = (abs(denominator) > 1e-20)
        ? planeNormal.xy / denominator
        : vec2(0.0);
    vec2 viewScale = (orthographic ? 1.0 : -viewCenter.z)
        / vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
    float shift = dot(planeGradient, ndcOffset * viewScale);
    // Keep W fixed: plane depth is affine in screen space, even for
    // perspective, so hardware clips the plane at near and far.
    float depthScale = orthographic ? -projectionMatrix[2][2] : projectionMatrix[3][2];
    gl_Position = vec4(
        clipCenter.xy + ndcOffset * clipCenter.w,
        clipCenter.z + depthScale * shift,
        clipCenter.w
    );
}
