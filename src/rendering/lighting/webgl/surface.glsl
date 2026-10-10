// The covariance ellipsoid's outward normal at its central visible point:
// normalize(inverse(covariance) * towardViewer). Keep in step with tsl/surface.js.
vec3 splatSurfaceNormal(vec3 scales, vec4 viewQuaternion, vec3 viewCenter) {
    vec3 towardViewer = isOrthographic
        ? vec3(0.0, 0.0, 1.0) : normalize(-viewCenter);
    vec3 localView = quatVec(
        vec4(-viewQuaternion.xyz, viewQuaternion.w), towardViewer
    );
    float shortest = min(min(scales.x, scales.y), scales.z);
    // Zero axes have no covariance inverse; give them a relative finite width.
    float normalScale = shortest == 0.0
        ? max(max(scales.x, scales.y), scales.z) * 1e-6 : shortest;
    // A common scale factor preserves the normal without forming 1 / scale².
    vec3 inverseScale = normalScale / max(scales, vec3(normalScale));
    return normalize(quatVec(
        viewQuaternion, localView * inverseScale * inverseScale
    ));
}
