// Runs in main() after the scaled rotation basis and view center are ready.
// Keep the projected rows and covariance entries in scope for material extensions.
vec2 scaledRenderSize = renderSize * focalAdjustment;
vec2 focal = 0.5 * scaledRenderSize * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);

vec3 j0;
vec3 j1;
if (orthographic) {
    j0 = vec3(focal.x, 0.0, 0.0);
    j1 = vec3(0.0, focal.y, 0.0);
} else {
    float invZ = 1.0 / viewCenter.z;
    vec2 J1 = focal * invZ;
    vec2 J2 = -(J1 * viewCenter.xy) * invZ;
    j0 = vec3(J1.x, 0.0, J2.x);
    j1 = vec3(0.0, J1.y, J2.y);
}

// Project only the 2D covariance entries consumed by the footprint:
// j^T * RS * RS^T * j = dot(RS^T * j, RS^T * j).
vec3 p0 = transpose(RS) * j0;
vec3 p1 = transpose(RS) * j1;
float a = dot(p0, p0);
float b = dot(p0, p1);
float d = dot(p1, p1);

// Optionally pre-blur to match non-antialias optimized splats.
a += preBlurAmount;
d += preBlurAmount;

float detOrig = a * d - b * b;
// Convolve with a 0.5-pixel Gaussian for anti-aliasing: sqrt(0.3) ~= 0.5.
a += blurAmount;
d += blurAmount;
float det = a * d - b * b;
if (det <= 0.0) return;

// Scale the peak intensity to preserve the convolved kernel's integral.
alpha *= sqrt(max(0.0, detOrig / det));
if (!(alpha > 0.0) || alpha < minAlpha) return;
