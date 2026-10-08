// Runs after supportRadius is clipped to fragments that can reach minAlpha.
float eigenAvg = 0.5 * (a + d);
float eigenDelta = length(vec2(0.5 * (a - d), b));
float eigen1 = eigenAvg + eigenDelta;
// Keep a small positive minor axis when subtraction rounds to zero.
float eigen2 = max(eigenAvg - eigenDelta, 1e-4);

vec2 eigenVec1 = (abs(b) > 0.001)
    ? normalize(vec2(b, eigen1 - a))
    : ((a >= d) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
vec2 eigenVec2 = vec2(eigenVec1.y, -eigenVec1.x);

// Limit support to the viewport's short side, then shrink both the quad
// and its UV extent by the same ratio to preserve the Gaussian profile.
float maxProjectedRadius = min(renderSize.x, renderSize.y) * focalAdjustment;
float scale1 = min(maxProjectedRadius, maximumSupportRadius * sqrt(eigen1));
float scale2 = min(maxProjectedRadius, maximumSupportRadius * sqrt(eigen2));
float supportScale = (maximumSupportRadius > 0.0)
    ? supportRadius / maximumSupportRadius
    : 0.0;
