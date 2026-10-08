
precision highp float;
precision highp int;
precision highp usampler2DArray;

#include <splatDefines>

flat out uvec4 vSplat;
out vec2 vSplatUv;
#if GSL_STOCHASTIC
// Noise atlas offset: x in bits 0-4, y in 5-9, temporal slice in 10-14.
flat out uint vStochasticOffset;
#endif

uniform vec2 renderSize;
uniform vec4 renderToViewQuat;
uniform vec3 renderToViewPos;
// Uniform scale of the render-to-view transform (1.0 unless the camera is scaled)
uniform float renderToViewScale;
uniform float maxStdDev;
uniform float minPixelRadius;
uniform float minAlpha;
uniform float blurAmount;
uniform float preBlurAmount;
uniform float clipXY;
uniform float focalAdjustment;
uniform bool encodeLinear;
uniform uint splatCount;

uniform usampler2D ordering;
uniform usampler2DArray splats;
uniform usampler2DArray splats2;

#if GSL_STOCHASTIC
uniform bool stochasticOrdering;
uniform uint stochasticSample;
uniform vec2 viewportOrigin;
uniform usampler2DArray stochasticSeeds;
#endif

// Empty unless a shaded variant puts its code here; see shaders.ts.
#include <splatShadingPars>

// Required by logdepthbuf_pars_vertex (normally defined in three.js #include <common>)
bool isPerspectiveMatrix( mat4 m ) {
    return m[ 2 ][ 3 ] == -1.0;
}

#include <logdepthbuf_pars_vertex>

// Chris Wellons' "prospector" mix, constant across each Splat's fragments.
uint hashU32(uint value) {
    value ^= value >> 16u;
    value *= 0x7feb352du;
    value ^= value >> 15u;
    value *= 0x846ca68bu;
    value ^= value >> 16u;
    return value;
}

float gaussianSupportRadius(float alpha, float maximumRadius) {
    if (minAlpha <= 0.0) return maximumRadius;
    float radiusSquared = 2.0 * log(alpha / minAlpha);
    return min(maximumRadius, sqrt(max(0.0, radiusSquared)));
}

float wideSupportRadius(float alpha, float power, float maximumRadius) {
    if (minAlpha <= 0.0) return maximumRadius;
    // 1 - (1 - x)^power <= power * x for power >= 1. Only remove
    // coverage that cannot reach minAlpha, without inverting pow near 1.
    float radiusSquared = 2.0 * log(alpha * power / minAlpha);
    return min(maximumRadius, sqrt(max(0.0, radiusSquared)));
}

// A wide kernel can still be above minAlpha where its support ends. Return
// the edge fade: the amount the fragment stage subtracts so the kernel,
// rescaled about its peak, reaches minAlpha there instead. A Gaussian's fade
// follows from its alpha alone; see the edgeFade uniform.
float wideEdgeFade(float alpha, float power, float radiusSquared) {
    float edgeKernel = 1.0 - pow(1.0 - exp(-0.5 * radiusSquared), power);
    // A kernel still flat at its edge cannot fade; bound the slope instead.
    return max(0.0, alpha * edgeKernel - minAlpha)
        / max(1.0 - edgeKernel, 0.001);
}

