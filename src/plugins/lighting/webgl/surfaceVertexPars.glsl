// Octahedral view normal, view depth gradient per unit of vSplatUv, light flags.
flat out uvec4 vSurface;
// View position of this corner at the depth of the Splat's center.
out vec3 vSurfaceView;

uniform highp usampler2D splatFlags;
uniform mat4 projectionInverse;

vec2 encodeSurfaceNormal(vec3 n) {
    n /= abs(n.x) + abs(n.y) + abs(n.z);
    vec2 folded = (1.0 - abs(n.yx)) * vec2(
        n.x >= 0.0 ? 1.0 : -1.0,
        n.y >= 0.0 ? 1.0 : -1.0
    );
    return n.z >= 0.0 ? n.xy : folded;
}
