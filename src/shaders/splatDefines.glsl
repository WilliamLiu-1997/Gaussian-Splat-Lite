const uint SPLAT_TEX_WIDTH_BITS = 11u;
const uint SPLAT_TEX_HEIGHT_BITS = 11u;
const uint SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;

const uint SPLAT_TEX_WIDTH = 1u << SPLAT_TEX_WIDTH_BITS;
const uint SPLAT_TEX_HEIGHT = 1u << SPLAT_TEX_HEIGHT_BITS;

const uint SPLAT_TEX_WIDTH_MASK = SPLAT_TEX_WIDTH - 1u;
const uint SPLAT_TEX_HEIGHT_MASK = SPLAT_TEX_HEIGHT - 1u;

const float PI = 3.1415926535897932384626433832795;

const float INFINITY = 1.0 / 0.0;

vec3 srgbToLinear(vec3 rgb) {
    return pow(rgb, vec3(2.2));
}

uint encodeQuatOctXy1010R12(vec4 q) {
    // Ensure minimal representation: flip if q.w is negative.
    if (q.w < 0.0) {
        q = -q;
    }
    // Compute rotation angle: θ = 2 * acos(q.w) ∈ [0,π]
    float halfTheta = acos(q.w);
    float theta = 2.0 * halfTheta;
    float s = sin(halfTheta);
    // Recover the rotation axis; use a default if nearly zero rotation.
    vec3 axis = (abs(s) < 1e-6) ? vec3(1.0, 0.0, 0.0) : q.xyz / s;
    
    // --- Folded Octahedral Mapping (inline) ---
    // Compute p = (axis.x, axis.y) / (|axis.x|+|axis.y|+|axis.z|)
    float sum = abs(axis.x) + abs(axis.y) + abs(axis.z);
    vec2 p = vec2(axis.x, axis.y) / sum;
    // If axis.z < 0, fold the mapping.
    if (axis.z < 0.0) {
        float oldPx = p.x;
        p.x = (1.0 - abs(p.y)) * (p.x >= 0.0 ? 1.0 : -1.0);
        p.y = (1.0 - abs(oldPx)) * (p.y >= 0.0 ? 1.0 : -1.0);
    }
    // Remap from [-1,1] to [0,1]
    float u_f = p.x * 0.5 + 0.5;
    float v_f = p.y * 0.5 + 0.5;
    // Quantize to 10 bits (0 to 1023)
    uint quantU = uint(clamp(round(u_f * 1023.0), 0.0, 1023.0));
    uint quantV = uint(clamp(round(v_f * 1023.0), 0.0, 1023.0));
    
    // --- Angle Quantization ---
    // Quantize θ ∈ [0,π] to 12 bits (0 to 4095)
    uint angleInt = uint(clamp(round((theta / PI) * 4095.0), 0.0, 4095.0));
    
    // Pack bits: bits [0–9]: quantU, [10–19]: quantV, [20–31]: angleInt.
    return (angleInt << 20u) | (quantV << 10u) | quantU;
}

vec4 decodeQuatOctXy1010R12(uint encoded) {
    // Extract the fields.
    uint quantU = encoded & uint(0x3FFu);               // bits 0–9
    uint quantV = (encoded >> 10u) & uint(0x3FFu);         // bits 10–19
    uint angleInt = encoded >> 20u;                      // bits 20–31

    // Recover u and v in [0,1], then map to [-1,1].
    float u_f = float(quantU) / 1023.0;
    float v_f = float(quantV) / 1023.0;
    vec2 f = vec2(u_f * 2.0 - 1.0, v_f * 2.0 - 1.0);

    vec3 axis = vec3(f.xy, 1.0 - abs(f.x) - abs(f.y));
    float t = max(-axis.z, 0.0);
    axis.x += (axis.x >= 0.0) ? -t : t;
    axis.y += (axis.y >= 0.0) ? -t : t;
    axis = normalize(axis);
    
    // Decode the angle θ ∈ [0,π].
    float theta = (float(angleInt) / 4095.0) * PI;
    float halfTheta = theta * 0.5;
    float s = sin(halfTheta);
    float w = cos(halfTheta);
    
    return vec4(axis * s, w);
}

// Encode a Splat into the standard two-record representation. The first
// record's final word stores alpha and special-kernel shape amount as float16.
void encodeSplat(
    out uvec4 splatData, out uvec4 splatData2,
    vec3 center, vec3 scales, vec4 quaternion, vec4 rgba, float shapeAmount
) {
    splatData.x = floatBitsToUint(center.x);
    splatData.y = floatBitsToUint(center.y);
    splatData.z = floatBitsToUint(center.z);
    splatData.w = packHalf2x16(clamp(vec2(rgba.a, shapeAmount), 0.0, 1.0));

    splatData2.x = packHalf2x16(rgba.rg);
    splatData2.y = packHalf2x16(vec2(rgba.b, log(scales.x)));
    splatData2.z = packHalf2x16(log(scales.yz));
    splatData2.w = encodeQuatOctXy1010R12(quaternion);
}

vec2 decodeSplatAlphaShapeAmount(uvec4 splatData) {
    return unpackHalf2x16(splatData.w);
}

void decodeSplat(
    uvec4 splatData, uvec4 splatData2,
    float alpha,
    out vec3 center, out vec3 scales, out vec4 quaternion, out vec4 rgba
) {
    center.x = uintBitsToFloat(splatData.x);
    center.y = uintBitsToFloat(splatData.y);
    center.z = uintBitsToFloat(splatData.z);
    rgba.a = alpha;

    rgba.rg = unpackHalf2x16(splatData2.x);
    vec2 split = unpackHalf2x16(splatData2.y);
    rgba.b = split.x;
    scales.x = exp(split.y);
    scales.yz = exp(unpackHalf2x16(splatData2.z));
    quaternion = decodeQuatOctXy1010R12(splatData2.w);
}

vec3 decodeSplatShRgb(uint encoded) {
    uint biasedBase = (encoded >> 27u) & 0x1fu;
    float divisor = exp2(float(int(biasedBase) - 15)) / 255.0;

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