void main() {
    // Default to outside the frustum so it's discarded if we return early
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

    uint index = uint(gl_InstanceID) * uint(SPLATS_PER_INSTANCE) + uint(position.z);
    if (index >= splatCount) return;

    uint splatIndex;
    #if GSL_STOCHASTIC
    if (!stochasticOrdering) {
        // Use source indices when stochastic ordering is disabled or not ready.
        splatIndex = index;
    } else
    #endif
    {
        ivec2 orderingCoord = ivec2(int((index >> 2u) & 4095u), int(index >> 14u));
        splatIndex = texelFetch(ordering, orderingCoord, 0)[index & 3u];
    }
    if (splatIndex == 0xffffffffu) {
        // Special value reserved for "no splat"
        return;
    }

    ivec3 texCoord = splatTexCoord(int(splatIndex));
    uvec4 splat1 = texelFetch(splats, texCoord, 0);
    vec2 alphaShapeAmount = decodeSplatAlphaShapeAmount(splat1);
    float alpha = alphaShapeAmount.x;
    if ((alpha == 0.0) || (alpha < minAlpha)) {
        return;
    }
    vec3 center = decodeSplatCenter(splat1);
    // Compute the view space center of the splat
    vec3 viewCenter = renderToViewScale * quatVec(renderToViewQuat, center) + renderToViewPos;

    // Discard splats behind the camera
    if (isPerspectiveMatrix(projectionMatrix) && viewCenter.z >= 0.0) {
        return;
    }

    // Compute the clip space center of the splat
    vec4 clipCenter = projectionMatrix * vec4(viewCenter, 1.0);

    // Discard splats outside near/far planes
    if (abs(clipCenter.z) >= clipCenter.w) {
        return;
    }

    // Discard splats more than clipXY times outside the XY frustum
    float clip = clipXY * clipCenter.w;
    if (abs(clipCenter.x) > clip || abs(clipCenter.y) > clip) {
        return;
    }

    // The second record is only needed by splats whose centers survive the
    // view-frustum checks above.
    vec3 lnScales;
    vec4 quaternion, rgba;
    uvec4 splat2 = texelFetch(splats2, texCoord, 0);
    decodeSplatAttributesLnScale(splat2, alpha, lnScales, quaternion, rgba);
    vec3 scales = exp(lnScales);
    if (all(equal(scales, vec3(0.0)))) {
        return;
    }

    // Match the reference 3DGS rasterizer by clamping SH-evaluated RGB positive.
    rgba.rgb = max(rgba.rgb, vec3(0.0));

    // Decode the shape amount independently from mesh/SDF opacity, which
    // remains in the main splat's alpha.
    float kernelShape = 1.0 + 4.0 * min(alphaShapeAmount.y, 1.0);
    // Zero marks the ordinary Gaussian path; wider kernels reuse this power
    // for every covered fragment.
    float kernelPower = 0.0;
    if (kernelShape > 1.0) {
        kernelPower = exp(
            (kernelShape * kernelShape - 1.0) / 2.718281828459045
        );
    }

    // Expand wider shape kernels until alpha is nearly zero before clipping.
    float maximumSupportRadius = maxStdDev
        + 0.7 * max(kernelShape - 1.0, 0.0);
    float supportRadius = maximumSupportRadius;

    scales *= renderToViewScale;

    // Compute view space quaternion of splat
    vec4 viewQuaternion = quatQuat(renderToViewQuat, quaternion);

    // Compute the scaled rotation basis of the splat.
    mat3 RS = scaleQuaternionToMatrix(scales, viewQuaternion);
    bool orthographic = isOrthographic;
    #include <splatCovariance>

    // Only cover fragments that can reach minAlpha for either kernel.
    if (kernelPower == 0.0) {
        supportRadius = gaussianSupportRadius(alpha, supportRadius);
    } else {
        supportRadius = wideSupportRadius(alpha, kernelPower, supportRadius);
    }

    #include <splatFootprint>
    // Projected radii use scaledRenderSize; convert the screen-pixel cutoff too.
    float minProjectedRadius = minPixelRadius * focalAdjustment;
    if (scale1 * supportScale < minProjectedRadius && scale2 * supportScale < minProjectedRadius) {
        return;
    }

    float supportRadiusSquared = supportRadius * supportRadius;
    if (kernelPower != 0.0) {
        // A wide kernel carries its edge fade in the low half of its squared
        // radius. Round that radius down to its high half first, with room
        // for the fade, so the support never grows. Only kernels that passed
        // the size cutoff pay for this.
        uint highHalf = floatBitsToUint(supportRadiusSquared * 0.996)
            & 0xffff0000u;
        float edgeFade = wideEdgeFade(
            alpha, kernelPower, uintBitsToFloat(highHalf)
        );
        supportRadiusSquared = uintBitsToFloat(
            highHalf | packHalf2x16(vec2(edgeFade, 0.0))
        );
        supportRadius = sqrt(supportRadiusSquared);
        supportScale = (maximumSupportRadius > 0.0)
            ? supportRadius / maximumSupportRadius
            : 0.0;
    }
    vSplatUv = position.xy * supportRadius;
    scale1 *= supportScale;
    scale2 *= supportScale;

    #if GSL_STOCHASTIC
    // Fetch stable coverage seeds only after all projection cutoffs pass.
    // Keep XY fixed so consecutive samples follow the same STBN time sequence.
    // Independent per-Splat XYZ offsets decorrelate overlapping coverage tests.
    uint seed = texelFetch(stochasticSeeds, texCoord, 0).r;
    uint hash = hashU32(seed);
    uvec2 offset = uvec2(hash, hash >> 5u) - uvec2(viewportOrigin);
    uint phase = ((hash >> 10u) + stochasticSample) & 31u;
    vStochasticOffset = (offset.x & 31u) | ((offset.y & 31u) << 5u) | (phase << 10u);
    #endif

    // RGB is constant across the quad, so convert before rasterization.
    if (encodeLinear) {
        rgba.rgb = srgbToLinear(rgba.rgb);
    }
    // Match the TSL varying layout: half RGB/kernel power, float32 alpha/radius.
    vec3 rgb = min(rgba.rgb, vec3(65504.0));
    vSplat = uvec4(
        packHalf2x16(rgb.rg),
        packHalf2x16(vec2(rgb.b, kernelPower)),
        floatBitsToUint(alpha),
        floatBitsToUint(supportRadiusSquared)
    );

    // Compute the NDC coordinates for the ellipsoid's diagonal axes.
    vec2 pixelOffset = position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2;
    vec2 ndcOffset = (2.0 / scaledRenderSize) * pixelOffset;

    // Compute NDC center of the splat
    vec3 ndcCenter = clipCenter.xyz / clipCenter.w;
    vec3 ndc = vec3(ndcCenter.xy + ndcOffset, ndcCenter.z);

    gl_Position = vec4(ndc.xy * clipCenter.w, clipCenter.zw);
    #include <splatShading>
    #include <logdepthbuf_vertex>
}
