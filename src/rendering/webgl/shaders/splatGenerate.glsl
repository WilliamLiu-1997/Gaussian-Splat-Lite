precision highp float;
precision highp int;
precision highp usampler2D;
precision highp usampler2DArray;

#include <splatDefines>

uniform uint targetLayer;
uniform int targetBase;
uniform int targetCount;

uniform usampler2DArray sourceSplats;
uniform usampler2DArray sourceSplats2;

uniform int numSh;
uniform usampler2DArray sh1Texture;
uniform usampler2DArray sh2Texture;
uniform usampler2DArray sh3TextureA;
uniform usampler2DArray sh3TextureB;

uniform mat3 objectBasis;
uniform vec3 objectOffset;
uniform vec3 objectLnScale;
uniform vec4 objectQuaternion;
uniform vec4 recolor;

uniform int numSdfs;
uniform int numEdits;
uniform usampler2D sdfTexture;
uniform usampler2D editTexture;

layout(location = 0) out uvec4 target;
layout(location = 1) out uvec4 target2;

const float MAX_SEMANTIC_OPACITY = 1000.0;
// Match WebGPU's finite sentinel for empty/unbounded SDFs. Smooth ALL shapes
// must not evaluate exp(inf - inf).
const float SDF_DISTANCE_LIMIT = 1e20;

float decodeSemanticOpacity(float alpha, float shapeAmount) {
    if (shapeAmount <= 0.0) return alpha;

    float kernelShape = 1.0 + 4.0 * shapeAmount;
    float kernelOpacity = exp(
        (kernelShape * kernelShape - 1.0) / 2.718281828459045
    );
    return min(MAX_SEMANTIC_OPACITY, alpha * kernelOpacity);
}

float encodeWideSemanticOpacity(float opacity) {
    opacity = min(opacity, MAX_SEMANTIC_OPACITY);
    float kernelShape = sqrt(log(opacity) * 2.718281828459045 + 1.0);
    return 0.25 * (kernelShape - 1.0);
}

vec3 evaluateSH1(uvec4 data, vec3 direction) {
    return decodeSplatShRgb(data.x) * (-0.4886025 * direction.y)
        + decodeSplatShRgb(data.y) * (0.4886025 * direction.z)
        + decodeSplatShRgb(data.z) * (-0.4886025 * direction.x);
}

vec3 evaluateSH12(uvec4 first, uvec4 second, vec3 direction) {
    vec3 result = evaluateSH1(first, direction);
    result += decodeSplatShRgb(first.w) * (1.0925484 * direction.x * direction.y);
    result += decodeSplatShRgb(second.x) * (-1.0925484 * direction.y * direction.z);
    result += decodeSplatShRgb(second.y) * (0.3153915 * (2.0 * direction.z * direction.z - direction.x * direction.x - direction.y * direction.y));
    result += decodeSplatShRgb(second.z) * (-1.0925484 * direction.x * direction.z);
    result += decodeSplatShRgb(second.w) * (0.5462742 * (direction.x * direction.x - direction.y * direction.y));
    return result;
}

vec3 evaluateSH3(uvec4 first, uvec4 second, vec3 direction) {
    float xx = direction.x * direction.x;
    float yy = direction.y * direction.y;
    float zz = direction.z * direction.z;
    return decodeSplatShRgb(first.x) * (-0.5900436 * direction.y * (3.0 * xx - yy))
        + decodeSplatShRgb(first.y) * (2.8906114 * direction.x * direction.y * direction.z)
        + decodeSplatShRgb(first.z) * (-0.4570458 * direction.y * (4.0 * zz - xx - yy))
        + decodeSplatShRgb(first.w) * (0.3731763 * direction.z * (2.0 * zz - 3.0 * xx - 3.0 * yy))
        + decodeSplatShRgb(second.x) * (-0.4570458 * direction.x * (4.0 * zz - xx - yy))
        + decodeSplatShRgb(second.y) * (1.4453057 * direction.z * (xx - yy))
        + decodeSplatShRgb(second.z) * (-0.5900436 * direction.x * (xx - 3.0 * yy));
}

vec3 evaluateSH(ivec3 coord, vec3 direction) {
    vec3 result = vec3(0.0);
    if (numSh == 1) {
        result = evaluateSH1(texelFetch(sh1Texture, coord, 0), direction);
    } else if (numSh >= 2) {
        result = evaluateSH12(
            texelFetch(sh1Texture, coord, 0),
            texelFetch(sh2Texture, coord, 0),
            direction
        );
        if (numSh >= 3) {
            result += evaluateSH3(
                texelFetch(sh3TextureA, coord, 0),
                texelFetch(sh3TextureB, coord, 0),
                direction
            );
        }
    }
    return result;
}

