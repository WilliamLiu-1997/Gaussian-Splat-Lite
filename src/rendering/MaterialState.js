// Common render state follows the active material. The renderer owns blending,
// transparency, depth testing/writing and premultiplied alpha; each variant owns
// its shaders, uniforms, defines and node graph.
const commonProperties = [
  "name",
  "side",
  "vertexColors",
  "opacity",
  "blendSrc",
  "blendDst",
  "blendEquation",
  "blendSrcAlpha",
  "blendDstAlpha",
  "blendEquationAlpha",
  "blendColor",
  "blendAlpha",
  "depthFunc",
  "stencilWrite",
  "stencilWriteMask",
  "stencilFunc",
  "stencilRef",
  "stencilFuncMask",
  "stencilFail",
  "stencilZFail",
  "stencilZPass",
  "clippingPlanes",
  "clipping",
  "clipIntersection",
  "clipShadows",
  "shadowSide",
  "colorWrite",
  "precision",
  "polygonOffset",
  "polygonOffsetFactor",
  "polygonOffsetUnits",
  "dithering",
  "alphaTest",
  "alphaHash",
  "alphaToCoverage",
  "forceSinglePass",
  "allowOverride",
  "visible",
  "toneMapped",
  "userData",
  "fog",
  "wireframe",
  "wireframeLinewidth",
  "onBeforeRender",
  "onBeforeCompile",
  "customProgramCacheKey",
];

/** Keeps public material state and explicit shader updates across variants. */
export class MaterialState {
  constructor(material) {
    this.versions = new Map([[material, material.version]]);
  }

  sync(target, source) {
    let changed = false;
    if (target !== source) {
      for (const property of commonProperties) {
        if (target[property] !== source[property]) {
          // Keep external references to clipping planes, blendColor and userData.
          target[property] = source[property];
          changed = true;
        }
      }
    }
    // A user can change a shader hook's captured values and request an update
    // without replacing the hook. Refresh every previously used variant once.
    if (source.version !== this.versions.get(source)) {
      for (const material of this.versions.keys()) {
        if (material === source) continue;
        material.needsUpdate = true;
        this.record(material);
      }
      this.record(source);
    }
    if (changed) target.needsUpdate = true;
    this.record(target);
  }

  /** Records updates made by the renderer itself. */
  record(material) {
    this.versions.set(material, material.version);
  }
}
