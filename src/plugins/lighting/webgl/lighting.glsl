precision highp sampler2DShadow;
precision highp samplerCubeShadow;
precision highp samplerCube;

uniform bool encodeLinear;
// The lights of the view drawn; SceneLights lays them out.
uniform vec4 gslLight[GSL_LIGHT_VECTORS];
#if GSL_SHADOWS > 0
// From that view into each shadow map.
uniform mat4 gslShadowView[GSL_SHADOWS];
#endif

// Octahedral view normal, view depth gradient per unit of vSplatUv, light flags.
flat in uvec4 vSurface;
// View position of this fragment at the depth of the Splat's center.
in vec3 vSurfaceView;

vec3 decodeSurfaceNormal(uint encoded) {
    vec2 folded = unpackSnorm2x16(encoded);
    vec3 normal = vec3(folded, 1.0 - abs(folded.x) - abs(folded.y));
    float t = max(-normal.z, 0.0);
    normal.x += (normal.x >= 0.0) ? -t : t;
    normal.y += (normal.y >= 0.0) ? -t : t;
    return normalize(normal);
}

vec3 gslSrgbToLinear(vec3 rgb) {
    return mix(
        pow(rgb * 0.9478672986 + vec3(0.0521327014), vec3(2.4)),
        rgb * 0.0773993808, lessThanEqual(rgb, vec3(0.04045)));
}

vec3 gslLinearToSrgb(vec3 rgb) {
    return mix(
        pow(rgb, vec3(0.41666)) * 1.055 - vec3(0.055),
        rgb * 12.92, lessThanEqual(rgb, vec3(0.0031308)));
}

// Lights return the direction to them and how strongly they light a surface
// facing `normal`: zero from behind it, out of range or outside a cone.

vec4 gslDirectionalLight(vec4 direction, vec3 normal) {
    return vec4(direction.xyz, dot(normal, direction.xyz));
}

// Point and spot lights fall off over world lengths, as in Three.js.
vec4 gslPointLight(vec4 colorRange, vec4 positionDecay, vec3 point, vec3 normal) {
    vec3 offset = positionDecay.xyz - point;
    float viewDistance = length(offset);
    vec3 direction = offset / viewDistance;
    // The first record's w is the world length of a view unit.
    float range = viewDistance * gslLight[0].w;
    float falloff = 1.0 / max(pow(range, positionDecay.w), 0.01);
    if (colorRange.w > 0.0) {
        float ratio = range / colorRange.w;
        float window = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
        falloff *= window * window;
    }
    return vec4(direction, max(dot(normal, direction), 0.0) * falloff);
}

vec4 gslSpotLight(vec4 colorRange, vec4 positionDecay, vec4 axisCone, vec4 penumbra, vec3 point, vec3 normal) {
    vec4 light = gslPointLight(colorRange, positionDecay, point, normal);
    light.w *= smoothstep(axisCone.w, penumbra.x, dot(light.xyz, axisCone.xyz));
    return light;
}

// Shadow lookups take a view point and normal, the matrix from the view into
// the map and the shadow's record: bias, bias along the normal in view units,
// filter radius in map widths, intensity. A map's depth and its comparison
// follow GSL_REVERSED_DEPTH.

// A turn of the filter's taps per fragment, by interleaved gradient noise.
float gslFilterTurn() {
    return 6.28318530718 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}

// Five taps on a Vogel disk.
vec2 gslFilterTap(int index, float turn) {
    float theta = float(index) * 2.399963229728653 + turn;
    return vec2(cos(theta), sin(theta)) * sqrt((float(index) + 0.5) / 5.0);
}

// Where a point falls in a map and its depth there; w is 0 outside the map.
vec4 gslShadowCoord(mat4 view, vec4 shadow, vec3 point, vec3 normal) {
    vec4 clip = view * vec4(point + normal * shadow.y, 1.0);
    vec3 coord = clip.xyz / clip.w;
    coord.z += GSL_REVERSED_DEPTH == 1 ? -shadow.x : shadow.x;
    bool inside = coord.x >= 0.0 && coord.x <= 1.0 && coord.y >= 0.0 && coord.y <= 1.0 && coord.z <= 1.0;
    return vec4(coord, inside ? 1.0 : 0.0);
}

float gslShadowHard(sampler2DShadow map, mat4 view, vec4 shadow, vec3 point, vec3 normal) {
    vec4 coord = gslShadowCoord(view, shadow, point, normal);
    float lit = coord.w > 0.0 ? texture(map, coord.xyz) : 1.0;
    return mix(1.0, lit, shadow.w);
}

