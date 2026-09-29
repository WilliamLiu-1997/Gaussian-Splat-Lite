#include <splatSource>
uniform float maxStdDev;
uniform float minAlpha;
uniform float near;
uniform float far;
uniform float focalAdjustment;
uniform float preBlurAmount;
uniform float blurAmount;
uniform float clipXY;
uniform vec2 renderSize;
uniform vec4 renderToViewQuat;
uniform vec3 renderToViewPos;
uniform float renderToViewScale;
uniform highp usampler2D shadowBlocks;
flat out vec3 shadowKernel;
flat out uint shadowSeed;
out vec2 shadowUv;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
out vec2 shadowDepth;
#endif

uint shadowHash(uint value) {
    value ^= value >> 16u; value *= 0x7feb352du;
    value ^= value >> 15u; value *= 0x846ca68bu;
    return value ^ (value >> 16u);
}

void main() {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    uint block = texelFetch(shadowBlocks, ivec2(gl_InstanceID & 2047, gl_InstanceID >> 11), 0).r;
    GeneratedSplat splat = readSplat(int(block) + int(position.z));
    float alpha = splat.rgba.a;
    if (!splat.valid || alpha <= 0.0 || alpha < minAlpha) return;
    vec3 center = quatVec(renderToViewQuat, splat.center) * renderToViewScale + renderToViewPos;
    if (center.z >= -near || center.z <= -far) return;
    vec4 clip = projectionMatrix * vec4(center, 1.0);
    if (any(greaterThan(abs(clip.xy), vec2(clipXY * clip.w)))) return;
    vec3 scales = exp(splat.lnScales) * renderToViewScale;
    if (all(equal(scales, vec3(0.0)))) return;
    mat3 rs = scaleQuaternionToMatrix(scales, quatQuat(renderToViewQuat, normalize(splat.quaternion)));
    vec2 size = renderSize * focalAdjustment;
    vec2 focal = 0.5 * size * vec2(projectionMatrix[0].x, projectionMatrix[1].y);
    bool ortho = projectionMatrix[2].w == 0.0;
    vec3 j0, j1;
    if (ortho) {
        j0 = vec3(focal.x, 0, 0); j1 = vec3(0, focal.y, 0);
    } else {
        vec2 first = focal / center.z;
        vec2 second = -first * center.xy / center.z;
        j0 = vec3(first.x, 0, second.x); j1 = vec3(0, first.y, second.y);
    }
    vec3 p0 = transpose(rs) * j0, p1 = transpose(rs) * j1;
    float a = dot(p0, p0) + preBlurAmount, b = dot(p0, p1), d = dot(p1, p1) + preBlurAmount;
    float detOrig = a * d - b * b;
    a += blurAmount; d += blurAmount;
    float det = a * d - b * b;
    if (det <= 0.0) return;
    alpha *= sqrt(max(0.0, detOrig / det));
    if (alpha <= 0.0 || alpha < minAlpha) return;
    float shape = 1.0 + 4.0 * min(splat.shapeAmount, 1.0);
    float power = shape > 1.0 ? exp((shape * shape - 1.0) / 2.718281828459045) : 0.0;
    float radius = maxStdDev + 0.7 * (shape - 1.0);
    if (minAlpha > 0.0) radius = min(radius, sqrt(max(0.0, 2.0 * log(alpha * max(power, 1.0) / minAlpha))));
    float average = 0.5 * (a + d), delta = length(vec2(0.5 * (a - d), b));
    float eigen1 = average + delta, eigen2 = max(average - delta, 1e-4);
    vec2 axis1 = abs(b) > 0.001 ? normalize(vec2(b, eigen1 - a)) : (a >= d ? vec2(1, 0) : vec2(0, 1));
    vec2 axis2 = vec2(axis1.y, -axis1.x);
    axis1 *= radius * sqrt(eigen1) * 2.0 / size;
    axis2 *= radius * sqrt(eigen2) * 2.0 / size;
    clip.xy += (position.x * axis1 + position.y * axis2) * clip.w;
    mat3 covariance = rs * transpose(rs);
    vec3 toward = ortho ? vec3(0, 0, -1) : center;
    vec3 normal = cross(covariance[1], covariance[2]) * toward.x
        + cross(covariance[2], covariance[0]) * toward.y
        + cross(covariance[0], covariance[1]) * toward.z;
    float denominator = ortho ? normal.z : dot(normal, center);
    vec2 gradient = abs(denominator) > 1e-20 ? normal.xy / denominator : vec2(0);
    vec2 viewScale = (ortho ? 1.0 : -center.z) / vec2(projectionMatrix[0].x, projectionMatrix[1].y);
    float shift = dot(gradient, (position.x * axis1 + position.y * axis2) * viewScale);
    clip.z += (ortho ? -projectionMatrix[2].z : projectionMatrix[3].z) * shift;
    gl_Position = clip;
    shadowUv = position.xy * radius;
    shadowKernel = vec3(alpha, power, radius * radius);
    shadowSeed = shadowHash(splat.seed);
    #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    shadowDepth = vec2(clip.z / clip.w, (1.0 + shift) / clip.w);
    #endif
}
