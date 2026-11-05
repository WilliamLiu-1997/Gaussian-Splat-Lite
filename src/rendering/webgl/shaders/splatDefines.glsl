const uint SPLAT_TEX_WIDTH_BITS = 11u;
const uint SPLAT_TEX_HEIGHT_BITS = 11u;
const uint SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;

const uint SPLAT_TEX_WIDTH = 1u << SPLAT_TEX_WIDTH_BITS;
const uint SPLAT_TEX_HEIGHT = 1u << SPLAT_TEX_HEIGHT_BITS;

const uint SPLAT_TEX_WIDTH_MASK = SPLAT_TEX_WIDTH - 1u;
const uint SPLAT_TEX_HEIGHT_MASK = SPLAT_TEX_HEIGHT - 1u;

const float PI = 3.1415926535897932384626433832795;

vec3 srgbToLinear(vec3 rgb) {
    // Match Three's sRGB transfer.
    return mix(
        pow(rgb * 0.9478672986 + vec3(0.0521327014), vec3(2.4)),
        rgb * 0.0773993808, lessThanEqual(rgb, vec3(0.04045)));
}

uint encodeQuatSmallestThree32(vec4 q) {
    q = normalize(q);
    vec4 magnitudes = abs(q);
    uint omitted = 0u;
    float largest = magnitudes.x;
    if (magnitudes.y > largest) { omitted = 1u; largest = magnitudes.y; }
    if (magnitudes.z > largest) { omitted = 2u; largest = magnitudes.z; }
    if (magnitudes.w > largest) { omitted = 3u; }
    if (q[omitted] < 0.0) q = -q;
    vec3 kept = omitted == 0u ? q.yzw : omitted == 1u ? q.xzw : omitted == 2u ? q.xyw : q.xyz;
    vec3 scaled = kept * 722.6631303726516;
    // Nearest integer, ties away from zero; negative fields use two's complement.
    uvec3 quantized = uvec3(ivec3(sign(scaled) * floor(abs(scaled) + 0.5))) & 0x3ffu;
    return (omitted << 30u) | (quantized.z << 20u) | (quantized.y << 10u) | quantized.x;
}

vec4 decodeQuatSmallestThree32(uint word) {
    uint omitted = word >> 30u;
    ivec3 fields = ivec3(uvec3(word, word >> 10u, word >> 20u) & 0x3ffu);
    vec3 kept = vec3((fields ^ 0x200) - 0x200) * 0.0013837706089756314;
    float missing = sqrt(1.0 - dot(kept, kept));
    return omitted == 0u ? vec4(missing, kept) :
        omitted == 1u ? vec4(kept.x, missing, kept.yz) :
        omitted == 2u ? vec4(kept.xy, missing, kept.z) : vec4(kept, missing);
}

vec3 decodeSplatCenter(uvec4 splatData) {
    return vec3(
        uintBitsToFloat(splatData.x),
        uintBitsToFloat(splatData.y),
        uintBitsToFloat(splatData.z)
    );
}

void encodeWorkSplat(
    out uvec4 splatData, out uvec4 splatData2,
    vec3 center, vec3 lnScales, vec4 quaternion, vec4 rgba, float shapeAmount
) {
    splatData.x = floatBitsToUint(center.x);
    splatData.y = floatBitsToUint(center.y);
    splatData.z = floatBitsToUint(center.z);
    splatData.w = packHalf2x16(clamp(vec2(rgba.a, shapeAmount), 0.0, 1.0));

    splatData2.x = packHalf2x16(rgba.rg);
    splatData2.y = packHalf2x16(vec2(rgba.b, lnScales.x));
    splatData2.z = packHalf2x16(lnScales.yz);
    splatData2.w = encodeQuatSmallestThree32(quaternion);
}

vec2 decodeSplatAlphaShapeAmount(uvec4 splatData) {
    return unpackHalf2x16(splatData.w);
}

vec3 decodeLnScales(uvec4 data) {
    return vec3(unpackHalf2x16(data.y).y, unpackHalf2x16(data.z));
}

vec4 decodeSplatRgba(uvec4 data, float alpha) {
    return vec4(unpackHalf2x16(data.x), unpackHalf2x16(data.y).x, alpha);
}

vec3 decodeSplatShRgb(uint encoded) {
    uint biasedBase = (encoded >> 27u) & 0x1fu;
    // Re-bias the exponent from the packed bias of 15 to float32's bias of 127,
    // then construct the exact power of two directly (127 - 15 = 112).
    float divisor = uintBitsToFloat((biasedBase + 112u) << 23u) / 255.0;

    vec3 rgb = vec3(uvec3(encoded & 0xffu, (encoded >> 8u) & 0xffu, (encoded >> 16u) & 0xffu));
    rgb *= divisor;

    return vec3(
        ((encoded & 0x1000000u) != 0u) ? -rgb.r : rgb.r,
        ((encoded & 0x2000000u) != 0u) ? -rgb.g : rgb.g,
        ((encoded & 0x4000000u) != 0u) ? -rgb.b : rgb.b
    );
}

// Rotate vector v by quaternion q
vec3 quatVec(vec4 q, vec3 v) {
    // Rotate vector v by quaternion q
    vec3 t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}

// Apply quaternion q1 after quaternion q2
vec4 quatQuat(vec4 q1, vec4 q2) {
    return vec4(
        q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
        q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
        q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
        q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z
    );
}

mat3 scaleQuaternionToMatrix(vec3 s, vec4 q) {
    // Compute the matrix of scaling by s then rotating by q
    return mat3(
        s.x * (1.0 - 2.0 * (q.y * q.y + q.z * q.z)),
        s.x * (2.0 * (q.x * q.y + q.w * q.z)),
        s.x * (2.0 * (q.x * q.z - q.w * q.y)),
        s.y * (2.0 * (q.x * q.y - q.w * q.z)),
        s.y * (1.0 - 2.0 * (q.x * q.x + q.z * q.z)),
        s.y * (2.0 * (q.y * q.z + q.w * q.x)),
        s.z * (2.0 * (q.x * q.z + q.w * q.y)),
        s.z * (2.0 * (q.y * q.z - q.w * q.x)),
        s.z * (1.0 - 2.0 * (q.x * q.x + q.y * q.y))
    );
}

ivec3 splatTexCoord(int index) {
    uint x = uint(index) & SPLAT_TEX_WIDTH_MASK;
    uint y = (uint(index) >> SPLAT_TEX_WIDTH_BITS) & SPLAT_TEX_HEIGHT_MASK;
    uint z = uint(index) >> SPLAT_TEX_LAYER_BITS;
    return ivec3(x, y, z);
}
