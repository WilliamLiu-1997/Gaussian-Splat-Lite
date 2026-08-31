
precision highp float;
precision highp int;
precision highp usampler2DArray;

#include <splatDefines>

out vec4 vRgba;
out vec2 vSplatUv;
flat out uint vSplatIndex;
flat out float vSupportRadiusSquared;
flat out float vKernelPower;

// uniform uint numSplats;
uniform vec2 renderSize;
uniform vec4 renderToViewQuat;
uniform vec3 renderToViewPos;
// Uniform scale of the render-to-view transform (1.0 unless the camera is scaled)
uniform float renderToViewScale;
uniform float maxStdDev;
uniform float minPixelRadius;
uniform float maxPixelRadius;
uniform float time;
uniform float deltaTime;
uniform bool debugFlag;
uniform float minAlpha;
uniform float blurAmount;
uniform float preBlurAmount;
uniform float clipXY;
uniform float focalAdjustment;

uniform usampler2D ordering;
uniform usampler2DArray splats;
uniform usampler2DArray splats2;

// Required by logdepthbuf_pars_vertex (normally defined in three.js #include <common>)
bool isPerspectiveMatrix( mat4 m ) {
    return m[ 2 ][ 3 ] == -1.0;
}

#include <logdepthbuf_pars_vertex>

float gaussianSupportRadius(float alpha, float maximumRadius) {
    if (minAlpha <= 0.0) return maximumRadius;
    float radiusSquared = 2.0 * log(alpha / minAlpha);
    return min(maximumRadius, sqrt(max(0.0, radiusSquared)));
}

void main() {
    // Default to outside the frustum so it's discarded if we return early
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

    ivec2 orderingCoord = ivec2((gl_InstanceID >> 2) & 4095, gl_InstanceID >> 14);
    uint splatIndex = texelFetch(ordering, orderingCoord, 0)[gl_InstanceID & 3];
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
    if (viewCenter.z >= 0.0) {
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
    vKernelPower = kernelPower;

    // Expand wider shape kernels until alpha is nearly zero before clipping.
    float maximumSupportRadius = maxStdDev
        + 0.7 * max(kernelShape - 1.0, 0.0);
    float supportRadius = maximumSupportRadius;

    scales *= renderToViewScale;

    vRgba = vec4(rgba.rgb, alpha);

    // Record the splat index for entropy
    vSplatIndex = splatIndex;

    // Compute view space quaternion of splat
    vec4 viewQuaternion = quatQuat(renderToViewQuat, quaternion);

    // Compute the scaled rotation basis of the splat.
    mat3 RS = scaleQuaternionToMatrix(scales, viewQuaternion);

    // Compute the two relevant columns of the projection Jacobian.
    vec2 scaledRenderSize = renderSize * focalAdjustment;
    vec2 focal = 0.5 * scaledRenderSize * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);

    vec3 j0;
    vec3 j1;
    if (isOrthographic) {
        j0 = vec3(focal.x, 0.0, 0.0);
        j1 = vec3(0.0, focal.y, 0.0);
    } else {
        float invZ = 1.0 / viewCenter.z;
        vec2 J1 = focal * invZ;
        vec2 J2 = -(J1 * viewCenter.xy) * invZ;
        j0 = vec3(J1.x, 0.0, J2.x);
        j1 = vec3(0.0, J1.y, J2.y);
    }

    // Project only the 2D covariance entries that are consumed below:
    // j^T * RS * RS^T * j = dot(RS^T * j, RS^T * j).
    vec3 p0 = transpose(RS) * j0;
    vec3 p1 = transpose(RS) * j1;
    float a = dot(p0, p0);
    float b = dot(p0, p1);
    float d = dot(p1, p1);

    // Optionally pre-blur the splat to match non-antialias optimized splats
    a += preBlurAmount;
    d += preBlurAmount;

    // Do convolution with a 0.5-pixel Gaussian for anti-aliasing: sqrt(0.3) ~= 0.5
    float detOrig = a * d - b * b;
    a += blurAmount;
    d += blurAmount;
    float det = a * d - b * b;

    // Compute anti-aliasing intensity scaling factor
    float blurAdjust = sqrt(max(0.0, detOrig / det));
    alpha *= blurAdjust;
    if (alpha < minAlpha) {
        return;
    }
    vRgba.a = alpha;

    // Ordinary Gaussians need only cover fragments that can reach minAlpha.
    // Wide kernels retain their separately expanded support radius.
    if (kernelPower == 0.0) {
        supportRadius = gaussianSupportRadius(alpha, supportRadius);
    }
    vSupportRadiusSquared = supportRadius * supportRadius;
    vSplatUv = position.xy * supportRadius;

    // Compute the eigenvalue and eigenvectors of the 2D covariance matrix
    float eigenAvg = 0.5 * (a + d);
    float eigenDelta = sqrt(max(0.0, eigenAvg * eigenAvg - det));
    float eigen1 = eigenAvg + eigenDelta;
    float eigen2 = eigenAvg - eigenDelta;

    vec2 eigenVec1 = (abs(b) > 0.001) ? normalize(vec2(b, eigen1 - a))
        : ((a >= d) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    vec2 eigenVec2 = vec2(eigenVec1.y, -eigenVec1.x);

    // Apply maxPixelRadius to the original support first, then shrink both the
    // quad and its UV extent by the same ratio to preserve the Gaussian profile.
    float scale1 = min(maxPixelRadius, maximumSupportRadius * sqrt(eigen1));
    float scale2 = min(maxPixelRadius, maximumSupportRadius * sqrt(eigen2));
    float supportScale = (maximumSupportRadius > 0.0)
        ? supportRadius / maximumSupportRadius
        : 0.0;
    scale1 *= supportScale;
    scale2 *= supportScale;
    if (scale1 < minPixelRadius && scale2 < minPixelRadius) {
        return;
    }

    // Compute the NDC coordinates for the ellipsoid's diagonal axes.
    vec2 pixelOffset = position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2;
    vec2 ndcOffset = (2.0 / scaledRenderSize) * pixelOffset;

    // Compute NDC center of the splat
    vec3 ndcCenter = clipCenter.xyz / clipCenter.w;
    vec3 ndc = vec3(ndcCenter.xy + ndcOffset, ndcCenter.z);

    gl_Position = vec4(ndc.xy * clipCenter.w, clipCenter.zw);

    #include <logdepthbuf_vertex>
}