// The sampler filters each tap over four texels.
float gslShadowPcf(sampler2DShadow map, mat4 view, vec4 shadow, vec3 point, vec3 normal) {
    vec4 coord = gslShadowCoord(view, shadow, point, normal);
    float lit = 1.0;
    if (coord.w > 0.0) {
        float turn = gslFilterTurn();
        lit = 0.0;
        for (int i = 0; i < 5; i++) {
            lit += texture(map, vec3(coord.xy + gslFilterTap(i, turn) * shadow.z, coord.z));
        }
        lit *= 0.2;
    }
    return mix(1.0, lit, shadow.w);
}

float gslShadowDepth(sampler2D map, mat4 view, vec4 shadow, vec3 point, vec3 normal) {
    vec4 coord = gslShadowCoord(view, shadow, point, normal);
    float lit = 1.0;
    if (coord.w > 0.0) {
        float depth = texture(map, coord.xy).r;
        lit = GSL_REVERSED_DEPTH == 1 ? step(depth, coord.z) : step(coord.z, depth);
    }
    return mix(1.0, lit, shadow.w);
}

// A variance shadow map: mean and standard deviation of depth around a texel.
float gslShadowMoments(sampler2D map, mat4 view, vec4 shadow, vec3 point, vec3 normal) {
    vec4 coord = gslShadowCoord(view, shadow, point, normal);
    float lit = 1.0;
    if (coord.w > 0.0) {
        vec2 moments = texture(map, coord.xy).rg;
        lit = GSL_REVERSED_DEPTH == 1 ? step(moments.x, coord.z) : step(coord.z, moments.x);
        if (lit != 1.0) {
            // Chebyshev's bound on the share of the texel's depths behind
            // this one, with its low end cut against light bleeding.
            float variance = max(moments.y * moments.y, 0.0000001);
            float delta = coord.z - moments.x;
            float bound = variance / (variance + delta * delta);
            lit = max(lit, clamp((bound - 0.3) / 0.65, 0.0, 1.0));
        }
    }
    return mix(1.0, lit, shadow.w);
}

// A point light's map is a cube around the light with world axes: `view`
// leads to the offset from the light, and depth runs along the major axis of
// that offset, between the near and far distances of `range`.
bool gslCubeShadowCoord(mat4 view, vec4 shadow, vec4 range, vec3 point, vec3 normal, out vec3 direction, out float z) {
    vec3 offset = (view * vec4(point + normal * shadow.y, 1.0)).xyz;
    vec3 size = abs(offset);
    float depth = max(size.x, max(size.y, size.z));
    if (depth > range.y || depth < range.x) return false;
    z = GSL_REVERSED_DEPTH == 1
        ? range.x * (range.y - depth) / (depth * (range.y - range.x)) - shadow.x
        : range.y * (depth - range.x) / (depth * (range.y - range.x)) + shadow.x;
    direction = normalize(offset);
    return true;
}

float gslCubeShadowHard(samplerCubeShadow map, mat4 view, vec4 shadow, vec4 range, vec3 point, vec3 normal) {
    vec3 direction;
    float z;
    float lit = 1.0;
    if (gslCubeShadowCoord(view, shadow, range, point, normal, direction, z)) {
        lit = texture(map, vec4(direction, z));
    }
    return mix(1.0, lit, shadow.w);
}

float gslCubeShadowPcf(samplerCubeShadow map, mat4 view, vec4 shadow, vec4 range, vec3 point, vec3 normal) {
    vec3 direction;
    float z;
    float lit = 1.0;
    if (gslCubeShadowCoord(view, shadow, range, point, normal, direction, z)) {
        // Taps spread across the plane facing the light.
        vec3 size = abs(direction);
        vec3 tangent = normalize(cross(direction, size.x > size.z ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 bitangent = cross(direction, tangent);
        float turn = gslFilterTurn();
        lit = 0.0;
        for (int i = 0; i < 5; i++) {
            vec2 tap = gslFilterTap(i, turn);
            lit += texture(map, vec4(direction + (tangent * tap.x + bitangent * tap.y) * shadow.z, z));
        }
        lit *= 0.2;
    }
    return mix(1.0, lit, shadow.w);
}

float gslCubeShadowDepth(samplerCube map, mat4 view, vec4 shadow, vec4 range, vec3 point, vec3 normal) {
    vec3 direction;
    float z;
    float lit = 1.0;
    if (gslCubeShadowCoord(view, shadow, range, point, normal, direction, z)) {
        float depth = texture(map, direction).r;
        lit = GSL_REVERSED_DEPTH == 1 ? step(depth, z) : step(z, depth);
    }
    return mix(1.0, lit, shadow.w);
}
