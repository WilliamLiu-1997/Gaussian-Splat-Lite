    // Runs at the end of splatVertex.glsl's main(), for a Splat that draws.
    // The shortest axis is the surface normal, turned toward the viewer.
    vec3 normalAxis = (scales.x <= scales.y && scales.x <= scales.z)
        ? vec3(1.0, 0.0, 0.0)
        : ((scales.y <= scales.z) ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    vec3 surfaceNormal = quatVec(viewQuaternion, normalAxis);
    if (dot(surfaceNormal, isOrthographic ? vec3(0.0, 0.0, 1.0) : -viewCenter) < 0.0) {
        surfaceNormal = -surfaceNormal;
    }
    // Expected view depth across the footprint: the covariance of depth with
    // screen position, through the inverse of the 2D covariance.
    vec3 rowZ = transpose(RS) * vec3(0.0, 0.0, 1.0);
    vec2 crossZ = vec2(dot(rowZ, p0), dot(rowZ, p1));
    vec2 depthGradient = vec2(d * crossZ.x - b * crossZ.y, a * crossZ.y - b * crossZ.x) / det;
    // The perspective Jacobian divides by view Z, which is negative.
    if (!isOrthographic) depthGradient = -depthGradient;
    depthGradient = vec2(
        dot(depthGradient, eigenVec1) * scale1,
        dot(depthGradient, eigenVec2) * scale2
    ) / max(supportRadius, 1e-20);
    // One texel per accumulator row, in a texture 4096 wide.
    uint flagsRow = splatIndex >> SPLAT_TEX_WIDTH_BITS;
    vSurface = uvec4(
        packSnorm2x16(encodeSurfaceNormal(surfaceNormal)),
        floatBitsToUint(depthGradient),
        texelFetch(splatFlags, ivec2(flagsRow & 4095u, flagsRow >> 12u), 0).r
    );
    vec4 surfaceView = projectionInverse * gl_Position;
    vSurfaceView = surfaceView.xyz / surfaceView.w;
