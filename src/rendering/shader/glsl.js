const context = `
struct SplatContext {
    vec3 color;
    vec3 viewCenter;
    vec3 viewNormal;
    float alpha;
    vec2 splatUv;
    vec2 screenUV;
};
vec3 effectLinearToSrgb(vec3 rgb) {
    return mix(pow(max(rgb, vec3(0.0)), vec3(0.4166666667)) * 1.055 - 0.055,
        rgb * 12.92, lessThanEqual(rgb, vec3(0.0031308)));
}
`;

/** Fixed insertion points; application code never edits the renderer's shader. */
export function effectGLSL(effect) {
  if (!effect)
    return {
      vertexPars: "",
      vertex: "",
      fragmentPars: "",
      opacity: "",
      fragment: "",
    };
  const hooks = effect.definition.glsl;
  const uniforms = Object.entries(effect.uniforms)
    .map(([name, uniform]) => `uniform ${uniform.type} effect_${name};`)
    .join("\n");
  const shared = `${context}\n${uniforms}\n${hooks.declarations ?? ""}`;
  const normal = effect.normals
    ? `
    vec3 towardViewer = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-viewCenter);
    vec3 localView = quatVec(vec4(-viewQuaternion.xyz, viewQuaternion.w), towardViewer);
    float shortest = min(scales.x, min(scales.y, scales.z));
    float width = shortest == 0.0 ? max(scales.x, max(scales.y, scales.z)) * 1e-6 : shortest;
    vec3 inverseScale = width / max(scales, vec3(width));
    vec3 normal = normalize(quatVec(viewQuaternion, localView * inverseScale * inverseScale));
    vEffectNormal = normal;
  `
    : "vec3 normal = vec3(0.0);";
  return {
    vertexPars: `${shared}
      flat out vec3 vEffectCenter;
      ${effect.normals ? "flat out vec3 vEffectNormal;" : ""}
      ${hooks.shadeSplat ? `vec3 effectShadeSplat(SplatContext splat) { ${hooks.shadeSplat} }` : ""}`,
    vertex: `
      ${normal}
      vEffectCenter = viewCenter;
      rgba.rgb = srgbToLinear(rgba.rgb);
      ${hooks.shadeSplat ? "rgba.rgb = effectShadeSplat(SplatContext(rgba.rgb, viewCenter, normal, alpha, vec2(0.0), vec2(0.0)));" : ""}`,
    fragmentPars: `${shared}
      uniform bool encodeLinear;
      uniform vec2 gslEffectFrameSize;
      flat in vec3 vEffectCenter;
      ${effect.normals ? "flat in vec3 vEffectNormal;" : ""}
      ${hooks.opacity ? `float effectOpacity(SplatContext splat) { ${hooks.opacity} }` : ""}
      ${hooks.shadeFragment ? `vec3 effectShadeFragment(SplatContext splat) { ${hooks.shadeFragment} }` : ""}`,
    opacity: `
      SplatContext splat = SplatContext(
        vec3(unpackHalf2x16(vSplat.x), blueKernelPower.x), vEffectCenter,
        ${effect.normals ? "vEffectNormal" : "vec3(0.0)"}, alpha, vSplatUv,
        vec2(gl_FragCoord.x / gslEffectFrameSize.x, 1.0 - gl_FragCoord.y / gslEffectFrameSize.y));
      ${hooks.opacity ? "alpha = clamp(effectOpacity(splat), 0.0, alpha);" : ""}
      splat.alpha = alpha;`,
    fragment: `
      ${hooks.shadeFragment ? "rgba.rgb = effectShadeFragment(splat);" : ""}
      if (!encodeLinear) rgba.rgb = effectLinearToSrgb(rgba.rgb);`,
  };
}
