precision highp float;
precision highp int;
precision highp usampler2D;
precision highp usampler2DArray;

#include <splatDefines>

uniform uint targetLayer;
uniform int targetBase;
uniform int targetCount;
uniform uint stochasticSeedBase;

uniform usampler2DArray sourceSplats;
uniform usampler2DArray sourceSplats2;
uniform uint sourceLayerBits;
uniform uint sourceLayerMask;
uniform uint sourceBlockBits;
uniform bool sourcePackedGroups;
uniform usampler2DArray sourceBlocks;
uniform usampler2DArray sourceOpacities;
uniform bool sourceIndexed;
uniform usampler2DArray sourceIndices;

uniform int numSh;
uniform uint shPaletteStride;
uniform uvec4 shPaletteLayout;
uniform usampler2DArray shLabelsTexture;
uniform usampler2DArray shBlock0Texture;
uniform usampler2DArray shBlock1Texture;
uniform usampler2DArray shBlock2Texture;
uniform usampler2DArray shBlock3Texture;
uniform usampler2DArray shBlock4Texture;
uniform usampler2DArray shBlock5Texture;

uniform mat3 objectBasis;
uniform vec3 objectOffset;
uniform vec3 objectLnScale;
uniform vec4 objectQuaternion;
uniform bool objectReflected;
uniform vec4 recolor;

uniform usampler2DArray blindTexture;
uniform uint blindStride;
uniform uint blindLayerBits;
uniform uint blindLayerMask;

uniform int numSdfs;
uniform int numEdits;
uniform usampler2D sdfTexture;
uniform usampler2D editTexture;

layout(location = 0) out uvec4 target;
layout(location = 1) out uvec4 target2;
#if GSL_STOCHASTIC_SEEDS
layout(location = 2) out uint targetSeed;
#endif

// Match WebGPU's finite sentinel for empty/unbounded SDFs. Smooth ALL shapes
// must not evaluate exp(inf - inf).
const float SDF_DISTANCE_LIMIT = 1e20;

// Edit group flags; see SplatEdit.js.
const uint EDIT_BLIND = 0x200u;

// Blind selection record flags; see SplatEditBlindField.js.
const uint BLIND_ACTIVE = 0x200u;
const uint BLIND_ENCODING_SHIFT = 10u;
const uint BLIND_HAS_LOWER = 0x1000u;
const uint BLIND_HAS_UPPER = 0x2000u;
const uint BLIND_EMPTY_RANGE = 0x4000u;

float decodeSemanticOpacity(float alpha, float shapeAmount) {
    if (shapeAmount <= 0.0) return alpha;

    float kernelShape = 1.0 + 4.0 * min(shapeAmount, 1.0);
    float kernelOpacity = exp(
        (kernelShape * kernelShape - 1.0) / 2.718281828459045
    );
    return alpha * kernelOpacity;
}

float encodeWideSemanticOpacity(float opacity) {
    float kernelShape = sqrt(log(opacity) * 2.718281828459045 + 1.0);
    return min(1.0, 0.25 * (kernelShape - 1.0));
}

vec3 evaluateSH1(uvec4 data, vec3 direction) {
    return decodeSplatShRgb(data.x) * (-0.4886025 * direction.y)
        + decodeSplatShRgb(data.y) * (0.4886025 * direction.z)
        + decodeSplatShRgb(data.z) * (-0.4886025 * direction.x);
}

