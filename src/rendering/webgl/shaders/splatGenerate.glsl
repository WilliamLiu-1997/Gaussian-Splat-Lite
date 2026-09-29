#include <splatSource>
uniform uint targetLayer;
uniform int targetBase;
layout(location = 0) out uvec4 target;
layout(location = 1) out uvec4 target2;
layout(location = 2) out uint targetSeed;

void main() {
    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS)
        + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS)
        + int(gl_FragCoord.x);
    int index = targetIndex - targetBase;
    target = uvec4(0u);
    target2 = uvec4(0u);
    targetSeed = 0u;
    if (index >= 0 && index < targetCount) {
        GeneratedSplat splat = readSplat(index);
        targetSeed = splat.seed;
        if (splat.valid) encodeSplatLnScale(target, target2, splat.center,
            splat.lnScales, splat.quaternion, splat.rgba, splat.shapeAmount);
    }
}