void unpackSdf(
    int index,
    out uint flags,
    out vec3 center,
    out vec4 quaternion,
    out vec3 scale,
    out vec4 sizes,
    out vec4 sdfRgba
) {
    uvec4 data = texelFetch(sdfTexture, ivec2(0, index), 0);
    center = vec3(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z));
    flags = data.w;
    data = texelFetch(sdfTexture, ivec2(1, index), 0);
    quaternion = vec4(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z), uintBitsToFloat(data.w));
    data = texelFetch(sdfTexture, ivec2(2, index), 0);
    scale = vec3(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z));
    data = texelFetch(sdfTexture, ivec2(3, index), 0);
    sizes = vec4(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z), uintBitsToFloat(data.w));
    data = texelFetch(sdfTexture, ivec2(4, index), 0);
    sdfRgba = vec4(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z), uintBitsToFloat(data.w));
}

float sdfDistance(uint type, vec3 position, vec4 sizes) {
    switch (type) {
        case 0u: return -SDF_DISTANCE_LIMIT;
        case 1u: return position.z;
        case 2u: return length(position) - sizes.w;
        case 3u: {
            vec3 q = abs(position) - sizes.xyz + sizes.w;
            return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - sizes.w;
        }
        case 4u: {
            vec3 radii = abs(sizes.xyz);
            if (any(lessThanEqual(radii, vec3(0.0)))) return SDF_DISTANCE_LIMIT;
            vec3 scaledPosition = position / radii;
            float k0 = length(scaledPosition);
            float k1 = length(scaledPosition / radii);
            // At the center, the exact signed distance is the shortest radius.
            if (k1 <= 0.0) return -min(radii.x, min(radii.y, radii.z));
            return k0 * (k0 - 1.0) / k1;
        }
        case 5u: {
            vec2 d = abs(vec2(length(position.xz), position.y)) - sizes.wy;
            return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
        }
        case 6u: {
            position.y -= clamp(position.y, -0.5 * sizes.y, 0.5 * sizes.y);
            return length(position) - sizes.w;
        }
        case 7u: {
            float angle = 0.25 * PI * sizes.w;
            vec2 c = vec2(sin(angle), cos(angle));
            vec2 q = vec2(length(position.xy), -position.z);
            float distance = length(q - c * max(dot(q, c), 0.0));
            return distance * (((q.x * c.y - q.y * c.x) < 0.0) ? -1.0 : 1.0);
        }
    }
    return SDF_DISTANCE_LIMIT;
}

float evaluateSdfs(
    int sdfFirst,
    int sdfCount,
    vec3 position,
    float smoothAmount,
    out vec4 resultRgba,
    out vec4 resultRgbaMask
) {
    float distanceAccum = smoothAmount == 0.0 ? SDF_DISTANCE_LIMIT : 0.0;
    float maxExponent = 0.0;
    resultRgba = vec4(0.0);
    resultRgbaMask = vec4(0.0);
    int sdfLast = min(sdfFirst + sdfCount, numSdfs);

    for (int index = sdfFirst; index < sdfLast; ++index) {
        uint flags;
        vec3 center;
        vec4 quaternion;
        vec3 scale;
        vec4 sizes;
        vec4 value;
        unpackSdf(index, flags, center, quaternion, scale, sizes, value);
        vec4 valueMask = vec4(
            (flags & 0x10000u) != 0u ? 1.0 : 0.0,
            (flags & 0x20000u) != 0u ? 1.0 : 0.0,
            (flags & 0x40000u) != 0u ? 1.0 : 0.0,
            (flags & 0x80000u) != 0u ? 1.0 : 0.0
        );
        vec3 sdfPosition = quatVec(quaternion, position * scale) + center;
        float distance = sdfDistance(flags & 0xffu, sdfPosition, sizes);
        if ((flags & 0x100u) != 0u) distance = -distance;

        if (smoothAmount == 0.0) {
            if (distance < distanceAccum) {
                distanceAccum = distance;
                resultRgba = value * valueMask;
                resultRgbaMask = valueMask;
            }
        } else {
            float exponent = -distance / smoothAmount;
            if (distanceAccum == 0.0) {
                maxExponent = exponent;
            } else if (exponent > maxExponent) {
                float rescale = exp(maxExponent - exponent);
                distanceAccum *= rescale;
                resultRgba *= rescale;
                resultRgbaMask *= rescale;
                maxExponent = exponent;
            }
            float weight = exp(exponent - maxExponent);
            distanceAccum += weight;
            resultRgba += weight * value * valueMask;
            resultRgbaMask += weight * valueMask;
        }
    }

    // A hard union can have distance zero on the surface; it is not empty.
    if (smoothAmount == 0.0) return distanceAccum;
    if (distanceAccum == 0.0) return SDF_DISTANCE_LIMIT;
    resultRgba /= distanceAccum;
    resultRgbaMask /= distanceAccum;
    return (-log(distanceAccum) - maxExponent) * smoothAmount;
}

