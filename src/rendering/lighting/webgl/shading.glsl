// Light records as SceneLights.js writes them: ambient and scale, light
// counts, then four vectors per light, in rows of GSL_LIGHT_TEXTURE_WIDTH.
// Keep in step with tsl/shading.js.
uniform highp sampler2D gslLights;

vec4 gslLight(int index) {
    return texelFetch(gslLights, ivec2(
        index % GSL_LIGHT_TEXTURE_WIDTH, index / GSL_LIGHT_TEXTURE_WIDTH
    ), 0);
}

vec3 gslLinearToSrgb(vec3 rgb) {
    return mix(pow(rgb, vec3(0.41666)) * 1.055 - vec3(0.055),
        rgb * 12.92, lessThanEqual(rgb, vec3(0.0031308)));
}

// Direction to a point or spot light (xyz) and its diffuse term with falloff (w).
vec4 gslPunctualLight(vec4 colorCutoff, vec4 positionDecay,
    vec3 center, vec3 normal, float worldPerView) {
    vec3 offset = positionDecay.xyz - center;
    float viewDistance = length(offset);
    vec3 direction = offset / max(viewDistance, 1e-6);
    // Decay and cutoff are in world units, whatever the camera rig's scale.
    float range = viewDistance * worldPerView;
    float falloff = 1.0 / max(pow(range, positionDecay.w), 0.01);
    if (colorCutoff.w > 0.0) {
        float ratio = range / colorCutoff.w;
        float window = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
        falloff *= window * window;
    }
    return vec4(direction, max(dot(normal, direction), 0.0) * falloff);
}

// Vertex-stage Lambert shading at a Splat's center, with its color as albedo.
vec3 splatShade(vec3 color, vec3 center, vec3 scales, vec4 viewQuaternion) {
    vec4 header = gslLight(0);
    vec3 irradiance = header.rgb;
    ivec4 counts = ivec4(gslLight(1));
    // Estimate the surface only for the lights that use it.
    vec3 normal = vec3(0.0);
    if (counts != ivec4(0)) {
        normal = splatSurfaceNormal(scales, viewQuaternion, center);
    }
    // Lights follow one another by kind.
    int cursor = 2;
    // Hemisphere
    for (int i = 0; i < counts.x; i++, cursor += 4) {
        irradiance += mix(gslLight(cursor + 2).rgb, gslLight(cursor).rgb,
            0.5 * dot(normal, gslLight(cursor + 1).xyz) + 0.5);
    }
    // Directional
    for (int i = 0; i < counts.y; i++, cursor += 4) {
        irradiance += gslLight(cursor).rgb * max(0.0, dot(normal, gslLight(cursor + 1).xyz));
    }
    // Point
    for (int i = 0; i < counts.z; i++, cursor += 4) {
        vec4 colorCutoff = gslLight(cursor);
        vec4 light = gslPunctualLight(colorCutoff, gslLight(cursor + 1), center, normal, header.w);
        irradiance += colorCutoff.rgb * light.w;
    }
    // Spot
    for (int i = 0; i < counts.w; i++, cursor += 4) {
        vec4 colorCutoff = gslLight(cursor);
        vec4 light = gslPunctualLight(colorCutoff, gslLight(cursor + 1), center, normal, header.w);
        vec4 axisCone = gslLight(cursor + 2);
        float innerCos = gslLight(cursor + 3).x;
        float angleCos = dot(light.xyz, axisCone.xyz);
        float cone;
        // Zero penumbra is a hard cone; smoothstep requires distinct edges.
        if (innerCos > axisCone.w) {
            cone = smoothstep(axisCone.w, innerCos, angleCos);
        } else {
            cone = step(axisCone.w, angleCos);
        }
        irradiance += colorCutoff.rgb * (light.w * cone);
    }
    // Light in linear RGB even when source colors blend in sRGB.
    vec3 albedo = encodeLinear ? color : srgbToLinear(color);
    vec3 lit = albedo * irradiance * 0.3183098861837907;
    return encodeLinear ? lit : gslLinearToSrgb(lit);
}