vec3 evaluateSH2(uint previous, uvec4 data, vec3 direction) {
    return decodeSplatShRgb(previous) * (1.0925484 * direction.x * direction.y)
        + decodeSplatShRgb(data.x) * (-1.0925484 * direction.y * direction.z)
        + decodeSplatShRgb(data.y) * (0.3153915 * (2.0 * direction.z * direction.z - direction.x * direction.x - direction.y * direction.y))
        + decodeSplatShRgb(data.z) * (-1.0925484 * direction.x * direction.z)
        + decodeSplatShRgb(data.w) * (0.5462742 * (direction.x * direction.x - direction.y * direction.y));
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

vec3 evaluateSH4(uint previous, uvec4 first, uvec4 second, vec3 direction) {
    float xx = direction.x * direction.x;
    float yy = direction.y * direction.y;
    float zz = direction.z * direction.z;
    float xy = direction.x * direction.y;
    float yz = direction.y * direction.z;
    float xz = direction.x * direction.z;
    return decodeSplatShRgb(previous) * (2.50334294 * xy * (xx - yy))
        + decodeSplatShRgb(first.x) * (-1.77013077 * yz * (3.0 * xx - yy))
        + decodeSplatShRgb(first.y) * (0.94617470 * xy * (7.0 * zz - 1.0))
        + decodeSplatShRgb(first.z) * (-0.66904654 * yz * (7.0 * zz - 3.0))
        + decodeSplatShRgb(first.w) * (0.10578555 * (zz * (35.0 * zz - 30.0) + 3.0))
        + decodeSplatShRgb(second.x) * (-0.66904654 * xz * (7.0 * zz - 3.0))
        + decodeSplatShRgb(second.y) * (0.47308735 * (xx - yy) * (7.0 * zz - 1.0))
        + decodeSplatShRgb(second.z) * (-1.77013077 * xz * (xx - 3.0 * yy))
        + decodeSplatShRgb(second.w) * (0.62583574 * (xx * (xx - 3.0 * yy) - yy * (3.0 * xx - yy)));
}

uvec4 loadShBlock(usampler2DArray source, ivec3 coord, int block) {
    if (shPaletteStride > 0u) {
        coord.y += block;
        return uvec4(
            texelFetch(shBlock0Texture, coord, 0).x,
            texelFetch(shBlock0Texture, coord + ivec3(1, 0, 0), 0).x,
            texelFetch(shBlock0Texture, coord + ivec3(2, 0, 0), 0).x,
            texelFetch(shBlock0Texture, coord + ivec3(3, 0, 0), 0).x
        );
    }
    return texelFetch(source, coord, 0);
}

vec3 evaluateSH(ivec3 coord, vec3 direction) {
    uvec4 shBlock0 = loadShBlock(shBlock0Texture, coord, 0);
    vec3 result = evaluateSH1(shBlock0, direction);
    if (numSh >= 2) {
        result += evaluateSH2(
            shBlock0.w,
            loadShBlock(shBlock1Texture, coord, 1),
            direction
        );
        if (numSh >= 3) {
            uvec4 shBlock3 = loadShBlock(shBlock3Texture, coord, 3);
            result += evaluateSH3(
                loadShBlock(shBlock2Texture, coord, 2),
                shBlock3,
                direction
            );
            if (numSh >= 4) {
                result += evaluateSH4(
                    shBlock3.w,
                    loadShBlock(shBlock4Texture, coord, 4),
                    loadShBlock(shBlock5Texture, coord, 5),
                    direction
                );
            }
        }
    }
    return result;
}

float sdfDistance(uint type, vec3 position, vec4 sizes) {
    switch (type) {
        case 0u: return -SDF_DISTANCE_LIMIT;
        case 1u: return position.z;
        case 2u: return length(position) - sizes.w;
        case 3u: {
            vec3 q = abs(position) - sizes.xyz;
            return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - sizes.w;
        }
        case 4u: {
            if (sizes.w >= 0.0) return SDF_DISTANCE_LIMIT;
            float k0 = length(position);
            float k1 = length(position * sizes.xyz);
            // At the center, the exact signed distance is the shortest radius.
            if (k1 <= 0.0) return sizes.w;
            return k0 * (k0 - 1.0) / k1;
        }
        case 5u: {
            vec2 d = abs(vec2(length(position.xz), position.y)) - sizes.wy;
            return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
        }
        case 6u: {
            position.y -= clamp(position.y, -sizes.y, sizes.y);
            return length(position) - sizes.w;
        }
        case 7u: {
            vec2 c = sizes.xy;
            vec2 q = vec2(length(position.xy), -position.z);
            float distance = length(q - c * max(dot(q, c), 0.0));
            return distance * (((q.x * c.y - q.y * c.x) < 0.0) ? -1.0 : 1.0);
        }
    }
    return SDF_DISTANCE_LIMIT;
}

float blindUintDifference(uint a, uint b) {
    return a >= b ? float(a - b) : -float(b - a);
}

bool sampleBlindDistance(uint sourceIndex, uvec3 field, uint flags, uvec4 bounds, out float distance) {
    uint address = sourceIndex + field.x * blindStride;
    ivec3 coord = ivec3(address & 2047u, (address & blindLayerMask) >> 11u, address >> blindLayerBits);
    uint bits = (texelFetch(blindTexture, coord, 0).r >> field.y) & field.z;
    uint encoding = (flags >> BLIND_ENCODING_SHIFT) & 3u;
    float lower;
    float upper;
    if (encoding == 0u) {
        vec2 residual = uintBitsToFloat(bounds.zw);
        lower = blindUintDifference(bounds.x, bits) + residual.x;
        upper = blindUintDifference(bits, bounds.y) - residual.y;
    } else {
        // Test exponent bits: compilers may fold float NaN comparisons away.
        if (encoding == 1u ? (bits & 0x7c00u) == 0x7c00u
                           : encoding == 2u && (bits & 0x7f800000u) == 0x7f800000u)
            return false;
        float value;
        if (encoding == 1u) value = unpackHalf2x16(bits).x;
        else if (encoding == 2u) value = uintBitsToFloat(bits);
        else {
            vec2 decode = uintBitsToFloat(bounds.zw);
            value = decode.x + decode.y * float(bits);
        }
        vec2 range = uintBitsToFloat(bounds.xy);
        lower = range.x - value;
        upper = value - range.y;
    }
    // Missing bounds are flags, never infinities.
    distance = max(
        (flags & BLIND_HAS_LOWER) != 0u ? lower : -SDF_DISTANCE_LIMIT,
        (flags & BLIND_HAS_UPPER) != 0u ? upper : -SDF_DISTANCE_LIMIT
    );
    // Inclusive range endpoints must become exclusive when inverted.
    distance = distance == 0.0 ? -1e-20 : clamp(distance, -SDF_DISTANCE_LIMIT, SDF_DISTANCE_LIMIT);
    if ((flags & BLIND_EMPTY_RANGE) != 0u) distance = SDF_DISTANCE_LIMIT;
    return true;
}

vec4 sdfRgbaMask(uint flags) {
    return vec4(
        (flags & 0x10000u) != 0u ? 1.0 : 0.0,
        (flags & 0x20000u) != 0u ? 1.0 : 0.0,
        (flags & 0x40000u) != 0u ? 1.0 : 0.0,
        (flags & 0x80000u) != 0u ? 1.0 : 0.0
    );
}

bool sampleBlindSelection(int index, uint sourceIndex, out float distance, out uint flags) {
    uvec4 data0 = texelFetch(sdfTexture, ivec2(0, index), 0);
    flags = data0.w;
    if ((flags & BLIND_ACTIVE) == 0u) return false;
    uvec4 bounds = texelFetch(sdfTexture, ivec2(2, index), 0);
    if (!sampleBlindDistance(sourceIndex, data0.xyz, flags, bounds, distance)) return false;
    if ((flags & 0x100u) != 0u) distance = -distance;
    return true;
}

bool sampleSdfDistance(int index, vec3 position, out float distance, out uint flags) {
    uvec4 data0 = texelFetch(sdfTexture, ivec2(0, index), 0);
    flags = data0.w;
    uint type = flags & 0xffu;
    uvec4 data5 = texelFetch(sdfTexture, ivec2(5, index), 0);
    float distanceScale = uintBitsToFloat(data5.w);
    if (distanceScale == 0.0) return false;
    vec4 sizes = uintBitsToFloat(texelFetch(sdfTexture, ivec2(3, index), 0));
    uvec4 data1 = texelFetch(sdfTexture, ivec2(1, index), 0);
    uvec4 data2 = texelFetch(sdfTexture, ivec2(2, index), 0);
    mat3 basis = mat3(uintBitsToFloat(data1.xyz), uintBitsToFloat(data2.xyz), uintBitsToFloat(data5.xyz));
    vec3 center = uintBitsToFloat(data0.xyz);
    distance = sdfDistance(type, basis * position + center, sizes) * distanceScale;
    return true;
}

float sdfEditAmount(float distance, float invSoftEdge) {
    return invSoftEdge == 0.0
        ? (distance < 0.0 ? 1.0 : 0.0)
        : clamp(-distance * invSoftEdge + 0.5, 0.0, 1.0);
}

// Return the blend factor for the RGBA and mask values (unnormalized for unions).
float evaluateBlind(
    int fieldFirst,
    int fieldCount,
    uint sourceIndex,
    float invSoftEdge,
    bool invert,
    out vec4 resultRgba,
    out vec4 resultRgbaMask
) {
    resultRgba = vec4(0.0);
    resultRgbaMask = vec4(0.0);

    if (fieldCount == 1) {
        if (fieldFirst >= numSdfs) return 0.0;
        float distance;
        uint flags;
        if (!sampleBlindSelection(fieldFirst, sourceIndex, distance, flags)) return 0.0;
        float amount = sdfEditAmount(invert ? -distance : distance, invSoftEdge);
        if (amount > 0.0) {
            resultRgba = uintBitsToFloat(texelFetch(sdfTexture, ivec2(4, fieldFirst), 0));
            resultRgbaMask = sdfRgbaMask(flags);
        }
        return amount;
    }

    int fieldLast = min(fieldFirst + fieldCount, numSdfs);
    float distance = SDF_DISTANCE_LIMIT;
    float weightSum = 0.0;
    for (int index = fieldFirst; index < fieldLast; ++index) {
        float valueDistance;
        uint flags;
        if (!sampleBlindSelection(index, sourceIndex, valueDistance, flags)) continue;
        distance = min(distance, valueDistance);
        float weight = invert ? 1.0 : sdfEditAmount(valueDistance, invSoftEdge);
        if (weight > 0.0) {
            resultRgba += weight * uintBitsToFloat(texelFetch(sdfTexture, ivec2(4, index), 0));
            resultRgbaMask += weight * sdfRgbaMask(flags);
            weightSum += weight;
        }
    }

    if (weightSum == 0.0) return 0.0;
    return sdfEditAmount(invert ? -distance : distance, invSoftEdge) / weightSum;
}

float evaluateSdfs(
    int sdfFirst,
    int sdfCount,
    vec3 position,
    float invSmoothAmount,
    float invSoftEdge,
    bool invert,
    out vec4 resultRgba,
    out vec4 resultRgbaMask
) {
    resultRgba = vec4(0.0);
    resultRgbaMask = vec4(0.0);

    if (sdfCount == 1) {
        if (sdfFirst >= numSdfs) return 0.0;
        float distance;
        uint flags;
        if (!sampleSdfDistance(sdfFirst, position, distance, flags)) return 0.0;
        float amount = sdfEditAmount(invert ? -distance : distance, invSoftEdge);
        if (amount > 0.0) {
            resultRgba = uintBitsToFloat(texelFetch(sdfTexture, ivec2(4, sdfFirst), 0));
            resultRgbaMask = sdfRgbaMask(flags);
        }
        return amount;
    }

    int sdfLast = min(sdfFirst + sdfCount, numSdfs);
    float distance = SDF_DISTANCE_LIMIT;
    float weightSum = 0.0;
    if (invSmoothAmount == 0.0) {
        for (int index = sdfFirst; index < sdfLast; ++index) {
            float valueDistance;
            uint flags;
            if (!sampleSdfDistance(index, position, valueDistance, flags)) continue;
            distance = min(distance, valueDistance);
            // Parent inversion uses the edge of the combined region below.
            float weight = invert ? 1.0 : sdfEditAmount(valueDistance, invSoftEdge);
            if (weight > 0.0) {
                resultRgba += weight * uintBitsToFloat(texelFetch(sdfTexture, ivec2(4, index), 0));
                resultRgbaMask += weight * sdfRgbaMask(flags);
                weightSum += weight;
            }
        }
    } else {
        float maxExponent = 0.0;
        for (int index = sdfFirst; index < sdfLast; ++index) {
            float valueDistance;
            uint flags;
            if (!sampleSdfDistance(index, position, valueDistance, flags)) continue;
            float exponent = -valueDistance * invSmoothAmount;
            bool dominant = weightSum == 0.0 || exponent > maxExponent;
            float relativeWeight = exp(-abs(exponent - maxExponent));
            float rescale = dominant ? relativeWeight : 1.0;
            float weight = dominant ? 1.0 : relativeWeight;
            if (weight != 0.0) {
                vec4 value = uintBitsToFloat(texelFetch(sdfTexture, ivec2(4, index), 0));
                vec4 valueMask = sdfRgbaMask(flags);
                maxExponent = dominant ? exponent : maxExponent;
                weightSum = weightSum * rescale + weight;
                resultRgba = resultRgba * rescale + weight * value;
                resultRgbaMask = resultRgbaMask * rescale + weight * valueMask;
            }
        }
        if (weightSum > 0.0) distance = (-log(weightSum) - maxExponent) / invSmoothAmount;
    }

    if (weightSum == 0.0) return 0.0;
    return sdfEditAmount(invert ? -distance : distance, invSoftEdge) / weightSum;
}

bool applySdfEdits(
    uint sourceIndex,
    vec3 position,
    inout vec4 rgba,
    float shapeAmount
) {
    bool semanticOpacityDecoded = false;
    for (int editIndex = 0; editIndex < numEdits; ++editIndex) {
        uvec4 edit = texelFetch(editTexture, ivec2(0, editIndex), 0);
        uint blendMode = edit.x & 0xffu;
        bool invert = (edit.x & 0x100u) != 0u;
        int selectionFirst = int(edit.y & 0xffffu);
        int selectionCount = int(edit.y >> 16u);
        float invSoftEdge = uintBitsToFloat(edit.z);
        vec4 sdfRgba;
        vec4 sdfRgbaMask;
        float factor;
        if ((edit.x & EDIT_BLIND) != 0u) {
            factor = evaluateBlind(
                selectionFirst, selectionCount, sourceIndex, invSoftEdge, invert, sdfRgba, sdfRgbaMask
            );
        } else {
            factor = evaluateSdfs(
                selectionFirst, selectionCount, position, uintBitsToFloat(edit.w), invSoftEdge, invert, sdfRgba, sdfRgbaMask
            );
        }
        bool editOpacity = factor > 0.0 && sdfRgbaMask.a > 0.0;
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
        rgba = mix(rgba, target, factor);
    }
    return semanticOpacityDecoded;
}

void produceSplat(int index) {
    uint sourceIndex = uint(index);
    if (sourceIndexed) {
        uvec4 indices = texelFetch(sourceIndices, splatTexCoord(index >> 2), 0);
        sourceIndex = indices[index & 3];
    }
    #if GSL_STOCHASTIC_SEEDS
    targetSeed = sourceIndex ^ stochasticSeedBase;
    #endif
    float blockOpacity = 1.0;
    if (sourceBlockBits < 32u) {
        // RAD packs sixteen two-bit groups per texel; SOG keeps one ID per block.
        uint groupIndex = sourceIndex >> sourceBlockBits;
        uint packing = sourcePackedGroups ? 4u : 0u;
        uint blockMask = sourceLayerMask >> (sourceBlockBits + packing);
        uint block = groupIndex >> packing;
        uint group = texelFetch(sourceBlocks, ivec3(
            block & min(blockMask, SPLAT_TEX_WIDTH_MASK),
            (block & blockMask) >> SPLAT_TEX_WIDTH_BITS,
            sourceIndex >> sourceLayerBits
        ), 0).r;
        if (sourcePackedGroups) group = (group >> ((groupIndex & 15u) * 2u)) & 3u;
        blockOpacity = uintBitsToFloat(texelFetch(sourceOpacities, splatTexCoord(int(group)), 0).r);
    }
    if (blockOpacity <= 0.0) return;
    ivec3 coord = ivec3(
        sourceIndex & SPLAT_TEX_WIDTH_MASK,
        (sourceIndex & sourceLayerMask) >> SPLAT_TEX_WIDTH_BITS,
        sourceIndex >> sourceLayerBits
    );
    uvec4 sourceSplat2 = texelFetch(sourceSplats2, coord, 0);
    // Detect the three packed -infinity scales before unpacking any floats.
    if ((sourceSplat2.y >> 16u) == 0xfc00u && sourceSplat2.z == 0xfc00fc00u) return;
    uvec4 sourceSplat = texelFetch(sourceSplats, coord, 0);
    vec2 alphaShapeAmount = decodeSplatAlphaShapeAmount(sourceSplat);
    vec3 center = decodeSplatCenter(sourceSplat);
    vec3 lnScales = decodeLnScales(sourceSplat2);
    vec4 quaternion = decodeQuatSmallestThree32(sourceSplat2.w);
    vec4 rgba = decodeSplatRgba(sourceSplat2, alphaShapeAmount.x);
    float shapeAmount = alphaShapeAmount.y;

    // Match PlayCanvas' work-buffer transform. Centers retain the complete
    // affine transform, while Gaussian shape is approximated by composing the
    // model rotation and its positive per-axis scale with each splat.
    center = objectBasis * center;
    if (numSh > 0) {
        vec3 worldViewDirection = center + objectOffset;
        vec4 inverseObjectQuaternion = vec4(-objectQuaternion.xyz, objectQuaternion.w);
        vec3 sourceViewDirection = normalize(quatVec(inverseObjectQuaternion, worldViewDirection));
        if (objectReflected) sourceViewDirection.x = -sourceViewDirection.x;
        ivec3 shCoord = coord;
        if (shPaletteStride > 0u) {
            uint label = texelFetch(shLabelsTexture, coord, 0).r;
            shCoord = ivec3(
                (label & shPaletteLayout.x) << 2u,
                ((label & shPaletteLayout.z) >> shPaletteLayout.y) * shPaletteStride,
                label >> shPaletteLayout.w);
        }
        rgba.rgb += evaluateSH(shCoord, sourceViewDirection);
    }
    lnScales += objectLnScale;
    if (objectReflected) quaternion.yz = -quaternion.yz;
    quaternion = quatQuat(objectQuaternion, quaternion);

    vec3 editPosition = center;
    center += objectOffset;
// The center is camera-relative while editPosition is mesh-origin-relative,
// matching the rebased SDF transforms without reconstructing world position.
    // Opacity is clamped once on the CPU when preparing this mesh.
    float opacityScale = recolor.a * blockOpacity;
    bool semanticOpacityDecoded = applySdfEdits(
        sourceIndex,
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

    encodeWorkSplat(
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
    #if GSL_STOCHASTIC_SEEDS
    targetSeed = 0u;
    #endif
    if (index >= 0 && index < targetCount) {
        produceSplat(index);
    }
}