bool applySdfEdits(
    vec3 position,
    inout vec4 rgba,
    float shapeAmount
) {
    bool semanticOpacityDecoded = false;
    for (int editIndex = 0; editIndex < numEdits; ++editIndex) {
        uvec4 edit = texelFetch(editTexture, ivec2(0, editIndex), 0);
        uint blendMode = edit.x & 0xffu;
        bool invert = (edit.x & 0x100u) != 0u;
        int sdfFirst = int(edit.y & 0xffffu);
        int sdfCount = int(edit.y >> 16u);
        float softEdge = uintBitsToFloat(edit.z);
        float smoothAmount = uintBitsToFloat(edit.w);

        vec4 sdfRgba;
        vec4 sdfRgbaMask;
        float distance = evaluateSdfs(
            sdfFirst,
            sdfCount,
            position,
            smoothAmount,
            sdfRgba,
            sdfRgbaMask
        );
        if (invert) distance = -distance;
        float amount = softEdge == 0.0
            ? (distance < 0.0 ? 1.0 : 0.0)
            : clamp(-distance / softEdge + 0.5, 0.0, 1.0);
        bool editOpacity = amount > 0.0 && sdfRgbaMask.a > 0.0;
        if (editOpacity && !semanticOpacityDecoded) {
            // SDF opacity values operate on semantic opacity, not on the alpha
            // half of the nonlinear wide-kernel encoding.
            rgba.a = decodeSemanticOpacity(
                clamp(rgba.a, 0.0, 1.0),
                shapeAmount
            );
            semanticOpacityDecoded = true;
        }
        vec4 target = rgba;
        switch (blendMode) {
            case 0u:
                target = rgba * (vec4(1.0) + sdfRgba - sdfRgbaMask);
                break;
            case 1u:
                target = rgba * (vec4(1.0) - sdfRgbaMask) + sdfRgba;
                break;
            case 2u:
                target = rgba + sdfRgba;
                break;
        }
        rgba = mix(rgba, target, amount);
    }
    return semanticOpacityDecoded;
}

void produceSplat(int index) {
    ivec3 coord = splatTexCoord(index);
    uvec4 sourceSplat2 = texelFetch(sourceSplats2, coord, 0);
    // Detect the three packed -infinity scales before unpacking any floats.
    if ((sourceSplat2.y >> 16u) == 0xfc00u && sourceSplat2.z == 0xfc00fc00u) return;
    uvec4 sourceSplat = texelFetch(sourceSplats, coord, 0);
    vec2 alphaShapeAmount = decodeSplatAlphaShapeAmount(sourceSplat);
    vec3 center = decodeSplatCenter(sourceSplat);
    vec3 lnScales;
    vec4 quaternion;
    vec4 rgba;
    decodeSplatAttributesLnScale(
        sourceSplat2,
        alphaShapeAmount.x,
        lnScales,
        quaternion,
        rgba
    );
    float shapeAmount = alphaShapeAmount.y;

    // Match PlayCanvas' work-buffer transform. Centers retain the complete
    // affine transform, while Gaussian shape is approximated by composing the
    // model rotation and its positive per-axis scale with each splat.
    center = objectBasis * center;
    if (numSh > 0) {
        vec3 worldViewDirection = center + objectOffset;
        vec4 inverseObjectQuaternion = vec4(-objectQuaternion.xyz, objectQuaternion.w);
        vec3 sourceViewDirection = normalize(quatVec(inverseObjectQuaternion, worldViewDirection));
        rgba.rgb += evaluateSH(coord, sourceViewDirection);
    }
    lnScales += objectLnScale;
    quaternion = quatQuat(objectQuaternion, quaternion);

    vec3 editPosition = center;
    center += objectOffset;
// The center is camera-relative while editPosition is mesh-origin-relative,
// matching the rebased SDF transforms without reconstructing world position.
    // Opacity is clamped once on the CPU when preparing this mesh.
    float opacityScale = recolor.a;
    bool semanticOpacityDecoded = applySdfEdits(
        editPosition,
        rgba,
        shapeAmount
    );
    rgba.rgb *= recolor.rgb;
    if (!semanticOpacityDecoded && opacityScale >= 1.0) {
        // Neither SDFs nor the mesh opacity changed opacity, so preserve the
        // source alpha/shape encoding without any transcendental operations.
        rgba.a = clamp(rgba.a, 0.0, 1.0);
    } else {
        if (!semanticOpacityDecoded) {
            rgba.a = decodeSemanticOpacity(
                clamp(rgba.a, 0.0, 1.0),
                shapeAmount
            );
        }
        float semanticOpacity = rgba.a * opacityScale;
        if (semanticOpacity <= 1.0) {
            rgba.a = clamp(semanticOpacity, 0.0, 1.0);
            shapeAmount = 0.0;
        } else {
            rgba.a = 1.0;
            shapeAmount = encodeWideSemanticOpacity(semanticOpacity);
        }
    }

    encodeSplatLnScale(
        target,
        target2,
        center,
        lnScales,
        quaternion,
        rgba,
        shapeAmount
    );
}

void main() {
    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS)
        + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS)
        + int(gl_FragCoord.x);
    int index = targetIndex - targetBase;

    target = uvec4(0u);
    target2 = uvec4(0u);
    if (index >= 0 && index < targetCount) {
        produceSplat(index);
    }
}
