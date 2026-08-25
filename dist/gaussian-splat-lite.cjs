"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const THREE = require("three");
const Pass_js = require("three/addons/postprocessing/Pass.js");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const THREE__namespace = /* @__PURE__ */ _interopNamespaceDefault(THREE);
function rebaseAffineTransform(matrix, origin) {
  const elements = matrix.elements;
  const x = origin.x;
  const y = origin.y;
  const z = origin.z;
  const tx = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
  const ty = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
  const tz = elements[2] * x + elements[6] * y + elements[10] * z + elements[14];
  elements[12] = tx;
  elements[13] = ty;
  elements[14] = tz;
  return matrix;
}
class SortCenterCache {
  constructor() {
    this.entries = /* @__PURE__ */ new Map();
    this.freeMeshIds = [];
    this.nextMeshId = 0;
  }
  allocateMeshId() {
    const reused = this.freeMeshIds.pop();
    if (reused !== void 0) return reused;
    if (this.nextMeshId > 4294967295) {
      throw new Error("Sort center mesh ID space exhausted");
    }
    return this.nextMeshId++;
  }
  dispose() {
    this.entries.clear();
    this.freeMeshIds.length = 0;
    this.nextMeshId = 0;
  }
  prepare(current) {
    const rangeMeshIds = new Uint32Array(current.mapping.length);
    const rangeBases = new Uint32Array(current.mapping.length);
    const rangeCounts = new Uint32Array(current.mapping.length);
    const rangeOrigins = new Float64Array(current.mapping.length * 3);
    const retiredNodes = new Set(this.entries.keys());
    const changed = [];
    let updateCount = 0;
    current.mapping.forEach(
      ({ node, base, count, sortVersion }, rangeIndex) => {
        retiredNodes.delete(node);
        let entry = this.entries.get(node);
        if (!entry) {
          entry = {
            meshId: this.allocateMeshId(),
            sortVersion: -1
          };
          this.entries.set(node, entry);
        }
        rangeMeshIds[rangeIndex] = entry.meshId;
        rangeBases[rangeIndex] = base;
        rangeCounts[rangeIndex] = count;
        const elements = node.matrixWorld.elements;
        const originTarget = rangeIndex * 3;
        rangeOrigins[originTarget] = elements[12];
        rangeOrigins[originTarget + 1] = elements[13];
        rangeOrigins[originTarget + 2] = elements[14];
        if (entry.sortVersion !== sortVersion) {
          changed.push({
            node,
            entry,
            count,
            rangeIndex,
            sortVersion
          });
          updateCount += count;
        }
      }
    );
    const updateRangeIndices = new Uint32Array(changed.length);
    const updateCenters = new Float32Array(updateCount * 3);
    updateCenters.fill(Number.NaN);
    let updateBase = 0;
    changed.forEach(({ node, count, rangeIndex }, updateIndex) => {
      var _a;
      updateRangeIndices[updateIndex] = rangeIndex;
      const elements = node.matrixWorld.elements;
      (_a = node.splats) == null ? void 0 : _a.forEachCenter((index, x, y, z) => {
        if (index >= count || Number.isNaN(x)) return;
        const target = (updateBase + index) * 3;
        updateCenters[target] = elements[0] * x + elements[4] * y + elements[8] * z;
        updateCenters[target + 1] = elements[1] * x + elements[5] * y + elements[9] * z;
        updateCenters[target + 2] = elements[2] * x + elements[6] * y + elements[10] * z;
      });
      updateBase += count;
    });
    return {
      payload: {
        updateRangeIndices,
        updateCenters,
        rangeMeshIds,
        rangeBases,
        rangeCounts,
        rangeOrigins
      },
      commit: () => {
        for (const { entry, sortVersion } of changed) {
          entry.sortVersion = sortVersion;
        }
        for (const node of retiredNodes) {
          const entry = this.entries.get(node);
          if (!entry) continue;
          this.entries.delete(node);
          this.freeMeshIds.push(entry.meshId);
        }
      }
    };
  }
}
var SplatEditSdfType = /* @__PURE__ */ ((SplatEditSdfType2) => {
  SplatEditSdfType2["ALL"] = "all";
  SplatEditSdfType2["PLANE"] = "plane";
  SplatEditSdfType2["SPHERE"] = "sphere";
  SplatEditSdfType2["BOX"] = "box";
  SplatEditSdfType2["ELLIPSOID"] = "ellipsoid";
  SplatEditSdfType2["CYLINDER"] = "cylinder";
  SplatEditSdfType2["CAPSULE"] = "capsule";
  SplatEditSdfType2["INFINITE_CONE"] = "infinite_cone";
  return SplatEditSdfType2;
})(SplatEditSdfType || {});
var SplatEditRgbaBlendMode = /* @__PURE__ */ ((SplatEditRgbaBlendMode2) => {
  SplatEditRgbaBlendMode2["MULTIPLY"] = "multiply";
  SplatEditRgbaBlendMode2["SET_RGB"] = "set_rgb";
  SplatEditRgbaBlendMode2["ADD_RGBA"] = "add_rgba";
  return SplatEditRgbaBlendMode2;
})(SplatEditRgbaBlendMode || {});
class SplatEditSdf extends THREE__namespace.Object3D {
  constructor(options = {}) {
    super();
    this.type = options.type ?? "sphere";
    this.invert = options.invert ?? false;
    this.opacity = options.opacity ?? 1;
    this.color = options.color ?? new THREE__namespace.Color(1, 1, 1);
    this.radius = options.radius ?? 0;
  }
}
const _SplatEdit = class _SplatEdit extends THREE__namespace.Object3D {
  constructor(options = {}) {
    super();
    this.rgbaBlendMode = options.rgbaBlendMode ?? "multiply";
    this.sdfSmooth = options.sdfSmooth ?? 0;
    this.softEdge = options.softEdge ?? 0;
    this.invert = options.invert ?? false;
    this.sdfs = options.sdfs ?? null;
    this.ordering = _SplatEdit.nextOrdering++;
    this.name = options.name ?? `Edit ${this.ordering}`;
  }
  addSdf(sdf) {
    this.sdfs ?? (this.sdfs = []);
    if (!this.sdfs.includes(sdf)) {
      this.sdfs.push(sdf);
    }
  }
  removeSdf(sdf) {
    if (this.sdfs) {
      this.sdfs = this.sdfs.filter((candidate) => candidate !== sdf);
    }
  }
};
_SplatEdit.nextOrdering = 1;
let SplatEdit = _SplatEdit;
const SDF_TEXELS = 5;
const MIN_CAPACITY = 16;
const scratchFloat = new Float32Array(1);
const scratchUint = new Uint32Array(scratchFloat.buffer);
const _SplatEdits = class _SplatEdits {
  constructor({ maxSdfs = 0, maxEdits = 0 } = {}) {
    this.numSdfs = 0;
    this.numEdits = 0;
    this.maxSdfs = Math.max(MIN_CAPACITY, maxSdfs);
    this.sdfData = new Uint32Array(this.maxSdfs * SDF_TEXELS * 4);
    this.sdfFloatData = new Float32Array(this.sdfData.buffer);
    this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);
    this.maxEdits = Math.max(MIN_CAPACITY, maxEdits);
    this.editData = new Uint32Array(this.maxEdits * 4);
    this.editFloatData = new Float32Array(this.editData.buffer);
    this.editTexture = makeUintTexture(this.editData, 1, this.maxEdits);
  }
  dispose() {
    this.sdfTexture.dispose();
    this.editTexture.dispose();
  }
  update(groups, coordinateOrigin) {
    const sdfCount = groups.reduce(
      (total, group) => total + group.sdfs.length,
      0
    );
    let updated = this.ensureCapacity(sdfCount, groups.length);
    if (this.numSdfs !== sdfCount || this.numEdits !== groups.length) {
      this.numSdfs = sdfCount;
      this.numEdits = groups.length;
      updated = true;
    }
    const center = new THREE__namespace.Vector3();
    const quaternion = new THREE__namespace.Quaternion();
    const inverseScale = new THREE__namespace.Vector3();
    const sizes = new THREE__namespace.Vector4();
    const worldToSdf = new THREE__namespace.Matrix4();
    let sdfIndex = 0;
    let sdfUpdated = false;
    let editUpdated = false;
    groups.forEach(({ edit, sdfs }, editIndex) => {
      editUpdated = this.encodeEdit(editIndex, edit, sdfIndex, sdfs.length) || editUpdated;
      for (const sdf of sdfs) {
        sizes.set(sdf.scale.x, sdf.scale.y, sdf.scale.z, sdf.radius);
        const originalScale = sdf.scale.clone();
        try {
          sdf.scale.setScalar(1);
          sdf.updateWorldMatrix(true, false);
          worldToSdf.copy(sdf.matrixWorld).invert();
          if (coordinateOrigin) {
            rebaseAffineTransform(worldToSdf, coordinateOrigin);
          }
          worldToSdf.decompose(center, quaternion, inverseScale);
        } finally {
          sdf.scale.copy(originalScale);
          sdf.updateWorldMatrix(true, false);
        }
        sdfUpdated = this.encodeSdf(
          sdfIndex,
          sdf,
          center,
          quaternion,
          inverseScale,
          sizes
        ) || sdfUpdated;
        sdfIndex += 1;
      }
    });
    if (sdfUpdated) {
      this.sdfTexture.needsUpdate = true;
    }
    if (editUpdated) {
      this.editTexture.needsUpdate = true;
    }
    return { updated: updated || sdfUpdated || editUpdated };
  }
  ensureCapacity(sdfs, edits) {
    let updated = false;
    if (sdfs > this.maxSdfs) {
      this.maxSdfs = Math.max(sdfs, this.maxSdfs * 2);
      this.sdfTexture.dispose();
      this.sdfData = new Uint32Array(this.maxSdfs * SDF_TEXELS * 4);
      this.sdfFloatData = new Float32Array(this.sdfData.buffer);
      this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);
      updated = true;
    }
    if (edits > this.maxEdits) {
      this.maxEdits = Math.max(edits, this.maxEdits * 2);
      this.editTexture.dispose();
      this.editData = new Uint32Array(this.maxEdits * 4);
      this.editFloatData = new Float32Array(this.editData.buffer);
      this.editTexture = makeUintTexture(this.editData, 1, this.maxEdits);
      updated = true;
    }
    return updated;
  }
  encodeEdit(index, edit, sdfFirst, sdfCount) {
    if (sdfFirst > 65535 || sdfCount > 65535) {
      throw new Error("An SDF edit supports at most 65535 shapes");
    }
    const base = index * 4;
    const blend = rgbaBlendModeToNumber(edit.rgbaBlendMode);
    const flags = blend | (edit.invert ? 1 << 8 : 0);
    let updated = this.setEditUint(base, flags);
    updated = this.setEditUint(base + 1, sdfFirst | sdfCount << 16) || updated;
    updated = this.setEditFloat(base + 2, edit.softEdge) || updated;
    updated = this.setEditFloat(base + 3, edit.sdfSmooth) || updated;
    return updated;
  }
  encodeSdf(index, sdf, center, quaternion, scale, sizes) {
    const base = index * SDF_TEXELS * 4;
    const flags = sdfTypeToNumber(sdf.type) | (sdf.invert ? 1 << 8 : 0);
    let updated = this.setSdfFloat(base, center.x);
    updated = this.setSdfFloat(base + 1, center.y) || updated;
    updated = this.setSdfFloat(base + 2, center.z) || updated;
    updated = this.setSdfUint(base + 3, flags) || updated;
    updated = this.setSdfFloat(base + 4, quaternion.x) || updated;
    updated = this.setSdfFloat(base + 5, quaternion.y) || updated;
    updated = this.setSdfFloat(base + 6, quaternion.z) || updated;
    updated = this.setSdfFloat(base + 7, quaternion.w) || updated;
    updated = this.setSdfFloat(base + 8, scale.x) || updated;
    updated = this.setSdfFloat(base + 9, scale.y) || updated;
    updated = this.setSdfFloat(base + 10, scale.z) || updated;
    updated = this.setSdfUint(base + 11, 0) || updated;
    updated = this.setSdfFloat(base + 12, sizes.x) || updated;
    updated = this.setSdfFloat(base + 13, sizes.y) || updated;
    updated = this.setSdfFloat(base + 14, sizes.z) || updated;
    updated = this.setSdfFloat(base + 15, sizes.w) || updated;
    updated = this.setSdfFloat(base + 16, sdf.color.r) || updated;
    updated = this.setSdfFloat(base + 17, sdf.color.g) || updated;
    updated = this.setSdfFloat(base + 18, sdf.color.b) || updated;
    updated = this.setSdfFloat(base + 19, sdf.opacity) || updated;
    return updated;
  }
  setSdfUint(offset, value) {
    const updated = this.sdfData[offset] !== value;
    this.sdfData[offset] = value;
    return updated;
  }
  setSdfFloat(offset, value) {
    scratchFloat[0] = value;
    return this.setSdfUint(offset, scratchUint[0]);
  }
  setEditUint(offset, value) {
    const updated = this.editData[offset] !== value;
    this.editData[offset] = value;
    return updated;
  }
  setEditFloat(offset, value) {
    scratchFloat[0] = value;
    return this.setEditUint(offset, scratchUint[0]);
  }
};
_SplatEdits.emptyTexture = makeUintTexture(new Uint32Array(4), 1, 1);
let SplatEdits = _SplatEdits;
function rgbaBlendModeToNumber(mode) {
  switch (mode) {
    case "multiply":
      return 0;
    case "set_rgb":
      return 1;
    case "add_rgba":
      return 2;
  }
}
function sdfTypeToNumber(type) {
  switch (type) {
    case "all":
      return 0;
    case "plane":
      return 1;
    case "sphere":
      return 2;
    case "box":
      return 3;
    case "ellipsoid":
      return 4;
    case "cylinder":
      return 5;
    case "capsule":
      return 6;
    case "infinite_cone":
      return 7;
  }
}
function makeUintTexture(data, width, height) {
  const texture = new THREE__namespace.DataTexture(
    data,
    width,
    height,
    THREE__namespace.RGBAIntegerFormat,
    THREE__namespace.UnsignedIntType
  );
  texture.internalFormat = "RGBA32UI";
  texture.magFilter = THREE__namespace.NearestFilter;
  texture.minFilter = THREE__namespace.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
function get_raycast_buffer() {
  const ret = wasm.get_raycast_buffer();
  return ret;
}
function get_raycast_buffer2() {
  const ret = wasm.get_raycast_buffer2();
  return ret;
}
function raycast_splat_buffers(origin_x, origin_y, origin_z, dir_x, dir_y, dir_z, min_opacity, near, far, count) {
  const ret = wasm.raycast_splat_buffers(origin_x, origin_y, origin_z, dir_x, dir_y, dir_z, min_opacity, near, far, count);
  return ret;
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_debug_string_dd5d2d07ce9e6c57: function(arg0, arg1) {
      const ret = debugString(arg1);
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
      let deferred0_0;
      let deferred0_1;
      try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
      } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
      }
    },
    __wbg_get_index_983d655608220248: function(arg0, arg1) {
      const ret = arg0[arg1 >>> 0];
      return ret;
    },
    __wbg_length_0c32cb8543c8e4c8: function(arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_length_1e701798fdcaa3b4: function(arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_length_526c0f6e4ebae15d: function(arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_length_fd4646b401926788: function(arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_new_227d7c05414eb861: function() {
      const ret = new Error();
      return ret;
    },
    __wbg_new_4f9fafbb3909af72: function() {
      const ret = new Object();
      return ret;
    },
    __wbg_new_with_length_41a22191b9bdfd66: function(arg0) {
      const ret = new Uint32Array(arg0 >>> 0);
      return ret;
    },
    __wbg_prototypesetcall_021fd89d67217368: function(arg0, arg1, arg2) {
      Float64Array.prototype.set.call(getArrayF64FromWasm0(arg0, arg1), arg2);
    },
    __wbg_prototypesetcall_3e05eb9545565046: function(arg0, arg1, arg2) {
      Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    },
    __wbg_prototypesetcall_66c8e1fb820946be: function(arg0, arg1, arg2) {
      Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);
    },
    __wbg_prototypesetcall_e42275e601e14eeb: function(arg0, arg1, arg2) {
      Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);
    },
    __wbg_set_448126769bf7c181: function(arg0, arg1, arg2) {
      arg0.set(getArrayU32FromWasm0(arg1, arg2));
    },
    __wbg_set_8ee2d34facb8466e: function() {
      return handleError(function(arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
      }, arguments);
    },
    __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
      const ret = arg1.stack;
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg_subarray_0f98d3fb634508ad: function(arg0, arg1, arg2) {
      const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
      return ret;
    },
    __wbg_subarray_4342405c1ffc86d6: function(arg0, arg1, arg2) {
      const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
      return ret;
    },
    __wbg_subarray_d51e89458b3fdbf6: function(arg0, arg1, arg2) {
      const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
      return ret;
    },
    __wbindgen_cast_0000000000000001: function(arg0) {
      const ret = arg0;
      return ret;
    },
    __wbindgen_cast_0000000000000002: function(arg0, arg1) {
      const ret = getArrayF32FromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_cast_0000000000000003: function(arg0, arg1) {
      const ret = getArrayU32FromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_cast_0000000000000004: function(arg0, arg1) {
      const ret = getStringFromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_init_externref_table: function() {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, void 0);
      table.set(offset + 0, void 0);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    }
  };
  return {
    __proto__: null,
    "./gaussian_splat_rs_bg.js": import0
  };
}
typeof FinalizationRegistry === "undefined" ? {} : new FinalizationRegistry((ptr) => wasm.__wbg_chunkdecoder_free(ptr >>> 0, 1));
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayF64FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}
function getArrayU32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
  if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
    cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
  }
  return cachedFloat64ArrayMemory0;
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
  if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
    cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
  }
  return cachedUint32ArrayMemory0;
}
let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
const cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
let WASM_VECTOR_LEN = 0;
let wasm;
function __wbg_finalize_init(instance, module2) {
  wasm = instance.exports;
  cachedDataViewMemory0 = null;
  cachedFloat32ArrayMemory0 = null;
  cachedFloat64ArrayMemory0 = null;
  cachedUint32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_load(module2, imports) {
  if (typeof Response === "function" && module2 instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module2, imports);
      } catch (e) {
        const validResponse = module2.ok && expectedResponseType(module2.type);
        if (validResponse && module2.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module2.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module2, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module: module2 };
    } else {
      return instance;
    }
  }
  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (module_or_path !== void 0) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module: module2 } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance);
}
const SPLAT_TEX_WIDTH_BITS = 11;
const SPLAT_TEX_HEIGHT_BITS = 11;
const SPLAT_TEX_WIDTH = 1 << SPLAT_TEX_WIDTH_BITS;
const SPLAT_TEX_HEIGHT = 1 << SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_MIN_HEIGHT = 1;
var SplatFileType = /* @__PURE__ */ ((SplatFileType2) => {
  SplatFileType2["PLY"] = "ply";
  SplatFileType2["SPZ"] = "spz";
  return SplatFileType2;
})(SplatFileType || {});
const defines = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
  SPLAT_TEX_WIDTH_BITS,
  SplatFileType
}, Symbol.toStringTag, { value: "Module" }));
const threeRevision = Number.parseInt(THREE__namespace.REVISION);
const threeMrtArray = threeRevision >= 179;
const MAX_SPLAT_OPACITY = 1e3;
const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16buffer = supportsFloat16Array ? new globalThis["Float16Array"](1) : null;
const u16buffer = new Uint16Array(f16buffer == null ? void 0 : f16buffer.buffer);
function floatBitsToUint(f) {
  f32buffer[0] = f;
  return u32buffer[0];
}
function uintBitsToFloat(u) {
  u32buffer[0] = u;
  return f32buffer[0];
}
const toHalf = supportsFloat16Array ? toHalfNative : toHalfJS;
const fromHalf = supportsFloat16Array ? fromHalfNative : fromHalfJS;
function toHalfNative(f) {
  f16buffer[0] = f;
  return u16buffer[0];
}
function toHalfJS(f) {
  f32buffer[0] = f;
  const bits = u32buffer[0];
  const sign = bits >> 31 & 1;
  const exp = bits >> 23 & 255;
  const frac = bits & 8388607;
  const halfSign = sign << 15;
  if (exp === 255) {
    if (frac !== 0) {
      return halfSign | 32767;
    }
    return halfSign | 31744;
  }
  const newExp = exp - 127 + 15;
  if (newExp >= 31) {
    return halfSign | 31744;
  }
  if (newExp <= 0) {
    if (newExp < -10) {
      return halfSign;
    }
    const subFrac = (frac | 8388608) >> 1 - newExp + 13;
    return halfSign | subFrac;
  }
  const halfFrac = frac >> 13;
  return halfSign | newExp << 10 | halfFrac;
}
function fromHalfNative(u) {
  u16buffer[0] = u;
  return f16buffer[0];
}
function fromHalfJS(h) {
  const sign = h >> 15 & 1;
  const exp = h >> 10 & 31;
  const frac = h & 1023;
  let f32bits;
  if (exp === 0) {
    if (frac === 0) {
      f32bits = sign << 31;
    } else {
      let mant = frac;
      let e = -14;
      while ((mant & 1024) === 0) {
        mant <<= 1;
        e--;
      }
      mant &= 1023;
      const newExp = e + 127;
      const newFrac = mant << 13;
      f32bits = sign << 31 | newExp << 23 | newFrac;
    }
  } else if (exp === 31) {
    if (frac === 0) {
      f32bits = sign << 31 | 2139095040;
    } else {
      f32bits = sign << 31 | 2143289344;
    }
  } else {
    const newExp = exp - 15 + 127;
    const newFrac = frac << 13;
    f32bits = sign << 31 | newExp << 23 | newFrac;
  }
  u32buffer[0] = f32bits;
  return f32buffer[0];
}
function getTransferable(ctx) {
  const buffers = [];
  const seen = /* @__PURE__ */ new Set();
  function traverse(obj) {
    if (obj && typeof obj === "object" && !seen.has(obj)) {
      seen.add(obj);
      if (obj instanceof ArrayBuffer) {
        buffers.push(obj);
      } else if (ArrayBuffer.isView(obj)) {
        buffers.push(obj.buffer);
      } else if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else {
        Object.values(obj).forEach(traverse);
      }
    }
  }
  traverse(ctx);
  return buffers;
}
function encodeSplat(splatArrays, index, x, y, z, scaleX, scaleY, scaleZ, quatX, quatY, quatZ, quatW, opacity, r, g, b) {
  const i4 = index * 4;
  const [splatA, splatB] = splatArrays;
  splatA[i4] = floatBitsToUint(x);
  splatA[i4 + 1] = floatBitsToUint(y);
  splatA[i4 + 2] = floatBitsToUint(z);
  const rawOpacity = THREE__namespace.MathUtils.clamp(opacity, 0, MAX_SPLAT_OPACITY);
  if (rawOpacity > 1) {
    const shapeAmount = 0.25 * (Math.sqrt(1 + Math.E * Math.log(rawOpacity)) - 1);
    splatA[i4 + 3] = toHalf(1) | toHalf(shapeAmount) << 16;
  } else {
    splatA[i4 + 3] = toHalf(rawOpacity);
  }
  splatB[i4] = toHalf(r) | toHalf(g) << 16;
  splatB[i4 + 1] = toHalf(b) | toHalf(Math.log(scaleX)) << 16;
  splatB[i4 + 2] = toHalf(Math.log(scaleY)) | toHalf(Math.log(scaleZ)) << 16;
  splatB[i4 + 3] = encodeQuatOctXy1010R12(quatX, quatY, quatZ, quatW);
}
function decodeSplat(splatArrays, index) {
  const result = splatFields;
  const i4 = index * 4;
  const [splatA, splatB] = splatArrays;
  result.center.x = uintBitsToFloat(splatA[i4]);
  result.center.y = uintBitsToFloat(splatA[i4 + 1]);
  result.center.z = uintBitsToFloat(splatA[i4 + 2]);
  const opacityWord = splatA[i4 + 3];
  const shapeAmountBits = opacityWord >>> 16;
  if (shapeAmountBits === 0) {
    result.opacity = fromHalf(opacityWord & 65535);
  } else {
    const shapeAmount = fromHalf(shapeAmountBits);
    if (shapeAmount > 0) {
      const kernelShape = 1 + 4 * shapeAmount;
      result.opacity = Math.min(
        MAX_SPLAT_OPACITY,
        Math.exp((kernelShape * kernelShape - 1) / Math.E)
      );
    } else {
      result.opacity = fromHalf(opacityWord & 65535);
    }
  }
  result.color.r = fromHalf(splatB[i4] & 65535);
  result.color.g = fromHalf(splatB[i4] >>> 16);
  result.color.b = fromHalf(splatB[i4 + 1] & 65535);
  result.scales.x = Math.exp(fromHalf(splatB[i4 + 1] >>> 16));
  result.scales.y = Math.exp(fromHalf(splatB[i4 + 2] & 65535));
  result.scales.z = Math.exp(fromHalf(splatB[i4 + 2] >>> 16));
  decodeQuatOctXy1010R12(splatB[i4 + 3], result.quaternion);
  return result;
}
const splatCenter = new THREE__namespace.Vector3();
const splatScales = new THREE__namespace.Vector3();
const splatQuaternion = new THREE__namespace.Quaternion();
const splatColor = new THREE__namespace.Color();
const splatFields = {
  center: splatCenter,
  scales: splatScales,
  quaternion: splatQuaternion,
  color: splatColor,
  opacity: 0
};
function getTextureSize(numSplats) {
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width))
  );
  const depth = Math.ceil(numSplats / (width * height));
  const maxSplats = width * height * depth;
  return { width, height, depth, maxSplats };
}
const IDENT_VERTEX_SHADER = `
precision highp float;

in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
function encodeQuatOctXy1010R12(qx, qy, qz, qw) {
  const qlen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  const qnx = (qw < 0 ? -qx : qx) / qlen;
  const qny = (qw < 0 ? -qy : qy) / qlen;
  const qnz = (qw < 0 ? -qz : qz) / qlen;
  const qnw = (qw < 0 ? -qw : qw) / qlen;
  const theta = 2 * Math.acos(qnw);
  const xyz_norm = Math.sqrt(qnx * qnx + qny * qny + qnz * qnz);
  const axisX2 = xyz_norm < 1e-6 ? 1 : qnx / xyz_norm;
  const axisY2 = xyz_norm < 1e-6 ? 0 : qny / xyz_norm;
  const axisZ2 = xyz_norm < 1e-6 ? 0 : qnz / xyz_norm;
  const sum = Math.abs(axisX2) + Math.abs(axisY2) + Math.abs(axisZ2);
  let p_x = axisX2 / sum;
  let p_y = axisY2 / sum;
  if (axisZ2 < 0) {
    const tmp = p_x;
    p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
    p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
  }
  const u_f = p_x * 0.5 + 0.5;
  const v_f = p_y * 0.5 + 0.5;
  const quantU = Math.round(u_f * 1023);
  const quantV = Math.round(v_f * 1023);
  const angleInt = Math.round(theta * (4095 / Math.PI));
  return angleInt << 20 | quantV << 10 | quantU;
}
function decodeQuatOctXy1010R12(encoded, out) {
  const quantU = encoded & 1023;
  const quantV = encoded >>> 10 & 1023;
  const angleInt = encoded >>> 20 & 4095;
  const u_f = quantU / 1023;
  const v_f = quantV / 1023;
  let f_x = (u_f - 0.5) * 2;
  let f_y = (v_f - 0.5) * 2;
  const f_z = 1 - (Math.abs(f_x) + Math.abs(f_y));
  const t = Math.max(-f_z, 0);
  f_x += f_x >= 0 ? -t : t;
  f_y += f_y >= 0 ? -t : t;
  const axisLen = Math.sqrt(f_x * f_x + f_y * f_y + f_z * f_z);
  const axisX2 = axisLen < 1e-6 ? 0 : f_x / axisLen;
  const axisY2 = axisLen < 1e-6 ? 0 : f_y / axisLen;
  const axisZ2 = axisLen < 1e-6 ? 0 : f_z / axisLen;
  const theta = angleInt / 4095 * Math.PI;
  const halfTheta = theta * 0.5;
  const s = Math.sin(halfTheta);
  const w = Math.cos(halfTheta);
  out.set(axisX2 * s, axisY2 * s, axisZ2 * s, w);
  return out;
}
function uploadU32DataTextureRows(renderer, texture, width, rows, data) {
  const gl = renderer.getContext();
  const props = renderer.properties.get(texture);
  const glTexture = props == null ? void 0 : props.__webglTexture;
  if (!glTexture) {
    throw new Error("texture not found");
  }
  const currentFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const currentPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  renderer.state.activeTexture(gl.TEXTURE0);
  renderer.state.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    rows,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    data
  );
  renderer.state.unbindTexture();
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, currentFlipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, currentPremultiply);
}
function resolveTimer(timer) {
  return {
    timer: timer ?? new THREE__namespace.Timer(),
    // A caller-supplied timer may be shared with other systems, so only update
    // the timer that Gaussian Splat Lite creates and owns itself.
    ownsTimer: timer === void 0
  };
}
const utils = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  IDENT_VERTEX_SHADER,
  decodeQuatOctXy1010R12,
  decodeSplat,
  encodeQuatOctXy1010R12,
  encodeSplat,
  floatBitsToUint,
  fromHalf,
  getTextureSize,
  getTransferable,
  resolveTimer,
  threeMrtArray,
  threeRevision,
  toHalf,
  uintBitsToFloat,
  uploadU32DataTextureRows
}, Symbol.toStringTag, { value: "Module" }));
function b64ToUint6(nChr) {
  return nChr > 64 && nChr < 91 ? nChr - 65 : nChr > 96 && nChr < 123 ? nChr - 71 : nChr > 47 && nChr < 58 ? nChr + 4 : nChr === 43 ? 62 : nChr === 47 ? 63 : 0;
}
function base64ToUint8(sBase64, nBlocksSize) {
  const sB64Enc = sBase64.replace(/[^A-Za-z0-9+/]/g, "");
  const nInLen = sB64Enc.length;
  const nOutLen = nBlocksSize ? Math.ceil((nInLen * 3 + 1 >> 2) / nBlocksSize) * nBlocksSize : nInLen * 3 + 1 >> 2;
  const taBytes = new Uint8Array(nOutLen);
  let nMod3;
  let nMod4;
  let nUint24 = 0;
  let nOutIdx = 0;
  for (let nInIdx = 0; nInIdx < nInLen; nInIdx++) {
    nMod4 = nInIdx & 3;
    nUint24 |= b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << 6 * (3 - nMod4);
    if (nMod4 === 3 || nInLen - nInIdx === 1) {
      nMod3 = 0;
      while (nMod3 < 3 && nOutIdx < nOutLen) {
        taBytes[nOutIdx] = nUint24 >>> (16 >>> nMod3 & 24) & 255;
        nMod3++;
        nOutIdx++;
      }
      nUint24 = 0;
    }
  }
  return taBytes;
}
function toUint8(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  let bin = atob(b64);
  let len = bin.length;
  let bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
const decode64 = typeof atob === "function" ? toUint8 : base64ToUint8;
const wasmBytes = decode64("AGFzbQEAAAABngM5YAN/f38Bf2ACf38Bf2ABfwBgAn9/AGABfwF/YAN/f38AYAV/f39/fwBgBH9/f38AYAAAYAF9AX1gBn9/f39/fwBgBH9/f38Bf2AFf39/f38Bf2AAAW9gAW8Bf2ADf39vAGAAA39/f2AAAn9/YANvf38Bb2ACf38Bb2AJf39/f399f39/AGACf28AYAd/f39/f39/AGAGf39/f39/AX9gBX9/fn9/AGAFf398f38AYAV/f31/fwBgA29vbwF/YANvf38AYAF/AW9gAm9/AX9gAXwBb2AJf39/f39/f39/AGAEf39+fgBgB39/f39/f38Bf2ADf399AGAEfn5/fwF+YAJ/fwF+YAV/f39/fwF9YAR/f39/AX1gAAF/YAJ/fgF/YAF/AX1gBn9/f35/fwBgBn9/f3x/fwBgBn9/f31/fwBgBm9vb29vbwBgBH9/f38Df39/YAF/A39/f2ACf3wCf39gAn9vAn9/YAp9fX19fX19fX1/AW9gBH9+f38AYAR/fX9/AGAEf3x/fwBgCX98fHx9fX1/bwF/YAF8AX8CugwaGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMaX193YmdfbmV3XzRmOWZhZmJiMzkwOWFmNzIADRkuL2dhdXNzaWFuX3NwbGF0X3JzX2JnLmpzGl9fd2JnX3NldF84ZWUyZDM0ZmFjYjg0NjZlABsZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcx9fX3diZ19zdWJhcnJheV9kNTFlODk0NThiM2ZkYmY2ABIZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcx1fX3diZ19sZW5ndGhfMWU3MDE3OThmZGNhYTNiNAAOGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMaX193Ymdfc2V0XzQ0ODEyNjc2OWJmN2MxODEAHBkuL2dhdXNzaWFuX3NwbGF0X3JzX2JnLmpzJ19fd2JnX3Byb3RvdHlwZXNldGNhbGxfZTQyMjc1ZTYwMWUxNGVlYgAPGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMmX193YmdfbmV3X3dpdGhfbGVuZ3RoXzQxYTIyMTkxYjliZGZkNjYAHRkuL2dhdXNzaWFuX3NwbGF0X3JzX2JnLmpzHV9fd2JnX2xlbmd0aF8wYzMyY2I4NTQzYzhlNGM4AA4ZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcx9fX3diZ19zdWJhcnJheV8wZjk4ZDNmYjYzNDUwOGFkABIZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcydfX3diZ19wcm90b3R5cGVzZXRjYWxsXzNlMDVlYjk1NDU1NjUwNDYADxkuL2dhdXNzaWFuX3NwbGF0X3JzX2JnLmpzHV9fd2JnX2xlbmd0aF81MjZjMGY2ZTRlYmFlMTVkAA4ZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcyBfX3diZ19nZXRfaW5kZXhfOTgzZDY1NTYwODIyMDI0OAAeGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMdX193YmdfbGVuZ3RoX2ZkNDY0NmI0MDE5MjY3ODgADhkuL2dhdXNzaWFuX3NwbGF0X3JzX2JnLmpzH19fd2JnX3N1YmFycmF5XzQzNDI0MDVjMWZmYzg2ZDYAEhkuL2dhdXNzaWFuX3NwbGF0X3JzX2JnLmpzJ19fd2JnX3Byb3RvdHlwZXNldGNhbGxfNjZjOGUxZmI4MjA5NDZiZQAPGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMnX193YmdfcHJvdG90eXBlc2V0Y2FsbF8wMjFmZDg5ZDY3MjE3MzY4AA8ZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcxpfX3diZ19uZXdfMjI3ZDdjMDU0MTRlYjg2MQANGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMcX193Ymdfc3RhY2tfM2IwZDk3NGJiZjMxZTQ0ZgAVGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMcX193YmdfZXJyb3JfYTZmYTIwMmI1OGFhMWNkMwADGS4vZ2F1c3NpYW5fc3BsYXRfcnNfYmcuanMnX193YmdfX193YmluZGdlbl90aHJvd184MWZjNzc2NzlhZjgzYmM2AAMZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcy5fX3diZ19fX3diaW5kZ2VuX2RlYnVnX3N0cmluZ19kZDVkMmQwN2NlOWU2YzU3ABUZLi9nYXVzc2lhbl9zcGxhdF9yc19iZy5qcx9fX3diaW5kZ2VuX2luaXRfZXh0ZXJucmVmX3RhYmxlAAgZLi9nYXVzc2lhbl9zcGxhdF9yc19i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ISUgF0GVvMEAQQcQswEhAkGcvMEAQRgQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhOCACKAIAISogF0G0vMEAQQcQswEhAkG7vMEAQRgQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhKyACKAIAIRwgF0HTvMEAQQcQswEhAkHavMEAQRgQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhLyACKAIAITsgF0HyvMEAQQUQswEhAkH3vMEAQRYQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhMCACKAIAITEgF0GNvcEAQQUQswEhAkGSvcEAQRYQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhNSACKAIAITwgF0GovcEAQQUQswEhAkGtvcEAQRYQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhNiACKAIAITcgF0HDvcEAQQUQswEhAkHIvcEAQRYQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhIiACKAIAIScgF0HevcEAQQcQswEhAkHlvcEAQRgQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhKSACKAIAISEgF0H9vcEAQQYQswEhAkGDvsEAQRcQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhGyACKAIAISMgF0GavsEAQQYQswEhAkGgvsEAQRcQsQIhASACBEAgASABKAIAKAIAEQIAIAItAAQhECACKAIAIRUgF0G3vsEAQQYQswEhAkG9vsEAQRcQsQIhASACBEAgASABKAIAKAIAEQIAIB5BBGqtQoCAgIDQAYQhSSACLQAEIRkgAigCACEUQQAhAQJAAkACQAJAAkADQAJAIB4gATYCBCAeIEk3AwggHkH4AmpBnIHAACAeQQhqEP8BIBcgHigC/AIiASAeKAKAAxC7ASEGIB4oAvgCIQIgBkUEQCACBEAgASACQQEQgwILQQAhCEEBIQFB/wEhGEH/ASEOQf8BIRogHigCBCICDhkHAwMDAwMDAwMGAwMDAwMDAwMDAwMDAwMEAQsgAgRAIAEgAkEBEIMCCyAeKAIEQQFqIQEMAQsLIAJBLUYNAgsgHiBJNwP4AiAeQRBqIgFB443AACAeQfgCahD/ASABELYCIQEgDEF/NgLcBCAMIAE2AgAgFxCHAQwQC0EB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IAEoAgAoAgARAgAgAi0ABCE6IAIoAgAhMiANQZe3wQBBBRCzASECQZy3wQBBFhCxAiIBIAJFDQQaIAEgASgCACgCABECACACLQAEIRMgAigCACEgIA1BsrfBAEELELMBIQJBvbfBAEEcELECIgEgAkUNBBogASABKAIAKAIAEQIAIAItAAQhLCACKAIAIT0gDUHZt8EAQQsQswEhAkHkt8EAQRwQsQIiASACRQ0EGiABIAEoAgAoAgARAgAgAi0ABCE+IAIoAgAhLSANQYC4wQBBCxCzASECQYu4wQBBHBCxAiIBIAJFDQQaIAEgASgCACgCABECACACLQAEIS4gAigCACE0IA1Bp7jBAEELELMBIQJBsrjBAEEcELECIgEgAkUNBBogASABKAIAKAIAEQIAIAItAAQhJSACKAIAITggDUHOuMEAQQsQswEhAkHZuMEAQRwQsQIiASACRQ0EGiABIAEoAgAoAgARAgAgAi0ABCEqIAIoAgAhKyANQfW4wQBBCxCzASECQYC5wQBBHBCxAiIBIAJFDQQaIAEgASgCACgCABECACACLQAEIRwgAigCACEvQf8BIUFB/wEhJyANQZy5wQBBBRCzASIBBEAgAS0ABCEnIAEoAgAhCQsgDUGhucEAQQUQswEiAQRAIAEtAAQhQSABKAIAIQoLQf8BISlB/wEhQiANQaa5wQBBBRCzASIBBEAgAS0ABCFCIAEoAgAhEQsgDUGrucEAQQUQswEiAQRAIAEtAAQhKSABKAIAIRILQf8BIUNB/wEhRCANQbC5wQBBBRCzASIBBEAgAS0ABCFEIAEoAgAhGAsgH0HwAGohAyANQbW5wQBBBRCzASIBBEAgAS0ABCFDIAEoAgAhGgsgA0G6ucEAQQ8QswEhAkHJucEAQSAQsQIiASACRQ0EGiABIAEoAgAoAgARAgAgAi0ABCE7IAIoAgAhMCADQem5wQBBDxCzASECQfi5wQBBIBCxAiIBIAJFDQQaIAEgASgCACgCABECACACLQAEITEgAigCACE1IANBmLrBAEEMELMBIQJBpLrBAEEdELECIgEgAkUNBBogASABKAIAKAIAEQIAIAItAAQhPCACKAIAITYgA0HBusEAQQwQswEhAUHNusEAQR0QsQIiBSABRQ0EGiAFIAUoAgAoAgARAgAgH0E4aiEUQX8hCyABLQAE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ArwFIgFNDQAgAiABayIFIAAoArQFIAFrSwRAICsgASAFEOcBIAAoArwFIQELIAAoArgFIgQgAUECdGohAyAFQQJPBH8gBUECdEEEayICBEAgA0EAIAL8CwALIAEgBWoiAkEBayEBIAQgAkECdGpBBGsFIAMLQQA2AgAgACABQQFqNgK8BQtBACEIQQAhFkEAIQICQAJAAkACQAJAA0AgACgCgAQgAC0AhAQgACgCxAUgACgCyAUgACgC1AQgAmwgC2oiExCDASFRIAJBA2wiASAAKALoBCIJTw0QIAFBAnQiESAAKALkBGogUTgCACAAKAKIBCAALQCMBCAAKALEBSAAKALIBSATEIMBIVEgAUEBaiIDIAAoAugEIglPBEAgAyEBDBELIANBAnQiDiAAKALkBGogUTgCACAAKAKQBCAALQCUBCAAKALEBSAAKALIBSATEIMBIVEgAUECaiIEIAAoAugEIglPBEAgBCEBDBELIARBAnQiBiAAKALkBGogUTgCACAAKALIBCAALQDMBCAAKALEBSAAKALIBSATEIMBIVEgACgC9AQiBSACTQRAIAIgBUGc08AAEJYCAAsgACgC8AQgAkECdGpDAACAPyBRjBB0QwAAgD+SlTgCACAAKAKwBCAALQC0BCAAKALEBSAAKALIBSATEIMBIVEgASAAKAKABSIJTw0EIAAoAvwEIBFqIFFDu26QPpRDAAAAP5I4AgAgACgCuAQgAC0AvAQgACgCxAUgACgCyAUgExCDASFRIAAoAoAFIgkgA00EQCADIQEMBQsgACgC/AQgDmogUUO7bpA+lEMAAAA/kjgCACAAKALABCAALQDEBCAAKALEBSAAKALIBSATEIMBIVEgACgCgAUiCSAETQRAIAQhAQwFCyAAKAL8BCAGaiBRQ7tukD6UQwAAAD+SOAIAIAAoApgEIAAtAJwEIAAoAsQFIAAoAsgFIBMQgwEhUQJAAkACQAJAAkAgASAAKAKMBSIJTw0AIAAoAogFIBFqIFE4AgAgACgCoAQgAC0ApAQgACgCxAUgACgCyAUgExCDASFRIAAoAowFIgkgAyIBTQ0AIAAoAogFIA5qIFE4AgAgACgCqAQgAC0ArAQgACgCxAUgACgCyAUgExCDASFRIAAoAowFIgkgBCIBTQ0AIAAoAogFIAZqIFE4AgAgACgCeCAALQB8IAAoAsQFIAAoAsgFIBMQgwEhUSAAKAKAASAALQCEASAAKALEBSAAKALIBSATEIMBIVIgACgCiAEgAC0AjAEgACgCxAUgACgCyAUgExCDASFTIAAoApABIAAtAJQBIAAoAsQFIAAoAsgFIBMQgwEhVCACQQJ0IgEgACgCmAUiA0kNAQwCCyABIAlB7NPAABCWAgALIAAoApQFIAFBAnRqIFEgUSBRlCBSIFKUkiBTIFOUkiBUIFSUkpEiUZU4AgAgAUEBciIEIAAoApgFIgNPBEAgBCEBDAELIAAoApQFIARBAnRqIFIgUZU4AgAgAUECciIEIAAoApgFIgNPBEAgBCEBDAELIAAoApQFIARBAnRqIFMgUZU4AgAgAUEDciIBIAAoApgFIgNPDQAgACgClAUgAUECdGogVCBRlTgCACAALQC8AyIBQf8BRw0BDAILIAEgA0Hc08AAEJYCAAsgAC0A/AMhISAAKAL4AyAALQD0AyEjIAAoAvADIAAtAOwDIRUgACgC6AMgAC0A5AMhGCAAKALgAyAALQDcAyEZIAAoAtgDIAAtANQDIREgACgC0AMgAC0AzAMhCSAAKALIAyAALQDEAyEFIAAoAsADIAAoArgDIAEgACgCxAUgACgCyAUgExCDASFRIAJBCWwiASAAKAKkBSIDTw0EIAAoAqAFIAFBAnRqIFE4AgAgBSAAKALEBSAAKALIBSATEIMBIVEgAUEBaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgCSAAKALEBSAAKALIBSATEIMBIVEgAUECaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgESAAKALEBSAAKALIBSATEIMBIVEgAUEDaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgGSAAKALEBSAAKALIBSATEIMBIVEgAUEEaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgGCAAKALEBSAAKALIBSATEIMBIVEgAUEFaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgFSAAKALEBSAAKALIBSATEIMBIVEgAUEGaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgIyAAKALEBSAAKALIBSATEIMBIVEgAUEHaiIEIAAoAqQFIgNPBEAgBCEBDAULIAAoAqAFIARBAnRqIFE4AgAgISAAKALEBSAAKALIBSATEIMBIVEgAUEIaiIBIAAoAqQFIgNPDQQgACgCoAUgAUECdGogUTgCAAsgAC0AxAIiAUH/AUcEQCAALQC0AyEcIAAoArADIAAtAKwDITsgACgCqAMgAC0ApAMhMSAAKAKgAyAALQCcAyE8IAAoApgDIAAtAJQDITcgACgCkAMgAC0AjAMhJyAAKAKIAyAALQCEAyEhIAAoAoADIAAtAPwCISMgACgC+AIgAC0A9AIhFSAAKALwAiAALQDsAiEYIAAoAugCIAAtAOQCIRkgACgC4AIgAC0A3AIhESAAKALYAiAALQDUAiEJIAAoAtACIAAtAMwCIQUgACgCyAIgACgCwAIgASAAKALEBSAAKALIBSATEIMBIVEgAkEPbCIBIAAoArAFIgNPDQMgACgCrAUgAUECdGogUTgCACAFIAAoAsQFIAAoAsgFIBMQgwEhUSABQQFqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAJIAAoAsQFIAAoAsgFIBMQgwEhUSABQQJqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACARIAAoAsQFIAAoAsgFIBMQgwEhUSABQQNqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAZIAAoAsQFIAAoAsgFIBMQgwEhUSABQQRqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAYIAAoAsQFIAAoAsgFIBMQgwEhUSABQQVqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAVIAAoAsQFIAAoAsgFIBMQgwEhUSABQQZqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAjIAAoAsQFIAAoAsgFIBMQgwEhUSABQQdqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAhIAAoAsQFIAAoAsgFIBMQgwEhUSABQQhqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAnIAAoAsQFIAAoAsgFIBMQgwEhUSABQQlqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACA3IAAoAsQFIAAoAsgFIBMQgwEhUSABQQpqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACA8IAAoAsQFIAAoAsgFIBMQgwEhUSABQQtqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAxIAAoAsQFIAAoAsgFIBMQgwEhUSABQQxqIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACA7IAAoAsQFIAAoAsgFIBMQgwEhUSABQQ1qIgQgACgCsAUiA08EQCAEIQEMBAsgACgCrAUgBEECdGogUTgCACAcIAAoAsQFIAAoAsgFIBMQgwEhUSABQQ5qIgEgACgCsAUiA08NAyAAKAKsBSABQQJ0aiBROAIACyAALQCcAUH/AUcEQCAHQegHaiIBID1BqAH8CgAAQQAhAyAIIQUDQCABKAIAIAFBBGotAAAgACgCxAUgACgCyAUgExCDASFRIAMgFmoiBiAAKAK8BSIETw0DIAAoArgFIAVqIFE4AgAgAUEIaiEBIAVBBGohBSADQQFqIgNBFUcNAAsLIAhB1ABqIQggFkEVaiEWIAJBAWoiAiAKSQ0ACyAgIAAoAugEIgFNDQRBACAgIAFBjNPAABChAQALIAYgBEHM08AAEJYCAAsgASADQbzTwAAQlgIACyABIANBrNPAABCWAgALIAEgCUH808AAEJYCAAsgCiAAKAL0BCIBSw0CICAgACgCgAUiAUsNAyAsIAAoApgFIgFLDQQgCkEJbEEAIAAoAtwEIgIbIg4gACgCpAUiAUsNBSAKQQ9sQQAgAkEBSxsiCSAAKAKwBSIBSw0GIApBFWxBACACQQJLGyIWIAAoArwFIgFLDQcgACgC2AQhCCAAKALkBCEGIAAoAvAEIQUgACgC/AQhAyAAKAKUBSEEIAAoAqAFIQIgACgCrAUhASAHIBY2AqQIIAcgCTYCnAggByABNgKYCCAHIA42ApQIIAcgAjYCkAggByAsNgKMCCAHIAQ2AogIIAdCBDcCgAggByAgNgL8ByAHIAM2AvgHIAcgCjYC9AcgByAFNgLwByAHICA2AuwHIAcgBjYC6AcgByAAKAK4BTYCoAggICAAKAKMBSIBSw0IIAAgCCAKIAdB6AdqIAAoAogFICAQMCAAIAAoAtgEIApqIgU2AtgEIAAoAtQEIgEgCmwgC2ohCyAAKALIBSEDIAENAAsLQYzSwAAQ/QIAC0EAIAogAUH80sAAEKEBAAtBACAgIAFB7NLAABChAQALQQAgLCABQdzSwAAQoQEAC0EAIA4gAUHM0sAAEKEBAAtBACAJIAFBvNLAABChAQALQQAgFiABQazSwAAQoQEAC0EAICAgAUGc0sAAEKEBAAtBsOvBAEEoQZzUwAAQ1gIACyABIAlBjNTAABCWAgALIAMgCEkNAUEAIQUgAEEANgLIBQJAIAgEQCADIAhGDQIgC0UNASAAKALEBSIBIAEgCGogC/wKAAAgACALNgLIBQwCCyADIAhGDQELIAAgCzYCyAULIAdBoA5qJAAgBQ8LQQAgCCADQdjGwQAQoQEAC0HojsIAQS5BmI/CABDWAgALQaiPwgBBLkHYj8IAENYCAAusUwMHfRh/E3sjAEEQayIUJAACQAJAAkACQAJAAkACQAJAIARFDQAgABC+ASAAQQA6AFQgAEIANwJMIAJBAnQiFSESIAAoAigiECAVSQRAIBUgEGsiEiAAKAIgIBBrSwRAIABBIGogECASQQRBBBDaASAAKAIoIRALIAAoAiQiFiAQQQJ0aiETIBJBAk8EfyASQQJ0QQRrIhEEQCATQQAgEfwLAAsgECASaiISQQFrIRAgFiASQQJ0akEEawUgEwtBADYCACAQQQFqIRILIAAgEjYCKCAAKAIAQQFHDQACQAJAIBIgFU8EQCAAKAIkIRYgAkUNAkEAIRIgAkEIIAQgBEEITRtBCW4iECACIBBJGyITIAQgBEEBRyIRQX9zakEJbiARaiIRIBEgE0sbIhMgBEECayIRQQAgBCARTxsgBEECSyIRa0EJbiARaiIRIBEgE0sbIhMgBEEDayIRQQAgBCARTxsgBEEDSyIRa0EJbiARaiIRIBEgE0sbIhMgBEEEayIRQQAgBCARTxsgBEEESyIRa0EJbiARaiIRIBEgE0sbIhMgBEEFayIRQQAgBCARTxsgBEEFSyIRa0EJbiARaiIRIBEgE0sbIhMgBEEGayIRQQAgBCARTxsgBEEGSyIRa0EJbiARaiIRIBEgE0sbIhMgBEEHayIRQQAgBCARTxsgBEEHSyIRa0EJbiARaiIRIBEgE0sbIhMgAkEBayIRIBEgE0sbIhMgBEEBa0EJbiIbQQFqIhEgESATSxsiE0EDTQ0BIBNBAWoiEkEDcSIRQQQgERsiGCATQX9zaiERIBIgGGshEv0MAAAAAAEAAAACAAAAAwAAACEvA0AgAyAv/QwJAAAACQAAAAkAAAAJAAAA/bUBIin9DAEAAAABAAAAAQAAAAEAAAD9rgEiLP0bA0ECdGogAyAs/RsCQQJ0aiADICz9GwFBAnRqIAMgLP0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjD94AEiLCADICn9DAIAAAACAAAAAgAAAAIAAAD9rgEiK/0bA0ECdGogAyAr/RsCQQJ0aiADICv9GwFBAnRqIAMgK/0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjH94AEiKP0fACIKICz9HwAiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bIgogAyAp/RsDQQJ0aiADICn9GwJBAnRqIAMgKf0bAUECdGogAyAp/RsAQQJ0av1cAgD9VgIAAf1WAgAC/VYCAAMiMv3gASIq/R8AIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCuAf0TICj9HwEiCiAs/R8BIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKICr9HwEiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bEK4B/SABICj9HwIiCiAs/R8CIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKICr9HwIiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bEK4B/SACICj9HwMiCiAs/R8DIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKICr9HwMiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bEK4B/SAD/Wj9DAAAcEEAAHBBAABwQQAAcEEiM/3kASIsICz9DAAAAAAAAAAAAAAAAAAAAAAiLP1D/U/9DAAA+EEAAPhBAAD4QQAA+EEiN/3qASIr/R8AEJ8C/RMgK/0fARCfAv0gASAr/R8CEJ8C/SACICv9HwMQnwL9IAP9+AEiNP0M8f////H////x////8f///yI4/a4BIiv9GwAQ3AH9EyAr/RsBENwB/SABICv9GwIQ3AH9IAIgK/0bAxDcAf0gA/0MAAB/QwAAf0MAAH9DAAB/QyIr/ecBIi795wEgK/3qASIt/R8AEJ8CIQogLf0fARCfAiEJIC39HwIQnwIhCyAt/R8DEJ8CIQwgFiAvQQL9qwEiLf0bAEECdGoiEyAqIC795wEgK/3qASIq/R8AEJ8C/RMgKv0fARCfAv0gASAq/R8CEJ8C/SACICr9HwMQnwL9IAP9+QEgNEEb/asBIDIgLP1D/QwAAAABAAAAAQAAAAEAAAABIjL9Tv1QIDAgLP1D/QwAAAACAAAAAgAAAAIAAAACIjD9Tv1QIDEgLP1D/QwAAAAEAAAABAAAAAQAAAAEIjH9Tv1Q/VAgCv0TIAn9IAEgC/0gAiAM/SAD/fkBQQj9qwH9UCAoIC795wEgK/3qASIo/R8AEJ8C/RMgKP0fARCfAv0gASAo/R8CEJ8C/SACICj9HwMQnwL9IAP9+QFBEP2rAf1QIij9WgIAACAWIC39GwFBAnRqIhggKP1aAgABIBYgLf0bAkECdGoiFyAo/VoCAAIgFiAt/RsDQQJ0aiIcICj9WgIAAyADICn9DAQAAAAEAAAABAAAAAQAAAAiNP2uASIo/RsDQQJ0aiADICj9GwJBAnRqIAMgKP0bAUECdGogAyAo/RsAQQJ0av1cAgD9VgIAAf1WAgAC/VYCAAMiNf3gASIoIAMgKf0MBQAAAAUAAAAFAAAABQAAAP2uASIq/RsDQQJ0aiADICr9GwJBAnRqIAMgKv0bAUECdGogAyAq/RsAQQJ0av1cAgD9VgIAAf1WAgAC/VYCAAMiNv3gASIq/R8AIgogKP0fACIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiADICn9DAMAAAADAAAAAwAAAAMAAAD9rgEiLf0bA0ECdGogAyAt/RsCQQJ0aiADIC39GwFBAnRqIAMgLf0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjn94AEiLf0fACIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsQrgH9EyAq/R8BIgogKP0fASIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAt/R8BIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCuAf0gASAq/R8CIgogKP0fAiIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAt/R8CIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCuAf0gAiAq/R8DIgogKP0fAyIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAt/R8DIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCuAf0gA/1oIDP95AEiKCAoICz9Q/1PIDf96gEiKP0fABCfAv0TICj9HwEQnwL9IAEgKP0fAhCfAv0gAiAo/R8DEJ8C/SAD/fgBIjogOP2uASIo/RsAENwB/RMgKP0bARDcAf0gASAo/RsCENwB/SACICj9GwMQ3AH9IAMgK/3nASIu/ecBICv96gEiKP0fABCfAiEKICj9HwEQnwIhCSAo/R8CEJ8CIQsgKP0fAxCfAiEMIBMgLSAu/ecBICv96gEiKP0fABCfAv0TICj9HwEQnwL9IAEgKP0fAhCfAv0gAiAo/R8DEJ8C/SAD/fkBIDpBG/2rASA5ICz9QyAy/U79UCA1ICz9QyAw/U79UCA2ICz9QyAx/U79UP1QIAr9EyAJ/SABIAv9IAIgDP0gA/35AUEI/asB/VAgKiAu/ecBICv96gEiKP0fABCfAv0TICj9HwEQnwL9IAEgKP0fAhCfAv0gAiAo/R8DEJ8C/SAD/fkBQRD9qwH9UCIo/VoCBAAgGCAo/VoCBAEgFyAo/VoCBAIgHCAo/VoCBAMgAyAp/QwHAAAABwAAAAcAAAAHAAAA/a4BIij9GwNBAnRqIAMgKP0bAkECdGogAyAo/RsBQQJ0aiADICj9GwBBAnRq/VwCAP1WAgAB/VYCAAL9VgIAAyIu/eABIiggAyAp/QwIAAAACAAAAAgAAAAIAAAA/a4BIir9GwNBAnRqIAMgKv0bAkECdGogAyAq/RsBQQJ0aiADICr9GwBBAnRq/VwCAP1WAgAB/VYCAAL9VgIAAyI1/eABIir9HwAiCiAo/R8AIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKIAMgKf0MBgAAAAYAAAAGAAAABgAAAP2uASIp/RsDQQJ0aiADICn9GwJBAnRqIAMgKf0bAUECdGogAyAp/RsAQQJ0av1cAgD9VgIAAf1WAgAC/VYCAAMiNv3gASIp/R8AIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCuAf0TICr9HwEiCiAo/R8BIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKICn9HwEiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bEK4B/SABICr9HwIiCiAo/R8CIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKICn9HwIiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bEK4B/SACICr9HwMiCiAo/R8DIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKICn9HwMiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bEK4B/SAD/WggM/3kASIoICggLP1D/U8gN/3qASIo/R8AEJ8C/RMgKP0fARCfAv0gASAo/R8CEJ8C/SACICj9HwMQnwL9IAP9+AEiMyA4/a4BIij9GwAQ3AH9EyAo/RsBENwB/SABICj9GwIQ3AH9IAIgKP0bAxDcAf0gAyAr/ecBIi395wEgK/3qASIo/R8AEJ8CIQogKP0fARCfAiEJICj9HwIQnwIhCyAo/R8DEJ8CIQwgEyApIC395wEgK/3qASIp/R8AEJ8C/RMgKf0fARCfAv0gASAp/R8CEJ8C/SACICn9HwMQnwL9IAP9+QEgM0Eb/asBIDYgLP1DIDL9Tv1QIC4gLP1DIDD9Tv1QIDUgLP1DIDH9Tv1Q/VAgCv0TIAn9IAEgC/0gAiAM/SAD/fkBQQj9qwH9UCAqIC395wEgK/3qASIp/R8AEJ8C/RMgKf0fARCfAv0gASAp/R8CEJ8C/SACICn9HwMQnwL9IAP9+QFBEP2rAf1QIin9WgIIACAYICn9WgIIASAXICn9WgIIAiAcICn9WgIIAyAvIDT9rgEhLyARQQRqIhENAAsMAQtBACAVIBJB5OXAABChAQALIAIgEmshESAQIBJrIRggEkEJbEEIaiEQIAMgEkEkbGohAyAbIBJrQQFqIRMgFiASQQR0aiESAn8CQAJAAn8CQAJAAkADQAJAAkAgEwRAIBBBB2sgBE8NASAQQQZrIhcgBEkNAiAXIRAMBAsgEEEIawwJCyAQQQdrDAULQwAAf0MgA0EEaioCACINiyIJQwAA+EFDAAAAACADQQhqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgAyoCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIhdBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBJDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAXQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBBBBWsgBE8NBiAQQQRrIARPDQMgBCAQQQNrSwRAQwAAf0MgA0EQaioCACINiyIJQwAA+EFDAAAAACADQRRqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EMaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIhdBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBJBBGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAXQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBBBAmsgBE8NBiAQQQFrIARPDQMgGEUNAkMAAH9DIANBHGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EgaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBGGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bEK4BjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQnwL8ACIXQQ9rENwBQwAAf0OVIgmVIgwgDEMAAH9DXhsQnwIhDCASQQhqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJ8C/AEgF0EbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCfAvwBQRB0cjYCACAQQQlqIRAgA0EkaiEDIBNBAWshEyAYQQFrIRggEkEQaiESIBFBAWsiEQ0BDAkLCyAQQQNrIRALIBAgBEHU5cAAEJYCAAsgEEEBawwBCyAQQQRrCyAEQcTlwAAQlgIACyAQQQJrDAELIBBBBWsLIARBtOXAABCWAgALIBQgACgCBCABQQJ0IAEgAmpBAnQQzQIiAxCnAyIENgIIIBQgFTYCDCAEIBVHDQcgAyAWIBUQhwMgA0GECEkNACADEIACCyAGRQ0FIAAQvgEgAEEAOgBUIABCADcCTCAAIAIQmQEgACgCAEEBRw0FIAAoAghBAUcNBSACQQJ0IhYgACgCKCIRSw0AIBYgACgCNCIYSw0BIAAoAiQhHCAAKAIwIR4gFCAAKAIEIiIgAUECdCIdIAEgAmpBAnQiHxDNAiIDEKcDIgQ2AgggFCAWNgIMIAQgFkcNBiAcIBYgAxCIAyADQYQITwRAIAMQgAILAkACQAJAAkACfwJAAkACQAJAAn8CQAJAAkACQAJ/AkACQAJAAkAgAgRAIBxBDGohIyAGQQNrIQQgAkE8bCIXQQ9rISQgF0EeayElIBdBLWshJiAGQQFrQQ9uQQJ0QQRqISdBACETQQAhEkEAIRVBACEQA0AgBEEBaiIbQQNuIARBAmoiGkEDbiAVICdGDRcgEkEBaiIDIAZPDRggEkECaiIDIAZPDRlDAAB/QyAFIBBqIgNBBGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EIaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIAMqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bEK4BjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQnwL8ACIhQQ9rENwBQwAAf0OVIgmVIgwgDEMAAH9DXhsQnwIhDCATICNqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJ8C/AEgIUEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCfAvwBQRB0cjYCACAaQQNJDQIgG0EDSQ0HIARBA0kNDCAQIBdGDRRDAAB/QyADQRBqKgIAIg2LIglDAAD4QUMAAAAAIANBFGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADQQxqKgIAIg+LIgsgCyALXBsiDCAMIAkgCSAJXBsiCSAJIAxdGxCuAY5DAABwQZIiCSAJQwAAAABdGyIJIAlDAAD4QV4bEJ8C/AAiGkEPaxDcAUMAAH9DlSIJlSIMIAxDAAB/Q14bEJ8CIQwgEyAeaiIbQwAAf0MgCyAJlSILIAtDAAB/Q14bEJ8C/AEgGkEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCfAvwBQRB0cjYCAEEBaiIaQQJGDQNBAWoiIEECRg0IIARBA25BAWoiGUECRg0NIBAgJEYNEkMAAH9DIANBHGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EgaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBGGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bEK4BjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQnwL8ACIhQQ9rENwBQwAAf0OVIgmVIgwgDEMAAH9DXhsQnwIhDCAbQQRqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJ8C/AEgIUEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCfAvwBQRB0cjYCACAaQQNGDQQgIEEDRg0JIBlBA0YNDiAQICVGDRNDAAB/QyADQShqKgIAIg2LIglDAAD4QUMAAAAAIANBLGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADQSRqKgIAIg+LIgsgCyALXBsiDCAMIAkgCSAJXBsiCSAJIAxdGxCuAY5DAABwQZIiCSAJQwAAAABdGyIJIAlDAAD4QV4bEJ8C/AAiIUEPaxDcAUMAAH9DlSIJlSIMIAxDAAB/Q14bEJ8CIQwgG0EIakMAAH9DIAsgCZUiCyALQwAAf0NeGxCfAvwBICFBG3RBgICACEEAIA9DAAAAAF0bckGAgIAQQQAgDUMAAAAAXRtyQYCAgCBBACAOQwAAAABdG3JyIAz8AUEIdHJDAAB/QyAKIAmVIgogCkMAAH9DXhsQnwL8AUEQdHI2AgAgGkEERg0FICBBBEYNCiAZQQRGDQ8gECAmRg0RQwAAf0MgA0E0aioCACINiyIJQwAA+EFDAAAAACADQThqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EwaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIgNBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBtBDGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASADQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBNBEGohEyASQQ9qIRIgFUEEaiEVIARBD2shBCAXIBBBPGoiEEcNAAsLIBQgIiAdIB8QzQIiAxCnAyIENgIIIBQgETYCDCAEIBFHDRkgAyAcIBEQhwMgA0GECE8EQCADEIACCyAUIAAoAgwgHSAfEM0CIgMQpwMiBDYCCCAUIBg2AgwgBCAYRw0ZIAMgHiAYEIcDIANBhAhJDRggAxCAAgwYCyASQQNqDAMLIBJBBmoMAgsgEkEJagwBCyASQQxqCyAGQbTmwAAQlgIACyASQQRqDAMLIBJBB2oMAgsgEkEKagwBCyASQQ1qCyAGQcTmwAAQlgIACyASQQVqDAMLIBJBCGoMAgsgEkELagwBCyASQQ5qCyAGQdTmwAAQlgIACyAVQQNqIRUMAgsgFUEBaiEVDAELIBVBAmohFQsgFSAWQeTmwAAQlgIAC0EAIBYgEUH05sAAEKEBAAtBACAWIBhB9OXAABChAQALIBIgBkGE5sAAEJYCAAsgAyAGQZTmwAAQlgIACyADIAZBpObAABCWAgALAkAgCEUNACAAEL4BIABBADoAVCAAQgA3AkwgACACEJkBIAAoAhBBAUcNACAAKAIYQQFHDQACQAJAAn8CQAJAAkACfwJAAkACQAJAAkACQCACQQJ0IgUgACgCKCIGTQRAIAUgACgCNCIWSw0NIAAoAiQhGCAAKAIwIRcgAkUNDCACQdQAbCEcIAhBDGshBCAIQQFrQRVuQQJ0QQRqIRtBACETQRQhEEEAIRVBACESA0AgBEEDbiAEQQFqIh1BA24gBEECaiIaQQNuAkACfwJAAkACQAJ/AkACQAJAAn8CQAJAIBUgG0cEQCAQQRNrIAhPDQEgEEESayIDIAhJDQIgAwwDCyAQQRRrDAoLIBBBE2sMBQtDAAB/QyAHIBJqIgNBBGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EIaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIAMqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bEK4BjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQnwL8ACIZQQ9rENwBQwAAf0OVIgmVIgwgDEMAAH9DXhsQnwIhDCATIBhqIhFDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAZQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBBBEWsgCE8NByAQQRBrIAhPDQMgCCAQQQ9rSwRAQwAAf0MgA0EQaioCACINiyIJQwAA+EFDAAAAACADQRRqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EMaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIhlBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBFBBGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAZQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBBBDmsgCE8NByAQQQ1rIAhPDQMgCCAQQQxrSwRAQwAAf0MgA0EcaioCACINiyIJQwAA+EFDAAAAACADQSBqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EYaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIhlBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBFBCGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAZQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBBBC2sgCE8NByAQQQprIAhPDQMgCCAQQQlrSwRAQwAAf0MgA0EoaioCACINiyIJQwAA+EFDAAAAACADQSxqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EkaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIhlBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBFBDGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAZQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBpBA0kNGCAdQQNJDRQgBEEDSQ0QIBIgHEcNDCAVIAVBxOfAABCWAgALIBBBCWsMAgsgEEEMawwBCyAQQQ9rCyAIQfTnwAAQlgIACyAQQQprDAILIBBBDWsMAQsgEEEQawsgCEHk58AAEJYCAAsgEEELawwCCyAQQQ5rDAELIBBBEWsLIAhB1OfAABCWAgALQwAAf0MgA0E0aioCACINiyIJQwAA+EFDAAAAACADQThqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EwaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIh1BD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBMgF2oiEUMAAH9DIAsgCZUiCyALQwAAf0NeGxCfAvwBIB1BG3RBgICACEEAIA9DAAAAAF0bckGAgIAQQQAgDUMAAAAAXRtyQYCAgCBBACAOQwAAAABdG3JyIAz8AUEIdHJDAAB/QyAKIAmVIgogCkMAAH9DXhsQnwL8AUEQdHI2AgBBBGoiHUEFRg0KQQRqIh9BBUYNBkEEaiIeQQVGDQJDAAB/QyADQUBrKgIAIg2LIglDAAD4QUMAAAAAIANBxABqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0E8aioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIhpBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBFBBGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASAaQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIB1BBkYNCSAfQQZGDQUgHkEGRg0EQwAAf0MgA0HMAGoqAgAiDYsiCUMAAPhBQwAAAAAgA0HQAGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADQcgAaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQrgGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCfAvwAIgNBD2sQ3AFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCfAiEMIBFBCGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQnwL8ASADQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJ8C/AFBEHRyNgIAIBNBEGohEyAQQRVqIRAgFUEEaiEVIARBFWshBCAcIBJB1ABqIhJHDQALDAwLQQAgBSAGQYTowAAQoQEACyAQQQNrIRAMAQsgEEEGayEQCyAQIAhBtOfAABCWAgALIBBBAWsMAgsgEEEEawwBCyAQQQdrCyAIQaTnwAAQlgIACyAQQQJrDAILIBBBBWsMAQsgEEEIawsgCEGU58AAEJYCAAsgFCAAKAIUIAFBAnQiAyABIAJqQQJ0IgIQzQIiARCnAyIENgIIIBQgBjYCDAJAIAQgBkYEQCABIBggBhCHAyABQYQITwRAIAEQgAILIBQgACgCHCADIAIQzQIiABCnAyIBNgIIIBQgFjYCDCABIBZHDQEgACAXIBYQhwMgAEGECEkNAyAAEIACDAMLDAMLDAILQQAgBSAWQYTnwAAQoQEACyAUQRBqJAAPCyAUQQhqIBRBDGoQrAIAC/PrAQNDfxd+AnsjAEHwBmsiCyQAAkACQAJAAkACQCAALQDiUyIFDQAgAEGcAWohCAJAAkAgAkEEIAAoAqQBIgRrIgMgAiADSRsiAyAAKAKcASAEa0sEQCAIIAQgA0EBQQEQ2gEgACgCpAEhBAwBCyADRQ0BCyADRQ0AIAAoAqABIARqIAEgA/wKAAALIAAgAyAEaiIFNgKkASAFQQRJBEBBACEDDAMLIAEgA2ohASACIANrIQIgCyAAKAKgASgAACIDNgJgIANBzo7NggVGBEBBAiEFIABBAjoA4lMMAQsgA0H///8HcUGfliJHDQFBASEFIABBAToA4lMgCCgCCCEDIABBADYCpAEgCCkCACFGIABCgICAgBA3ApwBIAsgAzYCuAMgCyBGNwOwAyAAKAKEASIDBEAgACgCiAEiBUEEaygCACIEQXhxIghBBEEIIARBA3EiBBsgA2pJDQQgBEEAIAggA0EnaksbDQUgBRBBIAAtAOJTIQULIABBhAFqIgMgCygCuAM2AgggAyALKQOwAzcCAAsCQAJAAkAgBUH/AXFBAWsOAgECAAtBsOvBAEEoQcTowAAQ1gIACwJAAkAgACgChAEgACgCjAEiBWsgAkkEQCAAQYQBaiAFIAJBAUEBENoBIAAoAowBIQUMAQsgAkUNAQsgAkUNACAAKAKIASAFaiABIAL8CgAACyAAIAIgBWo2AowBIAAQLyEDDAILQeiBwgApAwAiUEL/AYMhUSALQbwDaq1CgICAgNAChCFXIAtB1AZqrUKAgICA0AKEIVUgC0HQAGqtQoCAgIDQAoQhViALQagGaq1CgICAgNAChCFSIAtBxABqrSJGQoCAgICAA4QhWCBGQoCAgIDQAoQhWSALQThqrUKAgICA0AKEIVogC0HEA2qtQoCAgIDQAoQhWyALQeQAaiExIAtBtANqITIgC0HYA2ohMyALQTBqITQgAEGcAWohOyAAQagBaiE1A0ADQCAAKAJgIQMgAEEENgJgIAAoAnQhJiAAKAJwIR0gACgCbCEgIAAoAmghBiAAKAJkISUCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgA0EBaw4EAQIDEwALAkAgACgCpAFBIE8EQCALIAAoAqABIgMoAAAiBTYCRCAFQc6OzYIFRwRAIAsgWDcDUCALQeAAaiIAQZPGwQAgC0HQAGoQ/wEgABC2AiEDDB0LIAsgAy0ADiIFOgC1BiALIAMtAA0iCjoAtAYgCyADLQAMIgg2ArAGIAsgAygACCIJNgKsBiALIAMoAAQiBDYCqAYgBEEERw0FAkAgBUECcUUNAEHQtcIAKQMAIkhQBEBB2LXCACkDACFGA0AgRkJ/UQ0JQdi1wgAgRkIBfCJIQdi1wgApAwAiRyBGIEdRIgUbNwMAIEchRiAFRQ0AC0HQtcIAIEg3AwALQfC1wgACf0HotcIAKQMAIEhSBEBB9LXCAC0AACEFQfS1wgBBAToAACALIAU6AGAgBQ0KQei1wgAgSDcDAEEBDAELQfC1wgAoAgAiBUF/Rg0KIAVBAWoLIgU2AgBB+LXCACgCAA0KQfC1wgAgBUEBayIFNgIAIAUNAEHotcIAQgA3AwBB9LXCAEEAOgAACyADLQAPIQUgCyADKAAQIgM2AlAgA0EgSQ0KIAMgBUEEdGoiBCADTw0BQdjFwQBBExCxAiEDDBwLIABBADYCYAwTCyALIAQ2AsQDIAsgBTYCvAMgCyAINgK4AyALIAk2ArQDIAtBBDYCsAMgCyA2QYB+cSAKciI2NgLIAyALIAM2AsADIAAoAlhBAUYEQCALIAAoAlwiCjYCqAYgBCAKSw0KCyAAQQA2AqQBIAAoAmBBA0YEQCAAKAJsIgoEQCAAKAJwIg9BBGsoAgAiDEF4cSIOIApBA3QiCkEEQQggDEEDcSIMG2pJDR0gDEEAIA4gCkEnaksbDR4gDxBBCyAAKAJoED4LIAAgA0EgayIKIDwgChsiPDYCgAEgACA2NgJ8IAAgBDYCeCAAIAM2AnQgACAFNgJwIAAgCDYCbCAAIAk2AmggAEEENgJkIABBAUECIAobNgJgDBcLIAAoAoABRQ0VIABBATYCYAwRCyAAKQJ4IUYgCyAdNgK8AyALICA2ArgDIAsgBjYCtAMgCyAlNgKwAyALICY2AsADIAsgRjcCxAMgACgCpAEiDCBGpyIFICZrTwRAIAAoAqABIRBBFBAgIgNFDQkCQAJAIAatIkhCCX4iR0IgiFAEQCADIAY2AgQgAyBHPgIAIAMgBkECdDYCECADIAZBA2wiBDYCDCADIAQ2AgggC0EFNgJoIAsgAzYCZCALQQU2AmAgIEEBayIEQQNPBEBBBSEPQQUhBAwDCyBIIARBAnQ1AuibQn4iSEIgiFANAQtB6LPBAEEaELECIANBFEEEEIMCIQMMGwsjAEEQayIDJAAgA0EEaiALQeAAaiIEKAIAIgggBCgCBEEEIAhBAXQiCCAIQQRNGyIIQQQQ2QEgAygCBEEBRgRAIAMoAgggAygCDBDPAgALIAMoAgghCSAEIAg2AgAgBCAJNgIEIANBEGokACALKAJkIgMgSD4CFEEGIQQgCygCYCIPQX9GDRoLAkACQCAEIB1GBEAgHUEDdCIEECAiFw0BQQQgBBDPAgALIAsgBDYC1AYgCyBXNwNoIAsgVTcDYCALQcgGaiIAQb2EwAAgC0HgAGoQ/wEgABC2AiEAIA8NASAAIQMMGwsgRkIgiKchEUEAIQ4gC0EANgLcBiALIBc2AtgGQQQhCiAMQQR2IRMgCyAdNgLUBiAdQQJ0IRVBCCEIQQAhBANAIAMgDmooAgAhGyALIAQ2AjggCyAbNgJEIAhBCGshCSAIIAxLBEAgCSAIIAxByMXBABChAQALIAggEGoiDUEIaykAACJGQv////8PVg0MIAQgE0YNDSANKQAAIkhC/////w9WDQ4gCyBIpyIJNgJQIAkgG0cNDyALKALUBiAERgRAIwBBEGsiCSQAIAlBBGogC0HUBmoiDSgCACIUIA0oAgRBBCAUQQF0IhQgFEEETRsiFEEIENkBIAkoAgRBAUYEQCAJKAIIIAkoAgwQzwIACyAJKAIIIQcgDSAUNgIAIA0gBzYCBCAJQRBqJAAgCygC2AYhFwsgCiAXaiIJIBs2AgAgCUEEayBGpyIJNgIAIAsgBEEBaiIENgLcBiAFIAUgCWoiCU0EQCAIQRBqIQggCkEIaiEKIAkhBSAVIA5BBGoiDkYNEwwBCwtB6MTBAEEZELECIQUMEAsgAyAPQQJ0QQQQgwIgACEDDBkLIABBAjYCYAwQCyAlICZJDQwgJSAmQbjewAAQlgIACyALIFI3A2AgC0HIBmoiAEH9kcAAIAtB4ABqEP8BIAAQtgIhAwwWC0H4ksIAQe8AQbCTwgAQpAIACyALQeAAahCtAgALQcSQwgBBJkHskMIAEKUCAAtBuJnCABCyAgALIAtC7MXBgNACNwNoIAsgVjcDYCALQdQGaiIAQdeKwAAgC0HgAGoQ/wEgABC2AiEDDBELIAsgUjcDaCALIFs3A2AgC0EUaiIAQZSJwAAgC0HgAGoQ/wEgABC1AiEDDBALEIsDAAtBtMXBAEETELECIQUMBAsgCCAJQRBqIAxBpMXBABChAQALQYHFwQBBIBCxAiEFDAILIAsgVjcDcCALIFk3A2ggCyBaNwNgIAtBqAZqIgBBloXAACALQeAAahD/ASAAELYCIQUMAQsgHSAlQQN0aiIDKAIAISggAygCBCEhIAsgJTYCNCALICE2AjAgCyAoNgIsAn8CQAJAAkACQAJAAkACQAJAAkACfgJAAkACQAJAAkAgACgCtAFBf0cEQCAAKALEASIDRQ0BICEgA24hGyAGKAKIAyE3IAYtAJADDQggKCA3RyAAKAKkASIEQRFNcQ0JIARBA00EQEIAQeiBwgApAwAiRiBGQv8Bg0L/AVEiABshUAwQCwJAIAAoAqABIgkoAAAiA0FwcUHQ1LTCAUcEQCADQajqvmlGDQEgA60hUEEBIQAMEQsgBEEITwRAIAkoAAQhAAwQCyADIQBB6IHCACkDACJQQv8Bg0L/AVEND0ECIQAMEAsCQCAEQQRGBEAgUUL/AVENAUECIQAMEQsgBEEFayEFQQUhDyAJQQVqIRcgCS0ABCIIQSBxIg4EQEEAIQMMBAsgBQRAIARBBmshBUEGIQ8gCUEGaiEXIAktAAUhAwwECyBRQv8BUgRAQQQhAAwRC0EGIQ9BACEFIAghAwwDCyALQgA3A7ADQQUhD0EoIQhBACEDDAMLQfjewAAQ+wIAC0GI38AAEP0CAAsCQAJAAn8CQAJAAkACQAJAIAhBA3EiCkEBaw4DAgEABwtBBCEKCyAFIApJDQEgBSAKawwDCyAFDQFBASEKCyBRQv8BUQRAIAUgF2ohF0EAIQUMAwtBBSEADBALQQEhCiAFQQFrCyEFIAogF2ohFwsgCiAPaiEPC0EBIQxBAiEKAkACQAJAAkACQCAIQQZ2QQFrDgMDAgABC0EAIQxBCCEKDAILQgAhRiAORQ0HIAtCADcDsAMgBQ0CQQEhCkEAIQwMBAtBACEMQQQhCgsgC0IANwOwAyAFIApJDQIgCgRAIAtBsANqIBcgCvwKAAALIAsxALADIUYMAwsgCyAXLQAAOgCwAwsgD0EBaiEPIAsxALADIUYMAwsgUUL/AVIEQEEGIQAMCwsgCzEAsAMiRiAKQQFGDQEaCyALMQCxA0IIhiBGhCJGIApBAkYNABogCzEAsgNCEIYgCzEAswNCGIaEIEaEIkYgCkEERg0AGiALMQC0A0IghiALMQC1A0IohoQgCzEAtgNCMIaEIAsxALcDQjiGhCBGhAshRiAKIA9qIQ8gDEUNACBGQoACfCFGCwJAIAhBIHENACADrUIHg0IBIANB+AFxQQN2QQpqrYYiRkIDiH4gRnwiRkKAgICAgPgAVA0AIAtCgICAgID4ADcDuAMgC0EAOgCwAyALIAtBsANqrUKAgICA8AOENwPoBiALQeAAaiIAQbSYwAAgC0HoBmoQiAEgABC2AgwJCyALIEY3A+AGIEZCgYCAMloEQCALIAtB4AZqrUKAgICAwACENwOwAyALQagGaiIAQZPAwAAgC0GwA2oQ/wEgABC2AgwJCyAGIAhBAnZBAXE6AJEDAkAgBCAPTwRAIAsgDzYC7AYgCyAJNgLoBgJAIAYoAgBBAkcEQCALQbADaiALQegGahA2IAspA7gDIUcgCygCtAMhCgJAIAsoArADIgRBAkYEQCBHQoB+gyFIQQAhDAwBCyALMQDIAyFKIEchRgJ+AkAgCykDwAMiSEIgg0IAUg0AQgEgSEIIiCJGp0H4AXFBA3ZBCmqthiJJQgOIIEZCB4N+IEl8IkZC///////3AFgNAEEBIQxCACFIQgAMAQsgRkKBgIAyVA0DIEZCgH6DIUhBAiEMIEYLIUcLIEggR0L/AYOEIUYMCQsgC0GoBmogC0HoBmoQNiALKQOwBiFGIAsoAqwGIQogCygCqAYiBEECRgRAQQAhDAwJCyALMQDABiFKIEYhSAJAIAspA7gGIkdCIINCAFINAEIBIEdCCIgiSKdB+AFxQQN2QQpqrYYiSUIDiCBIQgeDfiBJfCJIQoCAgICA+ABUDQAgC0EAOgDAA0EBIQwgCykDwAMhRgwJCyAzIEinEGcgC0EANgLQAyALQQA2AsgDIAsgRzcDwAMgCyBGNwO4AyALIAo2ArQDIAsgBDYCsAMgC0EAOgCkBiALQQA2AqAGIAsgSjcDmAYgC/0AA8gDIV0gC0HgAGoiAyAzQdAC/AoAACAGEGogBiBd/QsDGCAGIEc3AxAgBiBGNwMIIAYgCjYCBCAGIAQ2AgAgBkEoaiADQdAC/AoAAAwCCyAGQQA6APQCIAYgSDcDECAGIEc3AwggBiAKNgIEIAYgBDYCACAGQQA2AvACIAb9DAAAAAABAAAABAAAAAgAAAD9CwPYAiAGQQA2AswCIAZBADYCwAIgBkIANwOYAiAGIEanIgM2AqgCIAYoApQCIgUgBUEAR2siBSADSQRAIAZBkAJqIAMgBWsQiwEgBigCBCEKIAYoAgAhBAsgBkIANwOgAiAGQQA2ArQCIAZBADYC2AEgBkEANgLMASAGQQA2AoACIAZBADoA3QEgBkEANgLAASAGQQA2AvQBIAZBADoAhQIgBkEANgLoASAGQQA2ArABIAZBADYCpAEgBkEAOgCMAiAGQQA6AIoCIAZBADoAtQEgBkEANgKYASAGQQA6AIgCIAZBADoAjAEgBkEANgI8IAZBADYCMCAGQQA2AoQBIAZBADYCYCAGQQA2AlQgBkEANgJIIAZBADYCeCAGQQA2AmwgBiBKNwPoAiAGQQA6AIkBIAZBADYCGCAGQQA2AiAMAQtBACAPIARBmN/AABChAQALIARBAXEEQEEMIQwgBigC+AIiA0UNBiAGKAL8AiEXA0AgA0EEaiEIIAMvAd4WIglBAnQhBEF/IQUCQAJAA0AgBEUEQCAJIQUMAgsgCCgCACEOIARBBGshBCAFQQFqIQUgCEEEaiEIIAogDksgCiAOSWtB/wFxIg5BAUYNAAsgDkUNAQsgF0UNCCAXQQFrIRcgAyAFQQJ0aigC4BYhAwwBCwsgC0EMNgKwAyALIAo2ArQDIAtBsANqEC4gBkEoaiADIAVBhAJsakEwahBaIAYgCjYCJCAGQQE2AiALIAAoAqQBIgMgD0kNBCAAQQA2AqQBIAMgD0cEQCADIA9rIgMEQCAAKAKgASIFIAUgD2ogA/wKAAALIAAgAzYCpAELIAZBAToAkAMLIBtBEHQhKSAGQYwDaiEiA0ACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACfwJAAkAgACgC3FMiAwRAIAAoArABIgUgA0kNASAFIANrIgUEQCAAKAKsASIEIAMgBGogBfwKAAALIABBADYC3FMgACAFNgKwAQsgBigCAEECRg0EIAYtAPQCIQkCQCAGLQAQQQRxIgoEQCAJQQFxRQ0DIAYoAhgNAQwDCyAJQQFxRQ0CCyAGKAKUAiIDIAYoApwCIgggCCAGKAKYAiIFSSIEGyAFayAIQQAgBBtqDAILIAMgBSAFQZjUwQAQoQEAC0EAIRcgBigCqAIiBCAGKAKUAiIDIAYoApwCIgggCCAGKAKYAiIFSSIPGyIMIAVrIAhBACAPGyIPak8NASAMIA9qIAQgBWprC0EAIRdFDQAgKSAAKAKwASIEayIPQQAgDyApTRsiDyAhICIoAgBrIgxBACAMICFNG0EBaiIMQX8gDBsiDAJ/AkACQCAKBEAgCUEBcUUNAiAGKAIYDQEMAgsgCUEBcUUNAQsgAyAIIAUgCEsiAxsgBWsgCEEAIAMbagwBCyADIAggBSAISyIDGyIJIAhBACADGyIDaiAFIAYoAqgCIghqa0EAIAkgBWsgA2ogCEsbCyIDIAMgDEsbIgMgAyAPSxsiA0UNACAEIAMgBGoiCEkEQCAAKAKoASAEIghrIANJBEAgNSAEIANBAUEBENoBIAAoArABIQgLIAAoAqwBIgkgCGohBSADQQFHBH8gA0EBayIDBEAgBUEAIAP8CwALIAkgAyAIaiIIagUgBQtBADoAACAIQQFqIQgLIAAgCDYCsAECQAJAAkAgBCAISw0AIAtB4ABqIAYgACgCrAEgBGogCCAEaxBmIAstAGBB/wFHDQIgCygCZCIFIARqIgMgACgCsAEiBE0EQCAAIAM2ArABIAMhBAsgBUUNAyAiICIoAgAgBWoiAzYCACADICFLDQEgBCApRyEEA0ACQAJAIARFBEAgAEEANgLcUyAAEB0gAEEANgLcUyAAQQA2ArABDAELIAYoAgBBAkYNByAGLQD0AiEDAn8CQAJAIAYtABBBBHEiCQRAIANBAXFFDQEgBigCGA0CDAELIANBAXENAQsgBigCqAIiBCAGKAKUAiIMIAYoApwCIgggCCAGKAKYAiIFSSIKGyIPIAVrIAhBACAKGyIKakkEQCAKIA9qIAQgBWprDAILQQEhFwwICyAGKAKUAiIMIAYoApwCIgggCCAGKAKYAiIFSSIEGyAFayAIQQAgBBtqC0EBIRdFDQYgKSAAKAKwASIEayIKQQAgCiApTRsiCiAhICIoAgBrIg9BACAPICFNG0EBaiIPQX8gDxsiDwJ/AkACQCAJBEAgA0EBcUUNASAGKAIYDQIMAQsgA0EBcQ0BCyAMIAggBSAISyIDGyIJIAhBACADGyIDaiAFIAYoAqgCIghqa0EAIAkgBWsgA2ogCEsbDAELIAwgCCAFIAhLIgMbIAVrIAhBACADG2oLIgMgAyAPSxsiAyADIApLGyIDRQ0GIAQgAyAEaiIISQRAIAAoAqgBIAQiCGsgA0kEQCA1IAQgA0EBQQEQ2gEgACgCsAEhCAsgACgCrAEiCSAIaiEFIANBAUcEfyADQQFrIgMEQCAFQQAgA/wLAAsgCSADIAhqIghqBSAFC0EAOgAAIAhBAWohCAsgACAINgKwASAEIAhLDQMgC0HgAGogBiAAKAKsASAEaiAIIARrEGYgCy0AYEH/AUcNBSALKAJkIgUgBGoiAyAAKAKwASIETQRAIAAgAzYCsAEgAyEECyAFRQ0GICIgIigCACAFaiIDNgIAIAMgIUsNBCAEIClGDQELQQEhBAwBC0EAIQQMAAsACyAEIAggCEGo38AAEKEBAAsgCyAirUKAgICA0AKENwO4AyALIDStQoCAgIDQAoQ3A7ADIAtBOGoiAEHBgsAAIAtBsANqEIgBIAAQtQIMGAsgCyALKQNgNwOwAwJ/IwBBIGsiACQAIAAgC0GwA2oiAa1CgICAgMABhDcDGCAAQQxqIgJB5pjAACAAQRhqEIgBIAIQtQIhBQJAIAEtAABBA0YEQCABKAIEIgEoAgAhAiABQQRqKAIAIgMoAgAiBARAIAIgBBECAAsgAygCBCIDBEAgAkEEaygCACIEQXhxIghBBEEIIARBA3EiBBsgA2pJDScgBEEAIAggA0EnaksbDSggAhBBCyABQQRrKAIAIgJBeHEiA0EQQRQgAkEDcSICG0kNJiACQQAgA0E0TxsNASABEEELIABBIGokACAFDAELDCULDBcLIAYoAgBBAkYNACAGLQD0AiEEIAYtABAiCEEEcUUNASAEQQFxRQ0GIAYoAhhFDQYMAgsgKEUNBEEAIQQMAgsgBEEBcUUNCAsgBigC6AIiBCAoTw0BCyALICggBGs2AmAgCyALQeAAaq1CgICAgNAChDcDsAMgC0HEAGoiAEGAlMAAIAtBsANqEIgBIAAQtQIMEgsgBi0A9AIhBAJ/AkACQCAGLQAQIghBBHEEQCAEQQFxRQ0CIAYoAhgNAQwCCyAEQQFxRQ0BCyAGKAKUAiAGKAKcAiIDIAMgBigCmAIiBUkiCRsgBWsgA0EAIAkbagwBCyAGKAKoAiIJIAYoApQCIAYoApwCIgMgAyAGKAKYAiIFSSIKGyIPIAVrIANBACAKGyIDak8NASADIA9qIAUgCWprCw0BCyAiKAIAICFHDQEgACgCsAEEQCAAQQA2AtxTIAAQHSAAQQA2AtxTIABBADYCsAELICVBAWoiBSAmRg0CQZgDECAiA0UNAyAyQQA7AQggMkIANwIAIANBADYCgAMgA0EANgL4AiADQQI2AgAgAyALKQKwAzcChAMgAyALKQG2AzcBigMgACgCYEEDRgRAIAAoAmwiBARAIAAoAnAiCEEEaygCACIJQXhxIgogBEEDdCIEQQRBCCAJQQNxIgkbakkNHiAJQQAgCiAEQSdqSxsNHyAIEEELIAAoAmgQPgsgACAmNgJ0IAAgHTYCcCAAICA2AmwgACADNgJoIAAgBTYCZCAAQQM2AmAgBhA+DBgLIAhBBHEEQCAEIAYoAhhxQQFxDQUMBAsgBEEBcUUNAwwECyALICKtQoCAgIDQAoQ3A7gDIAsgNK1CgICAgNAChDcDsAMgC0HQAGoiAEHrhMAAIAtBsANqEP8BIAAQtQIMDgsgACgCYEEDRgRAIAAoAmwiAwRAIAAoAnAiBUEEaygCACIEQXhxIgggA0EDdCIDQQRBCCAEQQNxIgQbakkNGyAEQQAgCCADQSdqSxsNHCAFEEELIAAoAmgQPgsgAEEBOgDhUyAAQQQ2AmAgBhA+ICBFDRUgHUEEaygCACIDQXhxIgUgIEEDdCIEQQRBCCADQQNxIgMbakkNGSADQQAgBSAEQSdqSxsNGiAdEEEMFQsQiwMACyAAKAKkASIEQQNJDQAgBi0AkQMhCCALIAAoAqABIgMtAAFBCHQgAy0AAkEQdHIgAy0AACIFciIJQQN2Igo2AqgGAkACQAJAIAlBh4DAAE0EQEEEIQ8gBUEBdkEDcUEBaw4DAwIBAgsgCyBSNwNgIAtBsANqIgBBt8DAACALQeAAahD/ASAAELYCDA4LQbHGwQBBGxCxAgwNCyAKQQNqIQ8LIAQgD0EEQQAgCEEBcRtBACAFQQFxG2oiBU8NASAXDQMMAgsgFw0CDAELIAtB4ABqIRlBACEKQQAhCUIAIUZBACEQQgAhSkIAIUhBACEbQQAhD0EAISdCACFPIwBBoIMIayIHJAAgBikD6AIhXAJAAkACQAJAAkACQAJAAkACQAJAIAYoAgBBAkYiPUUEQAJAIAYtABBBBHEiCkUgBi0A9AIiDUEBcUVyRQRAIAYoAhhFDQEMBAsgCg0AIA1BAXENAwsgByAFNgIMIAcgAzYCCAwBCyAHIAU2AgwgByADNgIIIAdB4IIIaiEOQQAhBCMAQRBrIQ0gB0EIaiIMKAIAIQMCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCAMKAIEIgVBA00EQCAMQQA2AgQgDCADIAVqNgIAQeiBwgApAwAiRkL/AYNC/wFRDQEgDiBGNwMIIA5BADoABAwMCyAMIAVBBGsiCDYCBCAMIANBBGoiETYCACANIAMoAAAiBDYCBCAEQXBxQdDUtMIBRg0BIARBqOq+aUYNAgsgDiAENgIIIA5BAToABAwKCyAIQQRJDQEgDCAFQQhrNgIEIAwgA0EIajYCACADKAAEIQMMAgsCQCAIRQRAQQAhBSAMQQA2AgRB6IHCACkDACJGQv8Bg0L/AVINASANQgA3AwhBASEDQSghCEEFIRUMBQsgDCAFQQVrIgQ2AgRBBSEVIAwgA0EFaiIRNgIAIA0gAy0ABCIIOgAEIAhBIHEiFA0DIAQEQCAMIAVBBmsiBDYCBEEGIRUgDCADQQZqIhE2AgAgDSADLQAFIgo6AAQMBAtBACEEIAxBADYCBEHogcIAKQMAIkZC/wGDQv8BUQRAQQYhFSAIIQoMBAsgDiBGNwMIIA5BBDoABAwJCwwHCyAMQQA2AgQgDCADIAVqNgIAIAQhA0HogcIAKQMAIkZC/wGDQv8BUg0GCyAOIAM2AgwgDiAENgIIIA5BBzoABAwGCwJAAkAgDAJ/AkACQAJ/AkACQAJAIAhBA3EiBUEBaw4DAgEACAtBBCEFCyAEIAVPDQIgBCEJIAUMAQsgBA0CQQELIQNBACEEIAxBADYCBCAMIAkgEWoiETYCAEHogcIAKQMAIkZC/wGDQv8BUQ0DIA4gRjcDCCAOQQU6AAQMCgsgBQRAIA1BBGogESAF/AoAAAsgBCAFawwBCyANIBEtAAA6AARBASEFIARBAWsLIgQ2AgQgDCAFIBFqIhE2AgAgBSEDCwJ/IA0tAAQiBSADQQFGDQAaIA0tAAVBCHQgBXIiBSADQQJGDQAaIA0tAAZBEHQgDS0AB0EYdHIgBXILIglBAEchBSADIBVqIRULQQEhE0ECIQMgDAJ/AkACQAJAAkACQCAIQQZ2QQFrDgMDAgABC0EAIRNBCCEDDAILQgAhRiAUDQIMBwtBACETQQQhAwsgDUIANwMIIAMgBEsNAyADBEAgDUEIaiARIAP8CgAACyADIBFqIREgBCADawwBCyANQgA3AwggBEUEQEEBIQMMAgsgDSARLQAAOgAIQQEhAyARQQFqIRFBACETIARBAWsLNgIEIAwgETYCAAwCC0EAIQRBACETCyAMQQA2AgQgDCAEIBFqNgIAQeiBwgApAwAiRkL/AYNC/wFRDQAgDiBGNwMIIA5BBjoABAwDCwJ+IA0xAAgiRiADQQFGDQAaIA0xAAlCCIYgRoQiRiADQQJGDQAaIA0xAApCEIYgDTEAC0IYhoQgRoQiRiADQQRGDQAaIA0xAAxCIIYgDTEADUIohoQgDTEADkIwhoQgDTEAD0I4hoQgRoQLIkZCgAJ8IEYgExshRiADIBVqIRULIA4gFToAGCAOIAo6ABEgDiAIOgAQIA4gRjcDCCAOIAk2AgQgDiAFNgIADAILIA4gRjcDCCAOQQI6AAQLIA5BAjYCAAsgBykD6IIIIUYgBygC5IIIIQgCQAJAAkAgBygC4IIIIgNBAkYNACAHMQD4ggghSiBGIUgCQCAHKQPwgggiR0Igg0IAUg0AQgEgR0IIiCJIp0H4AXFBA3ZBCmqthiJJQgOIIEhCB4N+IEl8IkhCgICAgID4AFQNACAHQQA6ACBBASEQIAdBATYCGCAHKQMgIUYMAQsgB0E4aiIFIEinEGcgB0EANgIwIAdBADYCKCAHIEc3AyAgByAINgIUIAcgAzYCECAHQQA6AIQDIAdBADYCgAMgByBKNwP4AiAHIEY3AxggBykDMCFIIAcpAyghSiAHQZCACGogBUHQAvwKAAACQAJAIAYoAgBBAkYNACAGKAIoIgUEQCAGKAIsIgRBBGsoAgAiCUF4cSIKIAVBAXQiBUEEQQggCUEDcSIJG2pJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKAI0IgUEQCAGKAI4IgRBBGsoAgAiCUF4cSIKQQRBCCAJQQNxIgkbIAVqSQ0KIAlBACAKIAVBJ2pLGw0LIAQQQQsgBigCQCIFBEAgBigCRCIEQQRrKAIAIglBeHEiCkEEQQggCUEDcSIJGyAFakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAkwiBQRAIAYoAlAiBEEEaygCACIJQXhxIgogBUECdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAlgiBQRAIAYoAlwiBEEEaygCACIJQXhxIgogBUECdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAmQiBQRAIAYoAmgiBEEEaygCACIJQXhxIgogBUEDdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAnAiBQRAIAYoAnQiBEEEaygCACIJQXhxIgogBUECdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAnwiBQRAIAYoAoABIgRBBGsoAgAiCUF4cSIKIAVBAnQiBUEEQQggCUEDcSIJG2pJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKAKQASIFBEAgBigClAEiBEEEaygCACIJQXhxIgogBUEDdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoApwBIgUEQCAGKAKgASIEQQRrKAIAIglBeHEiCiAFQQJ0IgVBBEEIIAlBA3EiCRtqSQ0KIAlBACAKIAVBJ2pLGw0LIAQQQQsgBigCqAEiBQRAIAYoAqwBIgRBBGsoAgAiCUF4cSIKIAVBAnQiBUEEQQggCUEDcSIJG2pJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKAK4ASIFBEAgBigCvAEiBEEEaygCACIJQXhxIgogBUEDdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAsQBIgUEQCAGKALIASIEQQRrKAIAIglBeHEiCiAFQQJ0IgVBBEEIIAlBA3EiCRtqSQ0KIAlBACAKIAVBJ2pLGw0LIAQQQQsgBigC0AEiBQRAIAYoAtQBIgRBBGsoAgAiCUF4cSIKIAVBAnQiBUEEQQggCUEDcSIJG2pJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKALgASIFBEAgBigC5AEiBEEEaygCACIJQXhxIgogBUEDdCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAuwBIgUEQCAGKALwASIEQQRrKAIAIglBeHEiCiAFQQJ0IgVBBEEIIAlBA3EiCRtqSQ0KIAlBACAKIAVBJ2pLGw0LIAQQQQsgBigC+AEiBQRAIAYoAvwBIgRBBGsoAgAiCUF4cSIKIAVBAnQiBUEEQQggCUEDcSIJG2pJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKAKUAiIFBEAgBigCkAIiBEEEaygCACIJQXhxIgpBBEEIIAlBA3EiCRsgBWpJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKAKsAiIFBEAgBigCsAIiBEEEaygCACIJQXhxIgpBBEEIIAlBA3EiCRsgBWpJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKAK4AiIFBEAgBigCvAIiBEEEaygCACIJQXhxIgpBBEEIIAlBA3EiCRsgBWpJDQogCUEAIAogBUEnaksbDQsgBBBBCyAGKALEAiIFBEAgBigCyAIiBEEEaygCACIJQXhxIgogBUEMbCIFQQRBCCAJQQNxIgkbakkNCiAJQQAgCiAFQSdqSxsNCyAEEEELIAYoAtACIgVFDQAgBigC1AIiBEEEaygCACIJQXhxIgpBBEEIIAlBA3EiCRsgBWpJDQkgCUEAIAogBUEnaksbDQEgBBBBCyAGIEg3AyAgBiBKNwMYIAYgRzcDECAGIEZCIIg+AgwgBiBGPgIIIAYgCDYCBCAGIAM2AgAgBkEoaiAHQZCACGpB0AL8CgAAIANBAUcNA0EMIRAgBigC+AIiEUUNASAGKAL8AiEJA0AgEUEEaiEEIBEvAd4WIgVBAnQhA0F/IQ4CQANAIANFBEAgBSEODAILIAQoAgAhCiADQQRrIQMgDkEBaiEOIARBBGohBCAIIApLIAggCklrQf8BcSIKQQFGDQALIApFDQQLIAlFDQIgCUEBayEJIBEgDkECdGooAuAWIREMAAsACwwICyAZQoCAgICA+AA3AxAgGSBGNwMIIBkgCDYCBCAZIBA2AgAMBAsgBkEoaiARIA5BhAJsakEwahBaIAYgCDYCJCAGQQE2AiALIAYoAgBBAkcEQCAGLQAQQQRxIQogBi0A9AIhDQwBC0Gg88EAQQ5BsPPBABDWAgALAkAgCkUgDUEBcUVyDQAgBigCGA0AIAcoAgxBA0sEQCAGIAcoAggoAAA2AhwgBkEBNgIYIAYgBikD6AJCBHw3A+gCCyAZQQA2AgggGUL/////zwA3AwAMAgsgBkHcAmohKiAGQeABaiE4IAZBuAFqITkgBkHkAGohLiAGQZACaiEcIAZBkAFqITpB6IHCACkDACJOQv8BgyFTIAdBEWohPiAHQeiCCGohPyAHKAIIIREgBkHQAmohQCAGQbgCaiErIAZBxAJqIS0gBkHMAGohQSAGQShqIUIgBkHYAGohQyAGQUBrIUQCQAJAAkACQAJAAkACQAJAAkACQAJ/AkACQAJAA0AgBygCDCIFQQNJDQ8gByAFQQNrIgo2AgwgByARQQNqIg42AggCfyARLQAAIgRBAXZBA3EiCEEDRwRAAkACQAJAIBEtAAFBBXQgBEH4AXFBA3ZyIBEtAAJBDXRyIhBBgIAITQRAIBAhAyAIQQFrDgIBAgMLIEpCgP7//w+DIBCtQiCGhEIGhCFKIEhC/4F8g0KABIQhSEEBDAQLQQEhAwwBC0EAIRALIBCtIAOtQiCGhCFKIAitIAStQgGDQgiGhEKAgICAMIQhSEEADAELIEhC/4F8g0KABIQhSCBKQoB+g0IEhCFKQQELIEhCgP4Dg0KABFEEQCAZQQA7ABEgGUEAOgAQIBkgSjcCBCAZQQQ2AgAgGUETakEAOgAADBELIAogSkIgiCJUpyIeSQ0PIAYgBikD6AIgSEIgiEL/AYN8NwPoAgRAQQghAwwPCwJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIEinQf8BcUEBaw4DAAECAwsgB0EAOgAQIApFDQMgByARLQADIgQ6ABAgByAFQQRrNgIMIAcgEUEEaiIONgIIDAQLIAYCfyAGKALYAiINIB5PBEAgBigC1AIhBCAeDAELIB4gDWsiAyAGKALQAiANa0sEQCBAIA0gA0EBQQEQ2gEgBigC2AIhDQsgBigC1AIiBCANaiEIIANBAk8EfyADQQFrIgMEQCAIQQAgA/wLAAsgBCADIA1qIg1qBSAIC0EAOgAAIA1BAWoLIhI2AtgCIAogEk8EQCAKIBJrIQMgDiASaiERAkAgEkEBRwRAIBJFDQEgBCAOIBL8CgAADAELIAQgDi0AADoAAAsgByADNgIMIAcgETYCCAwKCyAHQQA2AgwgByAFIBFqIhE2AgggU0L/AVENCSBOQhCIIUggTkIIiCFKIE5CKIinIQQgTkIgiKchGyBOpyEIQQAhAwwYC0GE6sEAQdsAQeDqwQAQ1gIACyAHQRBqQQBBgIAI/AsAAkAgSqciCEERdiIQBEADQAJAIApBgIAITwRAIAdBEGogDkGAgAj8CgAAIAcgCkGAgAhrIgo2AgwgDkGAgAhqIQ4MAQsgB0EANgIMIFNC/wFSDQMgCiAOaiEOQQAhCgsgBigCmAIiBCAGKAKUAiINIAYoApwCIgMgBEkiBRsgA2tBACAEIAUbaiIFIAVBAEdrIgVB//8HTQRAIBxBgIAIIAVrEIsBIAYoApQCIQ0gBigCmAIhBCAGKAKcAiEDCyAEIA0gAyAESRsiCSADayIFQYCACCAFQYCACEkiDBshBSAcKAIAIQQCQCADIAlHBEAgBQRAIAMgBGogB0EQaiAF/AoAAAsgDEUNAQtBgIAIIAVrIglFDQAgBCAHQRBqIAVqIAn8CgAACyANRQ0gIAYgA0GAgAhqIA1wNgKcAiAGIAYpA6ACQoCACHw3A6ACIBBBAWsiEA0ACyAHIA42AggLIAhB//8HcSIDIApNBEAgCiADayEFIAMgDmohESADQQFGBEAgByAFNgIMIAcgETYCCCAHIA4tAAA6ABAMCAsgAwRAIAdBEGogDiAD/AoAAAsgByAFNgIMIAcgETYCCCADRQ0IDAcLIAdBADYCDCAHIAogDmoiETYCCCBTQv8BUQ0GC0EJIQNBACEPDBcLQQAhBCBTQv8BUg0BCyA+IARB/wP8CwAgSqciCUEJdiIQBEAgBigClAIhDSAGKAKYAiEEIAYoApwCIQMDQCAEIA0gAyAESSIFGyADa0EAIAQgBRtqIgUgBUEAR2siBUH/A00EQCAcQYAEIAVrEIsBIAYoApQCIQ0gBigCmAIhBCAGKAKcAiEDCyAEIA0gAyAESRsiCiADayIFQYAEIAVBgARJIgwbIQUgHCgCACEIAkAgAyAKRwRAIAUEQCADIAhqIAdBEGogBfwKAAALIAxFDQELQYAEIAVrIgpFDQAgCCAHQRBqIAVqIAr8CgAACyANRQ0dIAYgA0GABGogDXAiAzYCnAIgBiAGKQOgAkKABHw3A6ACIBBBAWsiEA0ACwsgCUH/A3EiA0UNAiAGKAKYAiINIAYoApQCIgogBigCnAIiBCANSSIFGyAEa0EAIA0gBRtqIgUgBUEAR2siBSADSQRAIBwgAyAFaxCLASAGKAKUAiEKIAYoApgCIQ0gBigCnAIhBAsgHCgCACEIIA0gCiAEIA1JGyIMIARrIgkgAyADIAlLGyIFRSAEIAxGckUEQCAEIAhqIAdBEGogBfwKAAALIAMgCU0NASADIAVrIglFDQEgCCAHQRBqIAVqIAn8CgAADAELQQkhA0EBIQ8MFAsgCkUNGSAGIAMgBGogCnA2ApwCCyAGIAYpA6ACIEpC/wODfDcDoAJCASFUIA4hEQwDCyAGKAKYAiINIAYoApQCIgogBigCnAIiBCANSSIFGyAEa0EAIA0gBRtqIgUgBUEAR2siBSADSQRAIBwgAyAFaxCLASAGKAKUAiEKIAYoApgCIQ0gBigCnAIhBAsgHCgCACEIIA0gCiAEIA1JGyIMIARrIgkgAyADIAlLGyIFRSAEIAxGckUEQCAEIAhqIAdBEGogBfwKAAALAkAgAyAJTQ0AIAMgBWsiCUUNACAIIAdBEGogBWogCfwKAAALIApFDRcgBiADIARqIApwNgKcAgsgBiAGKQOgAiBKQv//B4N8NwOgAiBKQv////8PgyFUDAELIAdBADoA7oIIIAdBADoA7IIIIAdBADYC4IIIIAdBADYC6IIIIAcgEjYClIAIIAcgBDYCkIAIIAdBADYCmIAIIAdBEGogB0GQgAhqQQIQdgJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJ/AkACQAJAAkACQAJAAkACQAJAAkACQAJAAn8CQAJAAn8gBygCEEEBRgRAIAcpAxghT0EAIQMgBygCFAwBCyAHIAcoAhhBA3EiAzoA7oIIIAdBEGogB0GQgAhqQQIQdiAHKAIQQQFHDQEgBykDGCFPIAcoAhQLIidBCHYhDSAnQf8BcUH/AUYNASAnDA8LIBJFDQ8gEkGDhpAoQYGEhBggBC0AACIFQQJxGyAFQQF0QRhxdiIIQQdxSQ0NIActABghCCASAn8CQCADQQFLIgpFBEAgB0EANgLggggCQAJAAkAgCA4EBAEEAgALQdDvwQBBxgBBmPDBABDWAgALIBJBAUcEQCAHIAQtAAFBBHQgBUEEdnIiCTYC6IIIQYAEDAQLQQFBAUGg78EAEJYCAAsgEkEBRg0PIBJBAksEQCAHIAQtAAFBBHQgBUEEdnIgBC0AAkEMdHIiCTYC6IIIQYAGDAMLQQJBAkHA78EAEJYCAAsCQAJAAkAgCARAIAhBA0sNNCAHQYEIOwHsggggCEECaw4CAgMBCyAHQYECOwHsgggLIBJBAUYNDyAHIAQtAAEiCEE/cUEEdCAFQQR2ciIJNgLoggggEkECSwRAIAdBATYC4IIIIAcgBC0AAkECdCAIQQZ2cjYC5IIIQYAGDAQLQQJBAkHI8MEAEJYCAAsgEkEBRg0NIBJBAk0NDCAHIAQtAAIiCEEMdEGA4ABxIAQtAAFBBHQgBUEEdnJyIgk2AuiCCCASQQNHBEAgB0EBNgLgggggByAELQADQQZ0IAhBAnZyNgLkgghBgAgMAwtBA0EDQfjwwQAQlgIACyASQQFGDQogEkECTQ0JIAcgBC0AAiIIQQx0QYDgD3EgBC0AAUEEdCAFQQR2cnIiCTYC6IIIIBJBA0YNCCASQQRLBEAgB0EBNgLgggggByAELQADQQJ0IAhBBnZyIAQtAARBCnRyNgLkgghBgAoMAgtBBEEEQbjxwQAQlgIACyAHIAVBA3YiCTYC6IIIQYACCyIFQQh2Ig1JDQIgJ0GAgHxxIAVyIScgBCANaiEWIBIgDWsiEyADQQFNDQEaIAcoAuSCCCEFDAULIBIgDUH/AXEiDUkNASAEIA1qIRZBACEKQQAhCSASIA1rCyETIAMhBSADDgICAwELIA0gEiASQfTpwQAQoQEAC0GU58EAQRNBqOfBABDWAgALIAkhBQsgBSATSwRAIBNBCHYhBCAFQRB2rSFIIAVBCHatIUpBASEDIAUhCCATIRsMKgsgBkEANgLAAgJAIANBAWsOAwsAAAwLIApFBEBBk4CAgHghCAwoCyAHKALkggghFSAHLQDtggghLyAGKAK4AiAJSQRAICtBACAJQQFBARDaAQsgBSAVTwRAIANBAkcNDUEAIQwgBkEANgIwIBVFBEBBiICAgHghCAwoCyAWQQFqIRQgFUEBayEEIBYsAAAiDUEATg0PIA1B/wBrIg1B/wFxIgohECAGKAI8IgMgCkkEQCAKIANrIgggBigCNCADa0sEQCAGQTRqIAMgCEEBQQEQ2gEgBigCPCEDCyAGKAI4IhAgA2ohDiAIQQJPBH8gCEEBayIIBEAgDkEAIAj8CwALIBAgAyAIaiIDagUgDgtBADoAACADQQFqIRALIAYgEDYCPCAEIA1BAXEgCkEBdmoiDUkNDiAKQQJ0IQwgBigCOCEOQQAhAwNAIANBAXYhCAJAAkACQAJAIANBAXFFBEAgBCAITQ0BIAMgEE8NAiADIA5qIAggFGotAABBBHY6AAAMBAsgBCAITQRAIAggBEGA9MEAEJYCAAsgAyAQSQ0CIAMgEEGQ9MEAEJYCAAsgCCAEQeDzwQAQlgIACyADIBBB8PPBABCWAgALIAMgDmogCCAUai0AAEEPcToAAAsgCiADQQFqIgNHDQALIAYoAjwhAwwQC0EAIBUgBUHs9sEAEKEBAAtBA0EDQajxwQAQlgIAC0ECQQJBmPHBABCWAgALQQFBAUGI8cEAEJYCAAtBAkECQejwwQAQlgIAC0EBQQFB2PDBABCWAgALQQFBAUG48MEAEJYCAAtBAUEBQbDvwQAQlgIACyASrSBPQoCAgICAYIOEIAhBB3GtQiCGhCFPICdBCHYhDUEECyEIIE+nIhtBCHYhBCBPQiCIpyEPICdBEHatIUggDa0hSkEDIQMMIAtBAEEAQZDvwQAQlgIACyAFBEAgBiAJBH8gFi0AACEEQQAhAyAGKAK4AiAJSQRAICtBACAJQQFBARDaASAGKALAAiEDCyAGKAK8AiIKIANqIQggCUEBRwR/IAlBAWsiCQRAIAggBCAJ/AsACyAKIAMgCWoiA2oFIAgLIAQ6AAAgA0EBagVBAAsiAzYCwAJBASEJDBALQQBBAEGI9sEAEJYCAAsgBSAJTwRAAkACQCAGKAK4AiAJSQRAICtBACAJQQFBARDaASAGKALAAiEDDAELQQAhAyAJRQ0BCyAJRQ0AIAYoArwCIANqIBYgCfwKAAALIAYgAyAJaiIDNgLAAgwPC0EAIAkgBUH49cEAEKEBAAtBACEjIAYtAIwBDQNBmICAgHghCAwaC0GQgICAeCEIDBgLIAQgDUkEQEGJgICAeCEIDBgLIAdBEGogLiAUIARB5AAQRyAHKAIUIQMgBygCECIIQX9HBEAgBygCGCINQYB+cSEMIAcpAhwhRiADIQQMGAsgAyANSwRAQY+AgIB4IQggAyEEDBgLIAcCfyAGKAJsRQRAQQAhDkEAIRBBAAwBCyAHIAYoAmgiCC8BBiIMOwGSgwggCC0ABCEQIAgoAgAhDiAILQAFCyIIOgCRgwggByAQOgCQgwggByAONgKMgwggByAuNgKIgwggByAMOwGegwggByAIOgCdgwggByAQOgCcgwggByAONgKYgwggByAuNgKUgwggBCADayIEIA0gA2siCkkEQCAKQYB+cSEMQY6AgIB4IQggCiENDBgLQQAhBCAHQQA6ACQgB0IANwMYIAcgAyAUajYCECAHIAo2AhQgByAKQQN0NgIgQQAhAwNAIARBCE8CfiADQf8BcUUEQCAHQRBqQQEQgAEMAQsgByADQQFrIgM6ACQgBykDGCADrYhCAYMLIkZCAVFyRQRAIARBAWohBCAHLQAkIQMMAQsLAkACQAJAIARBB00EQCAHQZCACGoiAyAHQYiDCGogB0EQaiIEEOQBIActAJCACEH/AUcNGiADIAdBlIMIaiAEEOQBIActAJCACEH/AUcNGiANQQN0IQxBACEEIAZBADYCPAJAA0AgBy0AkYMIIQMgBigCNCAERgRAIAZBNGoQ+gELIAYoAjggBGogAzoAACAGIARBAWo2AjwgB0GIgwhqIAdBEGoQ5gEgBigCNCENIAYoAjwhAyAHLQCdgwghBCAHKAIgIActACRqQQBIDQMgAyANRgRAIAZBNGoQ+gELIAYoAjggA2ogBDoAACAGIANBAWo2AjwgB0GUgwhqIAdBEGoQ5gEgBygCICAHLQAkakEASA0BIAYoAjwiBEH/AU0NAAtBi4CAgHghCEEAIQwMHAsgBy0AkYMIIQQgBigCPCIDIAYoAjRGDQIMAwsgBEEBaiEEQYqAgIB4IQhBACEMDBoLIAMgDUcNAQsgBkE0ahD6AQsgBigCOCADaiAEOgAAIAYgA0EBaiIDNgI8C0EAIRggBkEANgJIIAYoAkAgA00EQCBEQQAgA0EBakEBQQEQ2gEgBigCSCEYCyAGKAJEIg4gGGohBEEAIR8gAwRAIAMEQCAEQQAgA/wLAAsgDiADIBhqIhhqIQQLIARBADoAACAGIBhBAWoiDTYCSEGMgICAeCEIIAYoAjwiGkUNESAMQQJ2QQFxIAxBCGpBA3ZqISMgBigCOCEUQQAhA0EAIQoDQCADIBRqLQAAIgRBC0sEQEGRgICAeCEIDBMLQQEgBEEBa3RBACAEGyAKaiEKIBogA0EBaiIDRw0ACyAKRQ0RAkBBAUEgIApnIixrIhB0IAprIgRpQQFGBEAgEEEBaiEfQQAhAyANIBpBAWsiCCAIIA1LG0EBaiIkQRFJIA4gFGtBD01yDQEgH/0PIV0gFCEIIA4hDCAkICRBD3EiA0EQIAMbayIDISQDQCAMIAj9AAAAIl79DAAAAAAAAAAAAAAAAAAAAAD9JCBdIF79cf1O/QsAACAIQRBqIQggDEEQaiEMICRBEGsiJA0ACwwBCyAEQYB+cSEfQY2AgIB4IQgMEgsgBGchBANAIAMgDUYNEyADIA5qIB8gAyAUai0AACIIa0EAIAgbOgAAIBogA0EBaiIDRw0ACwJAIBggGk8EQCAGIBA6AIwBIA4gGmogBCAQakEfazoAACAKQf8PTQ0BQZKAgIB4IQhBACEfIBAhBAwTCyAaIA1BoPTBABCWAgALQQAhAyAGQQA2AlRBISAsayIIIAYoAkxLBEAgQUEAIAhBBEEEENoBIAYoAkghDSAGKAJUIQMLIAYoAlAhBCAIQQJ0QQRrIgxFIhhFBEAgBCADQQJ0akEAIAz8CwALIAYgAyAIaiIKNgJUIAQgCkECdGpBBGtBADYCACANBEAgBigCRCEDA0AgCiADLQAAIg5NDQkgBCAOQQJ0aiIOIA4oAgBBAWo2AgAgA0EBaiEDIA1BAWsiDQ0ACwtBASAGLQCMAXQiBCAGKAIwIgNLBEAgBCADayIEIAYoAiggA2tLBEAgQiADIARBAUECENoBIAYoAjAhAwsgBigCLCIOIANBAXRqIQogBEECTwR/IARBAXRBAmsiDQRAIApBACAN/AsACyADIARqIgRBAWshAyAOIARBAXRqQQJrBSAKC0EAOwAAIANBAWohBAtBACEDIAZBADYCYCAGIAQ2AjAgBigCWCAISQRAIENBACAIQQRBBBDaASAGKAJgIQMLIAYoAlwhFCAYRQRAIBQgA0ECdGpBACAM/AsACyAUIAMgCGoiDEECdGpBBGtBADYCACAGIAw2AmAgFCAQQQJ0akEANgIAIAxB/gFxBEAgBigCUCEKIAYoAlQhCCAMIQQDQCAMIARBAWsiBEH/AXEiA00NFiADIAhPDRUgFCADQQJ0Ig5qIg1BBGsgDSgCACAKIA5qKAIAIBAgBGt0ajYCACADQQFLDQALCyAUKAIAIhggBigCMCIDRw0GIAYoAkgiJARAQQAhDkEAIBhrISwgBigCLCEfIAYoAkQhMANAAkAgDiAwai0AACIaRQ0AAkAgDCAaSwRAIBQgGkECdGoiAyADKAIAIg1BASAQIBprdCIKajYCAEEAIQggCkEBayIDIBggDWsiBEEAIAQgGE0bIgQgAyAESRsiBEEPTQ0BIA79DyAa/Q/9DQAQABAAEAAQABAAEAAQABAhXSAfIA1BAXRqIQMgBEEBaiIEIARBD3EiBEEQIAQbayIIIQQDQCADIF39CwAAIAMgXf0LABAgA0EgaiEDIARBEGsiBA0ACwwBCyAaIAxB0PTBABCWAgALIAggLGogDSAYIA0gGEkbaiEEIAogCGshCiAfIAggDWoiDUEBdGohAwNAIAQEQCADIA46AAAgA0EBaiAaOgAAIANBAmohAyANQQFqIQ0gBEEBaiEEIApBAWsiCg0BDAILCyANIBhB4PTBABCWAgALIA5BAWoiDiAkRw0ACwsgFSAjSQ0BCyAWICNqIQggFSAjayEDIC9BAWsOBAIDAwEDCyAjIBUgFUHc9sEAEKEBAAsgA0EFTQRAIAcgAzYChIMIQZmAgIB4IQgMFQsgA0EGayIMIAgvAAAiBCAILQACaiAILQADQQh0aiIKIAgtAARqIAgtAAVBCHRqIgNJBEAgByAMNgKEgwhBmoCAgHghCCADIQ8MFQsgByAMIANrNgIsIAcgAyAKazYCJCAHIAQ2AhQgByAKIARrNgIcIAcgCEEGaiIINgIQIAcgAyAIajYCKCAHIAggCmo2AiAgByAEIAhqNgIYQQAhCANAIAdBADoApIAIIAdCADcDmIAIIAcgB0EQaiAIaiIDKAIEIgQ2ApSACCAHIAMoAgA2ApCACCAHIARBA3Q2AqCACEEAIQNBACEEA0AgBEEITwJ+IANB/wFxRQRAIAdBkIAIakEBEIABDAELIAcgA0EBayIDOgCkgAggBykDmIAIIAOtiEIBgwsiRkIBUXJFBEAgBEEBaiEEIActAKSACCEDDAELCyAEQQdLDQwgBy0ApIAIIQQCQCAGLQCMASIDRQRAQgAhRkEAIQMMAQsgAyAEQf8BcUsEQCAHQZCACGogAxCAASFGIAYtAIwBIQMgBy0ApIAIIQQMAQsgByAEIANrIgQ6AKSACEJ/IAOthkJ/hSAHKQOYgAggBK2IgyFGCyAHKAKggAgiECAEQf8BcWoiCkEAIANB/wFxayIDSgRAIAYoAjAhDQNAAkACQAJAIEanIgMgDUkEQCADQQF0IgwgBigCLGotAAAhDiAGKALAAiIKIAYoArgCRgRAICsQ+gELIAYoArwCIApqIA46AAAgBiAKQQFqNgLAAiAGKAIwIg0gA00NASAGKAIsIAxqLQABIgMNAkIAIUcMAwsgAyANQZj2wQAQlgIACyADIA1B0PPBABCWAgALIAMgBEH/AXFLBEAgB0GQgAhqIAMQgAEhRyAGKAIwIQ0gBy0ApIAIIQQgBygCoIAIIRAMAQsgByAEIANrIgQ6AKSACEJ/IAOthkJ/hSAHKQOYgAggBK2IgyFHCyANrUIBfSBGIAOthoMgR4QhRiAQIARB/wFxaiIKQQAgBi0AjAFrIgNKDQALCyADIApHDQ0gCEEIaiIIQSBHDQALDAYLQQAhBCAHQQA6ACQgB0IANwMYIAcgCDYCECAHIAM2AhQgByADQQN0NgIgQQAhAwwBC0Go9sEAQSJBzPbBABDWAgALA0AgBEEITwJ+IANB/wFxRQRAIAdBEGpBARCAAQwBCyAHIANBAWsiAzoAJCAHKQMYIAOtiEIBgwsiRkIBUXJFBEAgBEEBaiEEIActACQhAwwBCwsgBEEHSw0CIActACQhBAJAIAYtAIwBIgNFBEBCACFGQQAhAwwBCyADIARB/wFxSwRAIAdBEGogAxCAASFGIAYtAIwBIQMgBy0AJCEEDAELIAcgBCADayIEOgAkQn8gA62GQn+FIAcpAxggBK2IgyFGCyAHKAIgIhAgBEH/AXFqQQAgA0H/AXFrTA0DIAYoAjAhDQNAAkACQAJAIEanIgMgDUkEQCADQQF0IgogBigCLGotAAAhDCAGKALAAiIIIAYoArgCRgRAICsQ+gELIAYoArwCIAhqIAw6AAAgBiAIQQFqNgLAAiAGKAIwIg0gA00NASAGKAIsIApqLQABIgMNAkIAIUcMAwsgAyANQZj2wQAQlgIACyADIA1B0PPBABCWAgALIAMgBEH/AXFLBEAgB0EQaiADEIABIUcgBigCMCENIActACQhBCAHKAIgIRAMAQsgByAEIANrIgQ6ACRCfyADrYZCf4UgBykDGCAErYiDIUcLIA2tQgF9IEYgA62GgyBHhCFGIBAgBEH/AXFqQQAgBi0AjAFrSg0ACwwDCyAHIAM2ApCACCAHIAdBkIAIaq1CgICAgNAChDcDGCAHIBStQoCAgIDQAoQ3AxBB9JbAACAHQRBqQcD0wQAQpAIACyAOIApBsPTBABCWAgALIAcgBEEBajYChIMIQZuAgIB4IQgMDgsgCSAGKALAAiIDRwRAIAcgAzYChIMIQZ2AgIB4IQggCSEPDA4LIAkhAyAVIQkLAkACQAJAAkACQAJAAkACfwJAAkAgAyAHKALogghGBEAgBSAJRw0BQQAhBCAFIBNGBEBBASEbQQAhCAwOCyAFIBZqIgwtAAAiDQRAIBMgBWshCQJAIA1B/wFGBEAgCUEETw0BIAkhCEEEIRsMEAsgDcBBAEgNBEEBIQggCUEBRgRAQQIhGwwQC0EBIQVBAgwFCyAMLwABQYD+AWohDUEDIQVBBAwECyASIB5GDQQMBQsgByADNgKQgAggByA/rUKAgICA0AKENwMYIAcgB0GQgAhqrUKAgICA0AKENwMQQZqSwAAgB0EQakG458EAEKQCAAtByOfBAEHTAEGc6MEAENYCAAsgCUEDSQRAIAkhCEEDIRsMCwsgDC0AASANQQh0ckGAgAJrIQ1BAiEFQQMLIQQgEiAeRw0BIA0NAwsgA0UNBCAGKAK8AiEIIAYoApgCIg0gBigClAIiCiAGKAKcAiIEIA1JIgUbIARrQQAgDSAFG2oiBSAFQQBHayIFIANJBEAgHCADIAVrEIsBIAYoApQCIQogBigCmAIhDSAGKAKcAiEECyAcKAIAIQkgDSAKIAQgDUkbIg4gBGsiDCADIAMgDEsbIgVFIAQgDkZyRQRAIAQgCWogCCAF/AoAAAsgAyAMSw0BDAMLQazowQBBtgFB5OnBABDWAgALIAMgBWsiDEUNASAJIAUgCGogDPwKAAAMAQsgBCAMaiEKIAkgBGshCEEAIQMCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgBSAMai0AACIFQcABcUEGdkEBaw4DAAMJAQtBACEMIAQgCUcNAUGOgICAeCEEQQAhBQwMC0GQARAgIgNFDQQgA0Gs98EAQZAB/AoAACAGKALEASIEDQIMAwsgCi0AACIDQSNNDQQMCQsgB0EQaiA5IAogCEEJEEcgBygCFCEDIAcoAhAiBEF/RwRAIANBgH5xIQUgBykCHCFGIAcoAhghDyADIQwMCgsgBkEAOgCKAgwECyAGKALIASIJQQRrKAIAIgxBeHEiDiAEQQJ0IgRBBEEIIAxBA3EiDBtqSQ0gIAxBACAOIARBJ2pLGw0hIAkQQQsgBkEGOgDdASAGQSQ2AswBIAYgAzYCyAEgBkEkNgLEASAHQRBqIDkQOyAHKAIQIgRBf0cEQCAHKAIUIgxBgH5xIQUMBQtBACEDIAZBADoAigIMAwtBBEGQARDPAgALIAYgAzoAiwJBASEDIAZBAToAigILIAMgCE0NACADIAggCEGU+8EAEKEBAAsgAyAKaiEEAkACQAJAAkACfgJAAkACQAJAAkACQAJAIAVBBHZBA3FBAWsOAwADBgELQQAhDCADIAhHDQFBj4CAgHghBEEAIQUMDgtB9AAQICIERQ0LIARBvPjBAEH0APwKAAAgBigCnAEiCQ0CDAMLIAQtAAAiBEEfSw0LIAYgBDoAiQIgBkEBOgCIAiADQQFqIQMMAwsgB0EQaiA6IAQgCCADa0EIEEcgBygCFCEMIAcoAhAiBEF/RwRAIAxBgH5xIQUMCQsgBkEAOgCIAiADIAxqIQMMAgsgBigCoAEiDEEEaygCACIOQXhxIhAgCUECdCIJQQRBCCAOQQNxIg4bakkNIiAOQQAgECAJQSdqSxsNIyAMEEELIAZBBToAtQEgBkEdNgKkASAGIAQ2AqABIAZBHTYCnAEgB0EQaiA6EDsgBygCECIEQX9HBEAgBygCFCIMQYB+cSEFDAcLIAZBADoAiAILAkACQAJAAkACQAJAAkAgAyAITQRAIAMgCmohCSAFQQJ2QQNxQQFrDgMBBAcCCyADIAggCEGE+8EAEKEBAAtBkICAgHghBEEAIQwgAyAIRw0BQQAhBQwOC0HUARAgIgVFDQkgBUGw+cEAQdQB/AoAACAGKALsASIEDQIMAwtBACEFIAktAAAiCUE0Sw0MIAYgCToAjQIgBkEBOgCMAiADQQFqIQMMAwsgB0EQaiA4IAkgCCADa0EJEEcgBygCFCEMIAcoAhAiBEF/RwRAIAxBgH5xIQUMCQsgBkEAOgCMAiADIAxqIQMMAgsgBigC8AEiCUEEaygCACIMQXhxIg4gBEECdCIEQQRBCCAMQQNxIgwbakkNIiAMQQAgDiAEQSdqSxsNIyAJEEELIAZBBjoAhQIgBkE1NgL0ASAGIAU2AvABIAZBNTYC7AEgB0EQaiA4EDsgBygCECIEQX9HBEAgBygCFCIMQYB+cSEFDAcLIAZBADoAjAILAkAgAyAITQRAQQAhBCAHQQA6AKSACCAHQgA3A5iACCAHIAMgCmo2ApCACCAHIAggA2siAzYClIAIIAcgA0EDdDYCoIAIQQAhAwwBCyADIAggCEGc98EAEKEBAAsDQCAEQQhPAn4gA0H/AXFFBEAgB0GQgAhqQQEQgAEMAQsgByADQQFrIgM6AKSACCAHKQOYgAggA62IQgGDCyJGQgFRckUEQCAEQQFqIQQgBy0ApIAIIQMMAQsLAkAgBEEHTQRAIAYtAIgCIgVBAXEgBi0AigIiFSAGLQCMAiIEQQFxcnIEQEIAIUxCACFJIAYoAsABIgkEQCAGKAK8ASkCACFJCyAGKALoASIKBEAgBigC5AEpAgAhTAsgBigCmAEiDgR+IAYoApQBKQIABUIACyFLIBUNBCAGLQDdASIDRQRAQoaAgIAoIUcMDQsgBy0ApIAIIgggA0kNAiAHIAggA2siCDoApIAIQn8gA62GQn+FIAcpA5iACCAIrYiDDAMLQoaAgIAoIUcgBi0A3QEiA0UNCyAGKAKYASEEAn4gAyAHLQCkgAgiBUsEQCAHQZCACGogAxCAAQwBCyAHIAUgA2siBToApIAIQn8gA62GQn+FIAcpA5iACCAFrYiDCyFGIAYoAsABIgggRqciBUsEQCAGLQC1ASIDRQ0MIAYoArwBIhYgBUEDdGopAgAhRgJ+IAMgBy0ApIAIIgVLBEAgB0GQgAhqIAMQgAEMAQsgByAFIANrIgU6AKSACEJ/IAOthkJ/hSAHKQOYgAggBa2IgwunIgUgBEkEQCAGLQCFAiIDRQ0NIAYoApQBIhggBUEDdGopAgAhTQJ+IAMgBy0ApIAIIgVLBEAgB0GQgAhqIAMQgAEMAQsgByAFIANrIgU6AKSACEJ/IAOthkJ/hSAHKQOYgAggBa2IgwshRyAGKALoASIJIEenIgNLBEAgBkEANgLMAiAGKALkASIaIANBA3RqKQIAIUcgBigCxAIgDUkEQCAtQQAgDUEEQQwQ2gELQX8hDgNAIA5BAWoiDiANRgRAIAcoAqCACCAHLQCkgAhqIgNBAEwNCiADrUIghkKMgICACIQhRwwQCyAHIEZCKIinIgM6AJSDCAJ/IANB/wFxQRBJIhVFBEAgA0EQa0H/AXEiA0EUTw0rIANBAnQoApShQiEQIAMtAIChQgwBCyADQQ9xIRBBAAshAyAHIEdCKIinIgU6AJSDCAJ/IAVB/wFxQSBJIhRFBEAgBUEga0H/AXEiBUEVTw0sIAUtAOShQiEKIAVBAnQoAvyhQgwBC0EAIQogBUEDakH/AXELIR4CQAJ+AkAgTUIoiCJLpyIFQf8BcSITQR9NBEAgAyAFaiAKaiIjQf8BcSISRQRAQgAhS0IAIUlCACFMDAQLIBJBOE0EQCASIActAKSACCIMSwRAIAdBEGogB0GQgAhqIAUgCiADICMQViAHKQMgIUsgBykDGCFJIAcpAxAhTAwFC0IAIUkgEwR+IAcgDCAFayIMOgCkgAhCfyBLQh+DhkJ/hSAHKQOYgAggDK2IgwVCAAshTCAURQRAIAcgDCAKayIMOgCkgAhCfyAKrYZCf4UgBykDmIAIIAytiIMhSQtCACFLIBVFBEAgByAMIANrIgo6AKSACEJ/IAOthkJ/hSAHKQOYgAggCq2IgyFLCyAHIEk3AxggByBMNwMQDAQLQgAhSUIAIBNFDQIaIActAKSACCIMIBNJDQEgByAMIAVrIgw6AKSACEJ/IEtCH4OGQn+FIAcpA5iACCAMrYiDDAILIEtCIIZCgICAgPAfg0KJgICACIQhRwwSCyAHQZCACGogBRCAAQshTAJAIBQNACAHLQCkgAgiDCAKQf8BcUkEQCAHQZCACGogChCAASFJDAELIAcgDCAKayIMOgCkgAhCfyAKrYZCf4UgBykDmIAIIAytiIMhSQsgFQRAQgAhSwwBCyAHLQCkgAgiCiADQf8BcUkEQCAHQZCACGogAxCAASFLDAELIAcgCiADayIKOgCkgAhCfyADrYZCf4UgBykDmIAIIAqtiIMhSwsgTKdBASAFdGoiBUUEQEKKgICACCFHDBALIAYoAswCIgMgBigCxAJGBEAgLRD4AQsgBiADQQFqIgo2AswCIAYoAsgCIANBDGxqIgMgBTYCCCADIB4gSadqNgIEIAMgECBLp2o2AgAgCiANSQRAIAgCfkIAIEZCIIgiSaciA0H/AXEiBUUNABogBSAHLQCkgAgiCk0EQCAHIAogA2siAzoApIAIQn8gSYZCf4UgBykDmIAIIAOtiIMMAQsgB0GQgAhqIAMQgAELpyBGp2oiA00EQCADIAhB2PHBABCWAgALIBYgA0EDdGopAgAhRiAJAn5CACBHQiCIIkmnIgNB/wFxIgVFDQAaIAUgBy0ApIAIIgpNBEAgByAKIANrIgM6AKSACEJ/IEmGQn+FIAcpA5iACCADrYiDDAELIAdBkIAIaiADEIABC6cgR6dqIgNNBEAgAyAJQdjxwQAQlgIACyAaIANBA3RqKQIAIUcgBAJ+QgAgTUIgiCJJpyIDQf8BcSIFRQ0AGiAFIActAKSACCIKTQRAIAcgCiADayIDOgCkgAhCfyBJhkJ/hSAHKQOYgAggA62IgwwBCyAHQZCACGogAxCAAQunIE2naiIDTQRAIAMgBEHY8cEAEJYCAAsgGCADQQN0aikCACFNCyAHKAKggAggBy0ApIAIakEATg0ACwwHCyADIAlByPHBABCWAgALIAUgBEHI8cEAEJYCAAsgBSAIQcjxwQAQlgIACyAEQQFqrUIghkKIgICACIQhRwwKCyAHQZCACGogAxCAAQshRiBGpyIDIAlJBEAgBigCvAEgA0EDdGopAgAhSQwBCyADIAlByPHBABCWAgALAkAgBUEBcSIUDQAgBi0AtQEiA0UEQEKGgICAKCFHDAkLAn4gAyAHLQCkgAgiBU0EQCAHIAUgA2siBToApIAIQn8gA62GQn+FIAcpA5iACCAFrYiDDAELIAdBkIAIaiADEIABCyJGpyIDIA5JBEAgBigClAEgA0EDdGopAgAhSwwBCyADIA5ByPHBABCWAgALAkAgBEEBcSISDQAgBi0AhQIiA0UEQEKGgICAKCFHDAkLAn4gAyAHLQCkgAgiBU0EQCAHIAUgA2siBToApIAIQn8gA62GQn+FIAcpA5iACCAFrYiDDAELIAdBkIAIaiADEIABCyJGpyIDIApJBEAgBigC5AEgA0EDdGopAgAhTAwBCyADIApByPHBABCWAgALIAZBADYCzAIgBigCxAIgDUkEQCAtQQAgDUEEQQwQ2gELIAYoApQBISMgBigC5AEhHyAGKAK8ASEkIAYtAIkCIS8gBi0AjQIhLCAGLQCLAiEwQX8hAwNAIANBAWoiAyANRgRAIAcoAqCACCAHLQCkgAhqIgNBAEwNAyADrUIghkKMgICACIQhRwwJCyAHIDAgSUIoiKcgFRsiBToAlIMIAn8gBUH/AXEiEEEQSSIYRQRAIAVBEGtB/wFxIgVBFE8NJCAFQQJ0KALEn0IhECAFLQCwn0IMAQtBAAshBSAHICwgTEIoiKcgEhsiBDoAlIMIAn8gBEH/AXFBIEkiGkUEQCAEQSBrQf8BcSIEQRVPDSUgBEECdCgCrKBCIQwgBC0AlKBCDAELIARBA2pB/wFxIQxBAAshBAJAAn4CQCAvIEtCKIinIBQbIghB/wFxIhNBH00EQCAFIAhqIARqIkVB/wFxIh5FBEBCACFNQgAhRkIAIUcMBAsgHkE4TQRAIB4gBy0ApIAIIhZLBEAgB0EQaiAHQZCACGogCCAEIAUgRRBWIAcpAyAhTSAHKQMYIUYgBykDECFHDAULQgAhRiATBH4gByAWIAhrIhY6AKSACEJ/IAithkJ/hSAHKQOYgAggFq2IgwVCAAshRyAaRQRAIAcgFiAEayIWOgCkgAhCfyAErYZCf4UgBykDmIAIIBatiIMhRgtCACFNIBhFBEAgByAWIAVrIgQ6AKSACEJ/IAWthkJ/hSAHKQOYgAggBK2IgyFNCyAHIEY3AxggByBHNwMQDAQLQgAhRkIAIBNFDQIaIActAKSACCIWIBNJDQEgByAWIAhrIhY6AKSACEJ/IAithkJ/hSAHKQOYgAggFq2IgwwCCyAIrUL/AYNCIIZCiYCAgAiEIUcMCwsgB0GQgAhqIAgQgAELIUcCQCAaDQAgBy0ApIAIIgggBEH/AXFJBEAgB0GQgAhqIAQQgAEhRgwBCyAHIAggBGsiCDoApIAIQn8gBK2GQn+FIAcpA5iACCAIrYiDIUYLIBgEQEIAIU0MAQsgBy0ApIAIIgQgBUH/AXFJBEAgB0GQgAhqIAUQgAEhTQwBCyAHIAQgBWsiBDoApIAIQn8gBa2GQn+FIAcpA5iACCAErYiDIU0LIEenQQEgE3RqIgRFBEBCioCAgAghRwwJCyAGKALMAiIFIAYoAsQCRgRAIC0Q+AELIAYgBUEBaiIINgLMAiAGKALIAiAFQQxsaiIFIAQ2AgggBSAMIEanajYCBCAFIBAgTadqNgIAAkAgCCANTw0AIBVFBEAgCQJ+QgAgSUIgiCJGpyIFQf8BcSIERQ0AGiAEIActAKSACCIITQRAIAcgCCAFayIFOgCkgAhCfyBGhkJ/hSAHKQOYgAggBa2IgwwBCyAHQZCACGogBRCAAQsiRqcgSadqIgVNBEAgBSAJQdjxwQAQlgIACyAkIAVBA3RqKQIAIUkLIBJFBEAgCgJ+QgAgTEIgiCJGpyIFQf8BcSIERQ0AGiAEIActAKSACCIITQRAIAcgCCAFayIFOgCkgAhCfyBGhkJ/hSAHKQOYgAggBa2IgwwBCyAHQZCACGogBRCAAQsiRqcgTKdqIgVNBEAgBSAKQdjxwQAQlgIACyAfIAVBA3RqKQIAIUwLIBQNACAOAn5CACBLQiCIIkanIgVB/wFxIgRFDQAaIAQgBy0ApIAIIghNBEAgByAIIAVrIgU6AKSACEJ/IEaGQn+FIAcpA5iACCAFrYiDDAELIAdBkIAIaiAFEIABCyJGpyBLp2oiBU0EQCAFIA5B2PHBABCWAgALICMgBUEDdGopAgAhSwsgBygCoIAIIActAKSACGpBAE4NAAsLQouAgIAIIUcMBgsgBigClAIhGCAGKAKYAiEUIAYoApwCIQ1BACEIIAdBADYClIMIIA0hA0EAIQUgBigCzAIiGgRAQQghDEEAIQpBACEDA0ACQAJAAkACQAJAAkACQAJAAkACfwJAIAYoAswCIgUgA0sEQCAGKALIAiAMaiIFKAIAIQ4gBUEEaygCACEVIAVBCGsoAgAiEw0HIA5BAWsiBUECTw0BICogDkECdGooAgAMAgsgAyAFQdj1wQAQlgIACyAOQQNGBEAgKigCACIOQQFrIQQMAgsgDkEDawshBAJAIAUOAgIDAAsgKigCACEOCyAGIAYoAuACNgLkAgwCCyAqKAIAIQ4MAQsgBiAGKALgAjYC5AIgBigC3AIhDgsgCiEFDAELIAogE2oiBSAGKALAAiIESwRAQgIhRiAFIRsgBCEPDAMLAkAgBSAKTwRAIAYoArwCIRIgBigCmAIiECAGKAKUAiIJIAYoApwCIgQgEEkiFhsgBGtBACAQIBYbaiIWIBZBAEdrIhYgE0kEQCAcIBMgFmsQiwEgBigClAIhCSAGKAKYAiEQIAYoApwCIQQLIAogEmohEiAcKAIAIRYgECAJIAQgEEkbIh4gBGsiECATIBAgE0kbIgpFIAQgHkZyRQRAIAQgFmogEiAK/AoAAAsgECATTw0BIBMgCmsiEEUNASAWIAogEmogEPwKAAAMAQsgCiAFIARB6PXBABChAQALAn8CQCAJBEAgBiAEIBNqIAlwNgKcAiAGIAYpA6ACIBOtfDcDoAIgDkEBayIJQQNJDQEgDkEDawwCCwwmCyAqIA5BAnRqQQRrKAIACyEEAkACQCAJDgIDAAELICooAgAhDgwBCyAGIAYoAuACNgLkAiAGKALcAiEOCyAGIAQ2AtwCIAYgDjYC4AILIARFBEBCAyFGDAELIBVFDQEgB0EQaiAcIAQgFRDGASAHKAIQQQJGDQEgBykDECJGQiCIpyEbIAcoAhghDyBGp0F/Rg0NCyAbQQh2IQQgRkIQiCFIIEZCCIghSiBGpyEIQQYhAwwaCyAHIBMgFWogCGoiCDYClIMIIAxBDGohDCAFIQogGiADQQFqIgNHDQALIAYoApwCIQMLAkAgBSAGKALAAiIETwRAIAYoApQCIQogBigCmAIhBAwBCyAGKAK8AiEMIAQgBWsiCSAGKAKYAiIEIAYoApQCIgogAyAESSIOGyADa0EAIAQgDhtqIg4gDkEAR2siDksEQCAcIAkgDmsQiwEgBigClAIhCiAGKAKYAiEEIAYoApwCIQMLIAUgDGohDCAcKAIAIQ4gBCAKIAMgBEkbIhMgA2siECAJIAkgEEsbIgVFIAMgE0ZyRQRAIAMgDmogDCAF/AoAAAsCQCAJIBBNDQAgCSAFayIQRQ0AIA4gBSAMaiAQ/AoAAAsgCgRAIAYgAyAJaiAKcCIDNgKcAiAGIAYpA6ACIAmtfDcDoAIgByAIIAlqIgg2ApSDCAwBCwwfCyAHIAMgFGogDSAYQQAgDSAUSRtqIARqayAKQQAgAyAESRtqIgM2ApCACCADIAhGDQkgByAHQZCACGqtQoCAgIDQAoQ3AxggByAHQZSDCGqtQoCAgIDQAoQ3AxBB1pTAACAHQRBqQcj1wQAQpAIAC0EEQdQBEM8CAAsgBykCHCFGIAcoAhghDwwCC0EEQfQAEM8CAAtBkICAgHghBEEAIQULIAStIAUgDEH/AXFyrUIghoQhRwsgR0IQiCFIIEdCCIghSiBHQiiIpyEEIEdCIIinIRsgR6chCEEFIQMMEQsgCkUNASAGIAMgBGogCnA2ApwCCyAGQQA2AswCIAYgBikDoAIgA618NwOgAgwBCwwVCyAGIAYpA+gCIFR8IkY3A+gCIAYgBigC8AJBAWo2AvACIEhCgAKDUA0ACyAGQQE6APQCIAYtABBBBHFFDQ4gBygCDEEESQ0OIAYgESgAADYCHCAGQQE2AhggBiBGQgR8NwPoAgwOC0IAIUpBBCEDQgAhSAwLCyAEQQFqIQNBm4CAgHghCCAHQYSDCGoMAQsgByAKNgKEgwhBnICAgHghCCAHQYCDCGoLIAM2AgAgBygCgIMIIQ8MBgsgByAfIARB/wFxcjYChIMIDAULIA0gDUGQ9cEAEJYCAAsgAyAIQYD1wQAQlgIACyADIAxB8PTBABCWAgALIAcoApSACCINQYB+cSEMIAc1ApiACCFGIAcoApCACCEEQYaAgIB4IQgLIAwgDUH/AXFyIQ8gByAENgKEgwgLIAcoAoSDCCIbQQh2IQQgCEEQdq0hSCAIQQh2rSFKQQIhAwwBC0HQ78EAQcYAQajwwQAQ1gIACyAIrUL/AYMgSEIQhkKAgPz/D4MgSkIIhkKA/gODhIQgG0H/AXEgBEEIdHKtQiCGhCFOCyAZIEY3AhQgGSAPNgIQIBkgTjcDCCAZIAM2AgQgGUEFNgIADAELIAdBEGogBkEBQQAQZiAHLQAQQf8BRwRAIBkgBykDEDcCBCAZQQk2AgAMAQsgBigCAEECRg0BIBkgBygCFDYCCCAZQX82AgAgGSAGKQPoAkIAIFwgPRt9PgIECyAHQaCDCGokAAwGC0Gg88EAQQ5BwPPBABDWAgALQeiOwgBBLkGYj8IAENYCAAtBqI/CAEEuQdiPwgAQ1gIAC0GA78EAEIQDAAsgByAHQZSDCGqtQoCAgIDwAoQ3AxBBi47AACAHQRBqQfz2wQAQpAIACyAHIAdBlIMIaq1CgICAgPAChDcDEEHZjsAAIAdBEGpBjPfBABCkAgALIAsoAmBBf0cEQCALIAv9AANw/QsDwAMgCyAL/QADYP0LA7ADIwBBIGsiACQAIAAgC0GwA2oiAa1CgICAgBCENwMYIABBDGoiAkHmmMAAIABBGGoQiAEgAhC1AiABEC4gAEEgaiQADAoLIAAoAqQBIgUgCygCZCIDSQ0DIABBADYCpAEgBSADayEEIAMEQCADIAVGDQIgBARAIAAoAqABIgUgAyAFaiAE/AoAAAsgACAENgKkAQwCCyADIAVHBEAgACAENgKkAQsgFw0BCwsgKCA3Rg0CIAAoAqQBIgNBhoAISwRAIAsgAzYCYCALIAtB4ABqrUKAgICA0AKENwO4AyALIAtBNGqtQoCAgIDQAoQ3A7ADIAtB1AZqIgBBy77AACALQbADahD/ASAAELUCDAgLIAAoAmBBA0cNACAAKAJsIgMEQCAAKAJwIgVBBGsoAgAiBEF4cSIIIANBA3QiA0EEQQggBEEDcSIEG2pJDRQgBEEAIAggA0EnaksbDRUgBRBBCyAAKAJoED4LIAAgJjYCdCAAIB02AnAgACAgNgJsIAAgBjYCaCAAICU2AmQgAEEDNgJgDAkLQQAgAyAFQdjGwQAQoQEACyALIAtBNGqtQoCAgIDQAoQ3A7ADIAtByAZqIgBBr8HAACALQbADahD/ASAAELUCDAQLQQAgDyADQdjGwQAQoQEACyALQoCAgICA+AA3A8ADIAsgRjcDuAMgCyAKNgK0AyALIAw2ArADIwBBIGsiACQAIAAgC0GwA2oiAa1CgICAgBCENwMYIABBDGoiAkHOmMAAIABBGGoQiAEgAhC1AiABEC4gAEEgaiQADAILIAOtIACtQiCGhCFQQQchAAsgCyBQNwK0AyALIAA2ArADAn8jAEEgayIBJAAgASALQbADaiIArUKAgICAwASENwMYIAFBDGoiAkGEmcAAIAFBGGoQiAEgAhC2AiECAkACQAJAAkACQAJAAkACQAJAIAAtAAAOBwAHAQcCAwQHCyAALQAEQQNHDQYgACgCCCIEKAIAIQggBEEEaigCACIAKAIAIgMEQCAIIAMRAgALIAAoAgQiAEUNBSAIQQRrKAIAIgNBeHEiBUEEQQggA0EDcSIDGyAAakkNByADRSAFIABBJ2pNcg0EDBYLIAAtAARBA0cNBSAAKAIIIgQoAgAhCCAEQQRqKAIAIgAoAgAiAwRAIAggAxECAAsgACgCBCIARQ0EIAhBBGsoAgAiA0F4cSIFQQRBCCADQQNxIgMbIABqSQ0GIANFIAUgAEEnak1yDQMMFQsgAC0ABEEDRw0EIAAoAggiBCgCACEIIARBBGooAgAiACgCACIDBEAgCCADEQIACyAAKAIEIgBFDQMgCEEEaygCACIDQXhxIgVBBEEIIANBA3EiAxsgAGpJDQUgA0UgBSAAQSdqTXINAgwUCyAALQAEQQNHDQMgACgCCCIEKAIAIQggBEEEaigCACIAKAIAIgMEQCAIIAMRAgALIAAoAgQiAEUNAiAIQQRrKAIAIgNBeHEiBUEEQQggA0EDcSIDGyAAakkNBCADRSAFIABBJ2pNcg0BDBMLIAAtAARBA0cNAiAAKAIIIgQoAgAhCCAEQQRqKAIAIgAoAgAiAwRAIAggAxECAAsgACgCBCIARQ0BIAhBBGsoAgAiA0F4cSIFQQRBCCADQQNxIgMbIABqSQ0DIANFIAUgAEEnak1yDQAMEgsgCBBBCyAEQQRrKAIAIgBBeHEiA0EQQRQgAEEDcSIAG0kNASAAQQAgA0E0TxsNECAEEEELIAFBIGokACACDAELDA0LCyEDIAYQPiAgRQ0KAkAgHUEEaygCACIAQXhxIgEgIEEDdCICQQRBCCAAQQNxIgAbak8EQCAAQQAgASACQSdqSxsNASAdEEEMDAsMDAsMDAsgDwRAIANBBGsoAgAiAEF4cSIBIA9BAnQiAkEEQQggAEEDcSIAG2pJDQsgAEEAIAEgAkEnaksbDQwgAxBBCwJAIAsoAtQGIgAEQCALKALYBiIBQQRrKAIAIgJBeHEiAyAAQQN0IgBBBEEIIAJBA3EiAhtqSQ0MIAJBACADIABBJ2pLGw0BIAEQQQsgBSEDDAoLDAsLIA8EQCADQQRrKAIAIgVBeHEiCCAPQQJ0IgpBBEEIIAVBA3EiBRtqSQ0KIAVBACAIIApBJ2pLGw0LIAMQQQsgCygC2AYhAyALKALUBiIIQX9HBEAgCyAJNgLUBgJAAkAgACgCWEEBRgRAIAsgACgCXCIFNgKoBiAFIAlHDQELIAAgJSAGICAgERBtIgUNAUGHgAgQICIJRQ0EIAAoApwBIgUEQCAAKAKgASIKQQRrKAIAIg9BeHEiDEEEQQggD0EDcSIPGyAFakkNDSAPQQAgDCAFQSdqSxsNDiAKEEELIABBADYCpAEgACAJNgKgASAAQYeACDYCnAFBmAMQICIFRQ0FIDFBADsBCCAxQgA3AgAgBUEANgKAAyAFQQA2AvgCIAVBAjYCACAFIAspAmA3AoQDIAUgCykBZjcBigMgACgCYEEDRgRAIAAoAmwiCQRAIAAoAnAiCkEEaygCACIPQXhxIgwgCUEDdCIJQQRBCCAPQQNxIg8bakkNDiAPQQAgDCAJQSdqSxsNDyAKEEELIAAoAmgQPgsgACAENgJ0IAAgAzYCcCAAIAg2AmwgACAFNgJoIABCAzcCYAwICyALIFU3A2ggCyBSNwNgIAtBIGoiAEGIhMAAIAtB4ABqEP8BIAAQtQIhBQsgCEUEQCAFIQMMCgsgA0EEaygCACIAQXhxIgEgCEEDdCICQQRBCCAAQQNxIgAbakkNCiAAQQAgASACQSdqSxsNCyADEEEgBSEDDAkLIAMNCAsgAkUEQEEAIQMMCAsgACgCYCIDQQRGBEBBuN/AAEEvELACIQMMCAsCQAJAAkACQAJAAkACQAJAIANBAWsOAwIAAQMLIAAoAnggACgCdGsiBSAAKAKkASIIayIEQQAgBCAFTRsiBUUNCQwDCyAAKAJkIgUgACgCdCIESQRAQYeACCAAKAKkASIIayIEQQAgBEGHgAhNGyIEIAAoAnAgBUEDdGooAgAiBSAAKAJoKAKIA2siCUEAIAUgCU8bIgUgBCAFSRsiBQ0DDAkLIAUgBEHo3sAAEJYCAAsgACgCgAEiBEUNByACIAQgAiAESRshBQwCC0EgIAAoAqQBIghrIgVBACAFQSBNGyIFRQ0GCyACIAUgAiAFSRshBSADQQFHDQEgACgCgAEhBAsgACAEIAVrNgKAAQwBCyAAKAKcASAIayAFSQRAIDsgCCAFQQFBARDaASAAKAKkASEICyAFBEAgACgCoAEgCGogASAF/AoAAAsgACAFIAhqNgKkASAAKAJgQQNHDQAgACgCaCIDIAMoAogDIAVqNgKIAwsgASAFaiEBIAIgBWshAgwFC0EBQYeACBDPAgALEIsDAAtB59/AAEEbELACIQMMBAsgAEECNgJgDAALAAsACyALIAtB4ABqrUKAgICAgAOENwOwAyALQQhqIgBB1OjAACALQbADahD/ASAAELUCIQMLIAtB8AZqJAAgAw8LQeiOwgBBLkGYj8IAENYCAAtBqI/CAEEuQdiPwgAQ1gIAC+ZKAhR/A30jAEEQayISJAACQAJAAkAgACgCtAFBf0cEQCAAQbQBaiEUA0ACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAAtANABQQFrDgYODQwLABgBC0EJIQpBBiEBIAAoAsgBDgQRBAMCAQsgACgCsAEiASAAKALcUyILTwRAIAAoAqwBIAEgC2siDEEGQQkgACgCwAEiA0EBRhsiDm4iASAAKALEASAAKALMAWsiBkkEQCABIgZBgIAESQ0YCyALaiENQYCABCAGIAZBgIAETxsiCEEDbCICIAAoArwBIgFLBH8gAiABIglrIgogACgCtAEgAWtLBEAgFCABIApBBEEEENoBIAAoArwBIQkLIAAoArgBIAlBAnRqIQMCQCAKQQJJBEAgAyEBDAELQQEhEwJAAkAgAiABQX9zaiIEQQRJBEAgAyEBDAELIARBfHEiAkEBciETIAMgAkECdGohASACIQUDQCAD/QwAAAAAAAAAAAAAAAAAAAAA/QsCACADQRBqIQMgBUEEayIFDQALIAIgBEYNAQsgCiATayEDA0AgAUEANgIAIAFBBGohASADQQFrIgMNAAsLIAkgCmpBAWshCQsgAUEANgIAIAAgCUEBajYCvAEgACgCwAEFIAMLQQFHDQ4gBkUND0EAIQNBACECQQAhBUEAIQcDQCAMIANBAmoiCkkEQCADIAogDEGo2MAAEKEBAAsCfyADIA1qIhBBAWotAABBCHQiCyAQLQAAciIBQf//AXFFBEAgAUEQdAwBCyABQf8HcSEJIAtBgIACcSEEIAtBgPgBcSIBQYD4AUYEQCAEQRB0IQEgAUGAgID8B3IgCUUNARogCUENdCABckGAgID+B3IMAQsgBEEQdCEEIAFBDXRBgICA/ABxIAlBDXRyQYCAgMADaiAEciABDQAaIAkgCWdBEGsiAUH//wNxQQhqdEH///8DcSAEQYCAgNgDciABQRd0a3ILIQQCfwJAAkAgACgCvAEiASAFSwRAIAAoArgBIAJqIAQ2AgAgA0EEaiIJIAxLDQEgEEEDai0AAEEIdCILIBBBAmotAAByIgFB//8BcUUEQCABQRB0DAQLIAFB/wdxIQogC0GAgAJxIQQgC0GA+AFxIgFBgPgBRgRAIARBEHQhASABQYCAgPwHciAKRQ0EGiAKQQ10IAFyQYCAgP4HcgwECyAEQRB0IQQgAUUNAiABQQ10QYCAgPwAcSAKQQ10ckGAgIDAA2ogBHIMAwsgBSABQdjXwAAQlgIACyAKIAkgDEGY2MAAEKEBAAsgCiAKZ0EQayIBQf//A3FBCGp0Qf///wNxIARBgICA2ANyIAFBF3RrcgshBAJ/AkACQCAFQQFqIgsgACgCvAEiAUkEQCAAKAK4ASACakEEaiAENgIAIANBBmoiAyAMSw0BIBBBBWotAABBCHQiCyAQQQRqLQAAciIBQf//AXFFBEAgAUEQdAwECyABQf8HcSEJIAtBgIACcSEEIAtBgPgBcSIBQYD4AUYEQCAEQRB0IQEgAUGAgID8B3IgCUUNBBogCUENdCABckGAgID+B3IMBAsgBEEQdCEEIAFFDQIgAUENdEGAgID8AHEgCUENdHJBgICAwANqIARyDAMLIAsgAUHo18AAEJYCAAsgCSADIAxBiNjAABChAQALIAkgCWdBEGsiAUH//wNxQQhqdEH///8DcSAEQYCAgNgDciABQRd0a3ILIQEgBUECaiILIAAoArwBIgRJBEAgACgCuAEgAmpBCGogATYCACACQQxqIQIgBUEDaiEFIAdBAWoiByAISQ0BDBELCyALIARB+NfAABCWAgALIAsgASABQZjZwAAQoQEACyAAKALcUyIFIAAoArABIgFLDQNByNfAABD9AgALQS0hCgwBC0EYIQoLIAAoArABIgEgACgC3FMiBUkNACAAKAKsASABIAVrIg8gCm4iASAAKALEASAAKALMAWsiA0kEQCABIgNBgIAESQ0TC0GAgAQgAyADQYCABE8bIhAgCmwiDSAAKAK8ASIBSwRAIAEhAiANIAFrIgcgACgCtAEgAWtLBEAgFCABIAdBBEEEENoBIAAoArwBIQILIAAoArgBIgggAkECdGohCSAHQQJJBH8gAgUgDSABQX9zakECdCIGBEAgCUEAIAb8CwALIAggAiANaiABa0ECdGpBBGshCSACIAdqQQFrCyEHIAlBADYCACAAIAdBAWoiATYCvAELIBBBCWwhDiADRQ0DIBBB4ABsIQYgEEEYbCEHQQAhCyAFaiIRIRNBACEJA0AgCSAKbCIDIA9PDQUCQAJAAkAgCUEJbCIBIAAoArwBIgVPDQAgACgCuAEgAUECdGogAyARaiIMLQAAs0MAAADDkkMAAAA8lDgCACAPIANBA2oiCE0EQCAIIQMMCQsgAUEDaiICIAAoArwBIgVPBEAgAiEBDAELIAAoArgBIAJBAnRqIAggEWotAACzQwAAAMOSQwAAADyUOAIAIA8gA0EGaiIITQRAIAghAwwJCyABQQZqIgIgACgCvAEiBU8EQCACIQEMAQsg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AgAgAmoiAiAAIAFrakEIaiIBNgIAIAQgAUEBcjYCBCAAIAJqQSg2AgRBwLXCAEGAgIABNgIADAMLQbS1wgAgADYCAEGstcIAQay1wgAoAgAgBWoiATYCACAAIAFBAXI2AgQMAQtBsLXCACAANgIAQai1wgBBqLXCACgCACAFaiIBNgIAIAAgAUEBcjYCBCAAIAFqIAE2AgALIAJBCGoPC0EAIQBBrLXCACgCACIBIAVNDQBBrLXCACABIAVrIgE2AgBBtLXCAEG0tcIAKAIAIgAgBWoiAjYCACACIAFBAXI2AgQgACAFQQNyNgIEDAELIAAPCyAAQQhqC+EXAhl/AnwjAEGwBGsiAyQAIANCADcDmAEgA0IANwOQASADQgA3A4gBIANCADcDgAEgA0IANwN4IANCADcDcCADQgA3A2ggA0IANwNgIANCADcDWCADQgA3A1AgA0IANwNIIANCADcDQCADQgA3AzggA0IANwMwIANCADcDKCADQgA3AyAgA0IANwMYIANCADcDECADQgA3AwggA0IANwMAIANCADcDuAIgA0IANwOwAiADQgA3A6gCIANCADcDoAIgA0IANwOYAiADQgA3A5ACIANCADcDiAIgA0IANwOAAiADQgA3A/gBIANCADcD8AEgA0IANwPoASADQgA3A+ABIANCADcD2AEgA0IANwPQASADQgA3A8gBIANCADcDwAEgA0IANwO4ASADQgA3A7ABIANCADcDqAEgA0IANwOgASADQgA3A9gDIANCADcD0AMgA0IANwPIAyADQgA3A8ADIANCADcDuAMgA0IANwOwAyADQgA3A6gDIANCADcDoAMgA0IANwOYAyADQgA3A5ADIANCADcDiAMgA0IANwOAAyADQgA3A/gCIANCADcD8AIgA0IANwPoAiADQgA3A+ACIANCADcD2AIgA0IANwPQAiADQgA3A8gCIANCADcDwAIgA0HgA2pBAEHQAPwLAEGQrcIAKAIAIgkhBiACQQNrQRhtIgVBACAFQQBKGyILIQUgC0ECdEGgrcIAaiEHA0AgAyAEQQN0aiAFQQBIBHxEAAAAAAAAAAAFIAcoAgC3CzkDACAEIAZJIgoEQCAHQQRqIQcgBUEBaiEFIAQgCmoiBCAGTQ0BCwtBACEFA0BBACEEIANBwAJqIAVBA3RqIBwgACAEQQN0aisD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DQYLIAAgBzoABCAAQQA2AgAMAwsgACgCAEUEQCAAKAIQIgZFDQFBASEEIAZB0dzBAEEBEGBFDQEMBQsgAyAAEFcgAygCAEUEQCADLQAEIQcgACgCECIGBEBBASEEIAZBuNzBAEGo3MEAIAdBAXEiBhtBGUEQIAYbEGANBgsgACAHOgAEIABBADYCAAwDCyADIAP9AAIA/QsDEAJAIAAoAhAiBEUNACADQRBqIAQQOg0EIAAoAhAiBEUNACAEQfrewQBBAhBgDQQLQQEhBCAAQQEQLQ0ECyAHQQFrIQcgACgCACIEDQALC0EAIQQMAQtBASEECyADQSBqJAAgBA0IIAAoAhAiA0UNBSADQfngwQBBAhBgRQ0BDAgLQQEhAiAAQQEQLQ0HCyABDQMgACgCECIBRQ0DQQEhAiABQYXfwQBBARBgRQ0DDAYLQQAhAiAAQQA6AAQgAEEANgIADAULQQAhAiAAQQA2AgAMBAsgACADEKIBDQELQQAhAiAAKAIARQ0CIAAgACgCDEEBazYCDAwCC0EBIQIMAQtBACECCyAFQSBqJAAgAgu6CgEEfwJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgACgCAA4KAAYGAQIDBAYGBQYLAkACQAJAAkACQCAALQAEDgcACgEKAgMECgsgAC0ACEEDRw0JIAAoAgwiACgCACEBIABBBGooAgAiAigCACIDBEAgASADEQIACyACKAIEIgNFDQsgASADIAIoAggQgwIMCwsgAC0ACEEDRw0IIAAoAgwiACgCACEBIABBBGooAgAiAigCACIDBEAgASADEQIACyACKAIEIgNFDQogASADIAIoAggQgwIMCgsgAC0ACEEDRw0HIAAoAgwiACgCACEBIABBBGooAgAiAigCACIDBEAgASADEQIACyACKAIEIgNFDQkgASADIAIoAggQgwIMCQsgAC0ACEEDRw0GIAAoAgwiACgCACEBIABBBGooAgAiAigCACIDBEAgASADEQIACyACKAIEIgNFDQggASADIAIoAggQgwIMCAsgAC0ACEEDRw0FIAAoAgwiACgCACEBIABBBGooAgAiAigCACIDBEAgASADEQIACyACKAIEIgNFDQcgASADIAIoAggQgwIMBwsCQAJAIAAtAAQOAgYBAAsgACgCCCIBQYSAgIB4SyABQQBMcg0F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DBEAAAwCCyABKAIAQamGwgBBPSABKAIEKAIMEQAADAELIAEoAgBB5obCAEHPACABKAIEKAIMEQAACyACQSBqJAALvQUBBX8gAEHoAGogARCRASAAQZABaiABQShqEJEBIABBuAFqIAFB0ABqEJEBIABBADoAZCAAQQA2AhQgAEEANgIIIABBADYCXCAAQQA2AjggAEEANgIsIABBADYCICAAQQA2AlAgAEEAOgBhIABBADYCRCAAIAEvAXg7AeABIAAgASgBejYB4gEgASgChAEhBQJAAkAgASgCiAEiBCAAKAIASwRAIABBACAEQQFBAhDaASAAKAIUIQMgACgCCCECDAELIARFDQELIARBAXQiBgRAIAAoAgQgAkEBdGogBSAG/AoAAAsLIAAgAiAEajYCCCABKAKQASEEAkACQCABKAKUASICIAAoAgwgA2tLBEAgAEEMaiADIAJBAUEBENoBIAAoAhQhAwwBCyACRQ0BCyACRQ0AIAAoAhAgA2ogBCAC/AoAAAsgACACIANqNgIUIAAgAS0A5AE6AGQgASgCnAEhBAJAAkAgASgCoAEiAiAAKAIYIAAoAiAiA2tLBEAgAEEYaiADIAJBAUEBENoBIAAoAiAhAwwBCyACRQ0BCyACRQ0AIAAoAhwgA2ogBCAC/AoAAAsgACACIANqNgIgIAEoArQBIQQCQAJAIAEoArgBIgIgACgCMCAAKAI4IgNrSwRAIABBMGogAyACQQRBBBDaASAAKAI4IQMMAQsgAkUNAQsgAkECdCIFRQ0AIAAoAjQgA0ECdGogBCAF/AoAAAsgACACIANqNgI4IABBPGogAUG8AWoQkQFBACECIABBADYCjAIgACABKAKAAjYCvAIgACABKQL4ATcCtAIgASgC7AEhAwJAAkAgASgC8AEiASAAKAKEAksEQCAAQYQCakEAIAFBAUEBENoBIAAoAowCIQIMAQsgAUUNAQsgAUUNACAAKAKIAiACaiADIAH8CgAACyAAIAEgAmo2AowCC9AEAgZ+BH8gACAAKAI4IAJqNgI4AkAgACgCPCILRQRADAELQQQhCQJ+QQggC2siCiACIAIgCksbIgxBBEkEQEEAIQlCAAwBCyABNQAACyEDIAwgCUEBcksEQCABIAlqMwAAIAlBA3SthiADhCEDIAlBAnIhCQsgACAAKQMwIAkgDEkEfiABIAlqMQAAIAlBA3SthiADhAUgAwsgC0EDdK2GhCIDNwMwIAIgCk8EQCAAIAApAxggA4UiBCAAKQMIfCIGIAApAxAiBUINiSAFIAApAwB8IgWFIgd8IgggB0IRiYU3AxAgACAIQiCJNwMIIAAgBiAEQhCJhSIEQhWJIAQgBUIgiXwiBIU3AxggACADIASFNwMADAELIAAgAiALajYCPA8LIAIgCmsiAkEHcSEJIAJBeHEiAiAKSwRAIAApAwghBCAAKQMQIQMgACkDGCEGIAApAwAhBQNAIAQgBiABIApqKQAAIgeFIgZ8IgQgAyAFfCIFIANCDYmFIgN8IgggA0IRiYUhAyAEIAZCEImFIgRCFYkgBCAFQiCJfCIFhSEGIAhCIIkhBCAFIAeFIQUgCkEIaiIKIAJJDQALIAAgAzcDECAAIAY3AxggACAENwMIIAAgBTcDAAtBBCECAn4gCUEESQRAQQAhAkIADAELIAEgCmo1AAALIQMgCSACQQFySwRAIAEgCmogAmozAAAgAkEDdK2GIAOEIQMgAkECciECCyAAIAIgCUkEfiABIAIgCmpqMQAAIAJBA3SthiADhAUgAws3AzAgACAJNgI8C+sDAQR/IAAQjwECQAJAIAAoAoQBIgIEQCAAKAKIASIDQQRrKAIAIgFBeHEiBEEEQQggAUEDcSIBGyACakkNASABQQAgBCACQSdqSxsNAiADEEELIAAoApABIgIEQCAAKAKUASIDQQRrKAIAIgFBeHEiBEEEQQggAUEDcSIBGyACakkNASABQQAgBCACQSdqSxsNAiADEEELIAAoApwBIgIEQCAAKAKgASIDQQRrKAIAIgFBeHEiBEEEQQggAUEDcSIBGyACakkNASABQQAgBCACQSdqSxsNAiADEEELIAAoAmBBA0YEQCAAKAJsIgIEQCAAKAJwIgNBBGsoAgAiAUF4cSIEIAJBA3QiAkEEQQggAUEDcSIBG2pJDQIgAUEAIAQgAkEnaksbDQMgAxBBCyAAKAJoED4LIAAoAqgBIgIEQCAAKAKsASIDQQRrKAIAIgFBeHEiBEEEQQggAUEDcSIBGyACakkNASABQQAgBCACQSdqSxsNAiADEEELIAAoArQBIgJBAEoEQCAAKAK4ASIAQQRrKAIAIgNBeHEiASACQQJ0IgJBBEEIIANBA3EiAxtqSQ0BIANBACABIAJBJ2pLGw0CIAAQQQsPC0HojsIAQS5BmI/CABDWAgALQaiPwgBBLkHYj8IAENYCAAurBQIGfwF+AkAgAkUNACACQQdrIgNBACACIANPGyEHIAFBA2pBfHEgAWshCEEAIQMDQAJAAkACQCABIANqLQAAIgXAIgZBAE4EQCAIIANrQQNxDQEgAyAHTw0CA0AgASADaiIEQQRqKAIAIAQoAgByQYCBgoR4cQ0DIANBCGoiAyAHSQ0ACwwCC0KAgICAkCAhCQJAAkACQAJAAkACQAJAAkACQCAFLQD1hkFBAmsOAwABAgcLIANBAWoiBCACSQ0CQgAhCQwGCyADQQFqIgQgAkkNAkIAIQkMBQsgA0EBaiIEIAJJDQJCACEJDAQLIAEgBGosAABBv39KDQMMBAsgASAEaiwAACEEAkACQCAFQeABayIFBEAgBUENRgRADAIFDAMLAAsgBEFgcUGgf0YNAwwECyAEQZ9/Sg0DDAILIAZBH2pB/wFxQQxPBEAgBkF+cUFuRw0DIARBQEgNAgwDCyAEQUBIDQEMAgsgASAEaiwAACEEAkACQAJAAkAgBUHwAWsOBQEAAAACAAsgBkEPakH/AXFBAksNBCAEQUBIDQIMBAsgBEHwAGpB/wFxQTBJDQEMAwsgBEGPf0oNAgsgAiADQQJqIgRNBEBCACEJDAILIAEgBGosAABBv39KBEBCgICAgJDAACEJDAILQgAhCSADQQNqIgQgAk8NASABIARqLAAAQUBIDQJCgICAgJDgACEJDAELQgAhCSADQQJqIgQgAk8NACABIARqLAAAQb9/TA0BQoCAgICQwAAhCQsgACAJIAOthDcCBCAAQQE2AgAPCyAEQQFqIQMMAgsgA0EBaiEDDAELIAIgA00NAANAIAEgA2osAABBAEgNASACIANBAWoiA0cNAAsMAgsgAiADSw0ACwsgACACNgIIIAAgATYCBCAAQQA2AgAL3AUBA38jAEEgayIDJAAgAAJ/AkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCABDigCAQEBAQEBAQEDBQEBBAEBAQEBAQEBAQEBAQEBAQEBAQEBCAEBAQEHAAsgAUHcAEYNBQsgAkEBcUUgAUGABklyDQcgARCWAUUNByADQQA6AA4gA0EAOwEMIAMgAUEUdi0A/N1BOgAPIAMgAUEEdkEPcS0A/N1BOgATIAMgAUEIdkEPcS0A/N1BOgASIAMgAUEMdkEPcS0A/N1BOgARIAMgAUEQdkEPcS0A/N1BOgAQIAFBAXJnQQJ2IgIgA0EMaiIEaiIFQfsAOgAAIAVBAWtB9QA6AAAgBCACQQJrIgJqQdwAOgAAIAAgAykBDDcAACADQf0AOgAVIAMgAUEPcS0A/N1BOgAUIAAgAy8BFDsACAwICyAAQgA3AQIgAEHc4AA7AQAMCgsgAEIANwECIABB3OgBOwEADAkLIABCADcBAiAAQdzkATsBAAwICyAAQgA3AQIgAEHc3AE7AQAMBwsgAEIANwECIABB3LgBOwEADAYLIAJBgAJxRQ0BIABCADcBAiAAQdzOADsBAAwFCyACQf///wdxQYCABE8NAwsgARBNDQEgA0EAOgAYIANBADsBFiADIAFBFHYtAPzdQToAGSADIAFBBHZBD3EtAPzdQToAHSADIAFBCHZBD3EtAPzdQToAHCADIAFBDHZBD3EtAPzdQToAGyADIAFBEHZBD3EtAPzdQToAGiABQQFyZ0ECdiICIANBFmoiBGoiBUH7ADoAACAFQQFrQfUAOgAAIAQgAkECayICakHcADoAACAAIAMpARY3AAAgA0H9ADoAHyADIAFBD3EtAPzdQToAHiAAIAMvAR47AAgLQQoMAwsgACABNgIAQYABIQJBgQEMAgsgAEIANwECIABB3MQAOwEAC0EAIQJBAgs6AA0gACACOgAMIANBIGokAAvYAwEHfyAAKAKwASEBAkACQCAAKAK0ASIFBEAgASECA0AgAkEoaigCACIGBEAgAkEsaigCACIHQQRrKAIAIgRBeHEiA0EEQQggBEEDcSIEGyAGakkNAyAEQQAgAyAGQSdqSxsNBCAHEEELIAIQhwEgAkE4aiECIAVBAWsiBQ0ACwsgACgCrAEiBARAIAFBBGsoAgAiAkF4cSIDIARBOGwiBEEEQQggAkEDcSICG2pJDQEgAkEAIAMgBEEnaksbDQIgARBBCyAAKAKYASIDBEAgACgCnAEiBEEEaygCACIBQXhxIgJBBEEIIAFBA3EiARsgA2pJDQEgAUEAIAIgA0EnaksbDQIgBBBBCyAAQfAAahCHASAAKAIoIgNBf0cEQCADBEAgACgCLCIEQQRrKAIAIgFBeHEiAkEEQQggAUEDcSIBGyADakkNAiABQQAgAiADQSdqSxsNAyAEEEELIAAQhwELIAAoAmAiA0F/RwRAIAMEQCAAKAJkIgRBBGsoAgAiAUF4cSICQQRBCCABQQNxIgEbIANqSQ0CIAFBACACIANBJ2pLGw0DIAQQQQsgAEE4ahCHAQsPC0HojsIAQS5BmI/CABDWAgALQaiPwgBBLkHYj8IAENYCAAvYBAIHfwF7AkACQCAAKAIIIgdBgICAwAFxRQ0AAkACQAJAAkAgB0GAgICAAXEEQCAALwEOIgMNAUEAIQIMAgsgAkEQTwRAIAEgAhBMIQMMBAsgAkUEQAwECyACQQNxIQUgAkEETwRAIAJBDHEhBgNAIAMgASAEav1cAAD9DL+/v7+/v7+/v7+/v7+/v7/9JyIK/RsAQQFxaiAK/YcB/acBIgr9GwFrIAr9GwJrIAr9GwNrIQMgBiAEQQRqIgRHDQALIAVFDQQLIAEgBGohBANAIAMgBCwAAEG/f0pqIQMgBEEBaiEEIAVBAWsiBQ0ACwwDCyABIAJqIQlBACECIAEhBCADIQUDQCAEIgYgCUYNAgJ/IARBAWogBCwAACIIQQBODQAaIAZBAmogCEFgSQ0AGiAGQQRBAyAIQW9LG2oLIgQgBmsgAmohAiAFQQFrIgUNAAsLQQAhBQsgAyAFayEDCyADIAAvAQwiBE8NACAEIANrIQZBACEDQQAhBQJAAkACQCAHQR12QQNxQQFrDgIAAQILIAYhBQwBCyAGQf7/A3FBAXYhBQsgB0H///8AcSEIIAAoAgQhByAAKAIAIQADQCADQf//A3EgBUH//wNxSQRAQQEhBCADQQFqIQMgACAIIAcoAhARAQBFDQEMAwsLQQEhBCAAIAEgAiAHKAIMEQAADQEgBiAFa0H//wNxIQFBACEDA0AgASADQf//A3FNBEBBAA8LIANBAWohAyAAIAggBygCEBEBAEUNAAsMAQsgACgCACABIAIgACgCBCgCDBEAACEECyAEC9MEAQR/An8CQAJAAkACQEMAAHpEQwAAAAAgAiACQwAAAABdGyICIAJDAAB6RF4bIgJDAACAP15FBEAgArwiBkH///8DcSEFIAZBgICAgHhxIQMgBkGAgID8B3EiBEGAgID8B0YEQCADQRB2IAVBDXZyQYAEQQAgBRtyQYD4AXIhAwwFCyADQRB2IQMgBEGAgIC4BEsNASAEQYCAgMQDTwRAIAZBDHYgBkH/3wBxQQBHcSAEQQ12IAVBDXZqQYCAAWogA3JqIQMMBQsgBEGAgICYA0kNBCAFQYCAgARyIgZB/gAgBEEXdiIFa3YhBCAGQR0gBWsiBXZBAXEEfyAEQQMgBXRBAWsgBnFBAEdqBSAECyADciEDDAQLIAIQvQEQ4QGRQwAAgL+SQwAAgD6UvCIGQf///wNxIQUgBkGAgICAeHEhAyAGQYCAgPwHcSIEQYCAgPwHRgRAIANBEHYgBUENdnJBgARBACAFG3JBgPgBciEDDAMLIANBEHYhAyAEQYCAgLgESw0BIARBgICAxANPBEAgBkEMdiAGQf/fAHFBAEdxIARBDXYgBUENdmpBgIABaiADcmohAwwDCyAEQYCAgJgDSQ0CIAVBgICABHIiBkH+ACAEQRd2IgVrdiEEIAZBHSAFayIFdkEBcQR/IARBAyAFdEEBayAGcUEAR2oFIAQLIANyIQMMAgsgA0GA+AFyIQMMAgsgA0GA+AFyIQMLIANBEHRBgPgAcgwBCyADQf//A3ELIQQgAUEESQRAQQNBA0GUwsEAEJYCAAsgACAENgIMC+sEAgR9A38jAEEQayEHAkACQAJAAn0CfQJAIABDO6q4P5QCfQJAIAC8IgZB/////wdxIgVBw/DWjARNBEAgBUGY5MX1A0sNASAFQYCAgJgDSQ0GQQAhBUMAAAAADAULIABDAACAvyAFQYCAgPwHSyIHGyEBIAZBAEggB3INB0MAAAA/IAVBmOTFlQRJDQEaIABDAAAAf5QPCyAFQZKrlPwDSQ0BQwAAAL9DAAAAPyAGQQBIGwuS/AAiBbIiAkPR9xc3lCEBIAAgAkOAcTG/lJIMAQsgBkEATgRAQ9H3FzchAUEBIQUgAEOAcTG/kgwBC0PR9xe3IQFBfyEFIABDgHExP5ILIgIgAiABkyIAkyABkwshAiAAIABDAAAAP5QiA5QiASABIAFDEDDPOpRDaIgIvZKUQwAAgD+SIgRDAABAQCADIASUkyIDk0MAAMBAIAAgA5STlZQhAyAFDQEgACAAIAOUIAGTkw8LIAVBgICABE8EQCAADwsgByAAIACUOAIMIAcqAgwaIAAPCyAAIAMgApOUIAKTIAGTIQECQAJAAkAgBUEBag4DAAIBAgsgACABk0MAAAA/lEMAAAC/kg8LIABDAACAvl1FBEAgACABkyIAIACSQwAAgD+SDwsgASAAQwAAAD+Sk0MAAADAlA8LIAVBF3QiBkGAgID8A2q+IQIgBUE5TwRAIAAgAZNDAACAP5IiACAAkkMAAAB/lCAAIAKUIAVBgAFGG0MAAIC/kg8LQYCAgPwDIAZrviEDIAVBF08EfSAAIAEgA5KTQwAAgD+SBUMAAIA/IAOTIAAgAZOSCyAClCEBCyABC64EAQt/IAAoAgQhCSAAKAIAIQogACgCCCELAkADQCAGDQECfwJAIAIgBEkNAANAIAEgBGohBQJAAkACQAJAAkAgAiAEayIGQQdNBEAgAiAERw0BIAIhBAwHCyAFQQNqQXxxIgAgBUYNASAAIAVrIQNBACEAA0AgACAFai0AAEEKRg0FIAMgAEEBaiIARw0ACyADIAZBCGsiAEsNAwwCC0EAIQADQCAAIAVqLQAAQQpGDQQgBiAAQQFqIgBHDQALIAIhBAwFCyAGQQhrIQBBACEDCwNAQYCChAggAyAFaiIHKAIAIg1BipSo0ABzayANckGAgoQIIAdBBGooAgAiB0GKlKjQAHNrIAdycUGAgYKEeHFBgIGChHhHDQEgA0EIaiIDIABNDQALCyADIAZGBEAgAiEEDAMLIAMgBWohBiACIANrIARrIQdBACEAAkADQCAAIAZqLQAAQQpGDQEgByAAQQFqIgBHDQALIAIhBAwDCyAAIANqIQALIAAgBGoiA0EBaiEEAkAgAiADTQ0AIAAgBWotAABBCkcNAEEAIQYgBCIFDAMLIAIgBE8NAAsLIAIgCEYNAkEBIQYgCCEFIAILIQACQCALLQAABEAgCkG9rMEAQQQgCSgCDBEAAA0BC0EAIQMgACAIRwRAIAAgAWpBAWstAABBCkYhAwsgACAIayEAIAEgCGohByALIAM6AAAgBSEIIAogByAAIAkoAgwRAABFDQELC0EBIQwLIAwLoQUBBX8jAEEgayICJAACQAJAAkACQCAAKAIAIgMtAABBAWsOAgECAAsgAiADQQFqNgIAIAEoAgBBvf3BAEELIAEoAgQoAgwRAAAhACACQQA6ABUgAiAAOgAUIAIgATYCECACQRBqQZ39wQBBAyACQdUAEKQBIAItABUiAyACLQAUIgRyIQAgBEEBcSADQQFHcg0CKAIAIgAtAApBgAFxRQRAIAAoAgBB+eDBAEECIAAoAgQoAgwRAAAhAAwDCyAAKAIAQYXfwQBBASAAKAIEKAIMEQAAIQAMAgtBASEAIAEoAgAiBEHI/cEAQQ0gASgCBCIGKAIMIgURAAANASADQQRqIQMCQCABLQAKQYABcUUEQCAEQeHgwQBBASAFEQAADQMgAyABEFRFDQEMAwsgBEGh/sAAQQIgBREAAA0CIAJBAToADyACIAY2AgQgAiAENgIAIAJBmITBADYCFCACIAEpAgg3AhggAiACQQ9qNgIIIAIgAjYCECADIAJBEGoQVA0CIAIoAhBBn/7AAEECIAIoAhQoAgwRAAANAgsgASgCAEHy3sEAQQEgASgCBCgCDBEAACEADAELQQEhACABKAIAIgRB1f3BAEERIAEoAgQiBigCDCIFEQAADQAgA0EEaiEDAkAgAS0ACkGAAXFFBEAgBEHh4MEAQQEgBREAAA0CIAMgARAmRQ0BDAILIARBof7AAEECIAURAAANASACQQE6AA8gAiAGNgIEIAIgBDYCACACQZiEwQA2AhQgAiABKQIINwIYIAIgAkEPajYCCCACIAI2AhAgAyACQRBqECYNASACKAIQQZ/+wABBAiACKAIUKAIMEQAADQELIAEoAgBB8t7BAEEBIAEoAgQoAgwRAAAhAAsgAkEgaiQAIABBAXELiwUBBX8jAEEgayICJABBASEDAkACQAJAAkBBASAALQAAIgRBAmsgBEEBTRtB/wFxQQFrDgIBAgALIAIgAEEBajYCACABKAIAQZaBwgBBGSABKAIEKAIMEQAAIQAgAkEAOgAVIAIgADoAFCACIAE2AhAgAkEQakGd/cEAQQMgAkHOABCkASACLQAVIgEgAi0AFCIEciEDIARBAXEgAUEBR3INAigCACIALQAKQYABcUUEQCAAKAIAQfngwQBBAiAAKAIEKAIMEQAAIQMMAwsgACgCAEGF38EAQQEgACgCBCgCDBEAACEDDAILIAEoAgAiBEGM/sEAQQwgASgCBCIGKAIMIgURAAANAQJAIAEtAApBgAFxRQRAIARB4eDBAEEBIAURAAANAyAAIAEQigFFDQEMAwsgBEGh/sAAQQIgBREAAA0CIAJBAToADyACIAY2AgQgAiAENgIAIAJBmITBADYCFCACIAEpAgg3AhggAiACQQ9qNgIIIAIgAjYCECAAIAJBEGoQigENAiAC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DAELIAEoAgBB+fzBAEEKIAEoAgQoAgwRAAAhAwsgAkEgaiQAIANBAXELlAMAIAAgBGohAAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAFB/wFxQQFrDgcHAAECAwQFBgsgAEF9TSAAQQJqIgEgA01xDQcgACABIANBxMDBABChAQALIABBfU0gAEECaiIBIANNcQ0HIAAgASADQdTAwQAQoQEACyAAQXtNIABBBGoiASADTXENByAAIAEgA0HkwMEAEKEBAAsgAEF7TSAAQQRqIgEgA01xDQcgACABIANB9MDBABChAQALIABBe00gAEEEaiIBIANNcQ0HIAAgASADQYTBwQAQoQEACyAAQXdNIABBCGoiASADTXENByAAIAEgA0GUwcEAEKEBAAsgACADSQ0IIAAgA0GkwMEAEJYCAAsgACADSQ0GIAAgA0G0wMEAEJYCAAsgACACai4AALIPCyAAIAJqLwAAsw8LIAAgAmooAACyDwsgACACaigAALMPCyAAIAJqKgAADwsgACACaisAALYPCyAAIAJqLQAAs0MAAH9DlQ8LIAAgAmosAACyQwAAf0OVC4EDAAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIABB/wFxQQFrDgcHAAECAwQFBgsgA0F9TSADQQJqIgAgAk1xDQcgAyAAIAJBxL/BABChAQALIANBfU0gA0ECaiIAIAJNcQ0HIAMgACACQdS/wQAQoQEACyADQXtNIANBBGoiACACTXENByADIAAgAkHkv8EAEKEBAAsgA0F7TSADQQRqIgAgAk1xDQcgAyAAIAJB9L/BABChAQALIANBe00gA0EEaiIAIAJNcQ0HIAMgACACQYTAwQAQoQEACyADQXdNIANBCGoiACACTXENByADIAAgAkGUwMEAEKEBAAsgAiADTQ0HIAEgA2osAACyDwsgAiADSw0HIAMgAkG0v8EAEJYCAAsgASADai4AALIPCyABIANqLwAAsw8LIAEgA2ooAACyDwsgASADaigAALMPCyABIANqKgAADwsgASADaisAALYPCyADIAJBpL/BABCWAgALIAEgA2otAACzC+cCAQV/AkAgAUHN/3tBECAAIABBEE0bIgBrTw0AIABBECABQQtqQXhxIAFBC0kbIgRqQQxqECAiAkUNACACQQhr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QQF0LwCthUE7AAAgAkEEayECIAZB/6ziBEsNAAsLIABBCUsEQCACQQJrIgIgA0EGamogACAAQf//A3FB5ABuIgBB5ABsa0H//wNxQQF0LwCthUE7AAALQQAgBCAAG0UEQCACQQFrIgIgA0EGamogAEEBdC0AroVBOgAACyABQQFBAUEAIANBBmogAmpBCiACaxBrIANBEGokAAucAgACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgAEH/AXFBAWsOBwUAAQICAgMECyADQX1NIANBAmoiACACTXENBSADIAAgAkHEwcEAEKEBAAsgA0F9TSADQQJqIgAgAk1xDQUgAyAAIAJB1MHBABChAQALIANBe00gA0EEaiIAIAJNcQ0FIAMgACACQeTBwQAQoQEACyADQXdNIANBCGoiACACTXENBSADIAAgAkH0wcEAEKEBAAsgAiADTQ0FIAEgA2osAAAPCyACIANLDQUgAyACQbTBwQAQlgIACyABIANqLgAADwsgASADai8AAA8LIAEgA2ooAAAPCyABIANqKwAA/AMPCyADIAJBpMHBABCWAgALIAEgA2otAAAL2gIBAn8jAEHg0QBrIgMkAAJAAkACQCAAAn8gAQRAQYCACBAgIgRFDQIgBEEEay0AAEEDcQRAIARBAEGAgAj8CwALIANBIGpBAEHA0QD8CwBB5NMAECAiAUUNAyABIAJB2AD8CgAAIAFCgICAgHA3ArABIAFCgICAgBA3AqgBIAFCATcCoAEgAUKAgAg3ApgBIAEgBDYClAEgAUKAgICAgICAATcCjAEgAUKAgICAEDcChAEgAUEANgJgIAFBADYCWCABQbgBaiADQQRqQdzRAPwKAAAgAUGU0wBqQQBBwQD8CwAgAUEANgDfUyABQgA3AthTQfzJwAAMAQtB0AUQICIBRQ0DIAEgAkHYAPwKAAAgAUEANgLIBSABQoCAgIAQNwPABSABQX82ArQFQdzJwAALNgIEIAAgATYCACADQeDRAGokAA8LQQFBgIAIEM8CAAsQiwMACxCLAwALlAIBBX8jAEEQayIFJAAgACABIAIQnQECQCACBEAgAkECdCEIIAAoAjBBDGohASAEQQNqQXxxIQkgACgCNCEHQQAhAgNAIAJBA2ogB08NAgJAAkAgAiAJRg0AAkAgBCACayIGQQAgBCAGTxsiBkEB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IAZBIGogBRCkAgALIAZCgICAgJACIgcgBkEIaq2ENwMwIAYgByAGrYQ3AyggBiAGQRBqrUKAgICAoAKENwMgQbKMwAAgBkEgaiAFEKQCAAvrAQIBfgJ/IwBBEGsiAyQAIAAoAgAhAAJ/AkAgASgCCCIEQYCAgBBxRQRAIARBgICAIHENASAAIAEQpwEMAgsgACkDACECQREhAANAIAAgA2pBAmsgAqdBD3EtAPzdQToAACAAQQFrIQAgAkIEiCICQgBSDQALIAFBAUH+4MEAQQIgACADakEBa0ERIABrEGsMAQsgACkDACECQREhAANAIAAgA2pBAmsgAqdBD3EtALWuQToAACAAQQFrIQAgAkIEiCICQgBSDQALIAFBAUH+4MEAQQIgACADakEBa0ERIABrEGsLIANBEGokAAvaAQECfyMAQRBrIgMkAAJ/AkAgASgCCCICQYCAgBBxRQRAIAJBgICAIHENASAAIAEQqAEMAgsgACgCACECQQkhAANAIAAgA2pBBmogAkEPcS0A/N1BOgAAIABBAWshACACQQR2IgINAAsgAUEBQf7gwQBBAiAAIANqQQdqQQkgAGsQawwBCyAAKAIAIQJBCSEAA0AgACADakEGaiACQQ9xLQC1rkE6AAAgAEEBayEAIAJBBHYiAg0ACyABQQFB/uDBAEECIAAgA2pBB2pBCSAAaxBrCyADQRBqJAAL2gEBAn8jAEEQayIDJAACfwJAIAEoAggiAkGAgIAQcUUEQCACQYCAgCBxDQEgACABEJ4BDAILIAAoAgAhAkEJIQADQCAAIANqQQZqIAJBD3EtAPzdQToAACAAQQFrIQAgAkEEdiICDQALIAFBAUH+4MEAQQIgACADakEHakEJIABrEGsMAQsgACgCACECQQkhAANAIAAgA2pBBmogAkEPcS0Ata5BOgAAIABBAWshACACQQR2IgINAAsgAUEBQf7gwQBBAiAAIANqQQdqQQkgAGsQawsgA0EQaiQAC+8BAQN/IwBBIGsiAiQAIAEoAgQhAyABKAIAIQECfwJAAkACQAJAQQMgACgCACIAKAIAIgRBB2sgBEEGTRtBAWsOAwMAAQILIAIgAEEMajYCBCACIABBBGo2AhwgAiACQRxqrUKAgICAkAGENwMQIAIgAkEEaq1CgICAgIALhDcDCCABIANBt5nAACACQQhq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IAAgA2pBDGogAkEPcUG1rsEAai0AADoAACAAQQFrIQAgAkEEdiICDQALIAFBAUH+4MEAQQIgACADakENakEDIABrEGsgA0EQaiQADwsgAC0AACECIwBBEGsiAyQAQQMhAANAIAAgA2pBDGogAkEPcUH83cEAai0AADoAACAAQQFrIQAgAkEEdiICDQALIAFBAUH+4MEAQQIgACADakENakEDIABrEGsgA0EQaiQAC9wBAgF/AX4jAEEgayIDJAAgAyABNgIQIAMgADYCDCADQQE7ARwgAyACNgIYIAMgA0EMajYCFCMAQRBrIgEkACADQRRqIgApAgAhBCABIAA2AgwgASAENwIEIwBBEGsiACQAIAFBBGoiASgCACICKAIEIgNBAXEEQCACKAIAIQIgACADQQF2NgIEIAAgAjYCACAAQZCOwgAgASgCBCABKAIIIgAtAAggAC0ACRC5AQALIABBfzYCACAAIAE2AgwgAEGsjsIAIAEoAgQgASgCCCIALQAIIAAtAAkQuQEACzsBAX8jAEEQayIDJAAgAyABNgIEIAMgADYCACADIAOtQoCAgICgAoQ3AwhB2pnAACADQQhqIAIQpAIACz8BAn8gASgCBCECIAEoAgAhA0EIECAiAUUEQBCLAwALIAEgAjYCBCABIAM2AgAgAEHMk8IANgIEIAAgATYCAAs4AQF/IwBBEGsiAiQAIAJBCGogACAAKAIAKAIEEQMAIAIoAgggASACKAIMKAIQEQEAIAJBEGokAAs1AAJAIAJBf0YNACAAIAIgASgCEBEBAEUNAEEBDwsgA0UEQEEADwsgACADIAQgASgCDBEAAAs6AQF/AkAgACgChAEiAgRAIAIgASAAKAKIASgCEBEBACICDQELIAAgATYCBCAAQQE2AgBBACECCyACCz0BAX8gAC0AjAFBAkcEQCAAKAKEASIBBEAgASAAKAKIASgCGBEEAA8LQZjjwAAQ+wIAC0GE48AAQREQsAIL3gEBBH8jAEEQayICJAAgAiAANgIMIwBBEGsiACQAIAEoAgBBrObBAEENIAEoAgQoAgwRAAAhAyAAQQA6AA0gACADOgAMIAAgATYCCCAAQQhqQcKYwgBBBCACQQxqQcwAEKQBIQMgAC0ADSIEIAAtAAwiBXIhAQJAIAVBAXEgBEEBR3INACADKAIAIgEtAApBgAFx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SQsQACAAKAIAIAAoAgQgARBJCxMAIABBqOPAADYCBCAAIAE2AgALEAAgASAAKAIEIAAoAggQYAsTACAAQbTowAA2AgQgACABNgIACxMAIABB1OnAADYCBCAAIAE2AgALEwAgAEEoNgIEIABBmMrBADYCAAsTACAAQYSywQA2AgQgACABNgIACxMAIABBwLLBADYCBCAAIAE2AgALEwAgAEH8ssEANgIEIAAgATYCAAsTACAAQcyTwgA2AgQgACABNgIACxYAQYi2wgAgADYCAEGEtsIAQQE6AAALEQEBfxCgASIBIAAlASYBIAELDwBBgIXBAEErIAAQ1gIACxIAQZTqwABBI0Go6sAAEKQCAAsPAEHslMEAQTMgABCkAgALDwAgAEG05MAAIAEgAhBoCw8AIABBuOrAACABIAIQaAsPACAAQaTtwAAgASACEGgLDwAgAEGA7MAAIAEgAhBoCw8AIABB6O3AACABIAIQaAsPACAAQZiEwQAgASACEGgLEABBhZXBAEHzACAAEKQCAAsPACAAQYTlwQAgASACEGgLDwAgAEH4jcIAIAEgAhBoCwwAIAAlASABIAIQBAsMACAAIAEgAiUBEAULZQIBfwFvQdSxwgAtAABBAUcEQBA4C0GYscIAKAIABEBBrMrAABCyAgALQZixwgBBfzYCAEG0scIAKAIAQbixwgAoAgAQ2QIhAEGYscIAQZixwgAoAgBBAWo2AgAgACUBIAAQgAILZQIBfwFvQdSxwgAtAABBAUcEQBA4C0GYscIAKAIABEBBrMrAABCyAgALQZixwgBBfzYCAEHAscIAKAIAQcSxwgAoAgAQ2QIhAEGYscIAQZixwgAoAgBBAWo2AgAgACUBIAAQgAILDQBB4bXCAEEBOgAAAAsJACAAQQRqEFgLEQAgAEGU4MAA/QACAP0LAgALEQAgAEGk4MAA/QACAP0LAgALEQAgAEHMysAA/QACAP0LAgALEQAgAEHAysEA/QACAP0LAgALEQAgAEHQysEA/QACAP0LAgALEQAgAEHk6cAA/QACAP0LAgALEQAgAEHwysEA/QACAP0LAgALEQAgAEGAy8EA/QACAP0LAgALEQAgAEHMycAA/QACAP0LAgALDQBByJnCAEEbEJcDAAsJACAAIAEQEwALDgBB45nCAEHPABCXAwALDQAgAUHorsEAQRgQ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BiwgZ290IMAADFNvcnQgcmFuZ2UgW8ACLCDAFikgZXhjZWVkcyBzcGxhdCBjb3VudCDAABxNaXNzaW5nIFBMWSBjaHVuayBmb3Igc3BsYXQgwAAWc2xpY2UgaW5kZXggc3RhcnRzIGF0IMANIGJ1dCBlbmRzIGF0IMAAFWJ5dGUgcmFuZ2Ugc3RhcnRzIGF0IMANIGJ1dCBlbmRzIGF0IMAAIGluZGV4IG91dCBvZiBib3VuZHM6IHRoZSBsZW4gaXMgwBIgYnV0IHRoZSBpbmRleCBpcyDAABFzdGFydCBieXRlIGluZGV4IMAnIGlzIG91dCBvZiBib3VuZHMgZm9yIHN0cmluZyBvZiBsZW5ndGggwAAPZW5kIGJ5dGUgaW5kZXggwCcgaXMgb3V0IG9mIGJvdW5kcyBmb3Igc3RyaW5nIG9mIGxlbmd0aCDAABJyYW5nZSBzdGFydCBpbmRleCDAIiBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCDAABByYW5nZSBlbmQgaW5kZXggwCIgb3V0IG9mIHJhbmdlIGZvciBzbGljZSBvZiBsZW5ndGggwAALdjQgVE9DIGVuZCDAHSBleGNlZWRzIGV4cGVjdGVkIGlucHV0IHNpemUgwAAtQ291bGQgbm90IGNyZWF0ZSBsYXlvdXQgZm9yIHU4IGFycmF5IG9mIHNpemUgwAAdU29ydCByYW5nZSBvcmlnaW4gYnVmZmVyIGhhcyDAEiB2YWx1ZXMsIGV4cGVjdGVkIMAAH0luY29tcGxldGUgU1BaIHN0cmVhbTogc3RhZ2UgPSDADiwgc2hfZGVncmVlID0gwAAaSW52YWxpZCB2NCB0b2NCeXRlT2Zmc2V0OiDAAyA8IMAAIFNvcnQgb3JkZXJpbmcgYnVmZmVyIHRvbyBzbWFsbDogwAMgPCDAABxTb3J0IGNlbnRlciBidWZmZXIgZm9yIG1lc2ggwAwgdG9vIHNtYWxsOiDAAyA8IMAAI0ZhaWxlZCB0byBwYXJzZS9kZWNvZGUgYmxvY2sgYm9keTogwAAtU3BlY2lmaWVkIHdpbmRvd19zaXplIGlzIHRvbyBiaWc7IFJlcXVlc3RlZDogwAcsIE1heDogwAAQYXNzZXJ0aW9uIGBsZWZ0IMAXIHJpZ2h0YCBmYWlsZWQKICBsZWZ0OiDACQogcmlnaHQ6IMAAEGFzc2VydGlvbiBgbGVmdCDAECByaWdodGAgZmFpbGVkOiDACQogIGxlZnQ6IMAJCiByaWdodDogwAAYVW5zdXBwb3J0ZWQgUExZIGZvcm1hdDogwAAhVW5zdXBwb3J0ZWQgU1BaIGZyYWN0aW9uYWwgYml0czogwAAlSW52YWxpZCBudW1iZXIgb2YgZl9yZXN0IHByb3BlcnRpZXM6IMAAS2ludGVybmFsIGVycm9yOiBlbnRlcmVkIHVucmVhY2hhYmxlIGNvZGU6IElsbGVnYWwgbGl0ZXJhbCBsZW5ndGggY29kZSB3YXM6IMAASWludGVybmFsIGVycm9yOiBlbnRlcmVkIHVucmVhY2hhYmxlIGNvZGU6IElsbGVnYWwgbWF0Y2ggbGVuZ3RoIGNvZGUgd2FzOiDAAC9CbG9ja3NpemUgd2FzIGJpZ2dlciB0aGFuIHRoZSBhYnNvbHV0ZSBtYXhpbXVtIMAOICgxMjhrYikuIElzOiDAACdFcnJvciB3aGlsZSByZWFkaW5nIHdpbmRvdyBkZXNjcmlwdG9yOiDAACZFcnJvciB3aGlsZSByZWFkaW5nIGZyYW1lIGRlc2NyaXB0b3I6IMAAO0RlY29kZXIgZW5jb3VudGVyZWQgZXJyb3Igd2hpbGUgZHJhaW5pbmcgdGhlIGRlY29kZWJ1ZmZlcjogwAAeRmFpbGVkIHRvIHBhcnNlIGJsb2NrIGhlYWRlcjogwAAiRXJyb3Igd2hpbGUgcmVhZGluZyBtYWdpYyBudW1iZXI6IMAAIFVuc3VwcG9ydGVkIGxlZ2FjeSBTUFogdmVyc2lvbjogwAAZVW5zdXBwb3J0ZWQgUExZIHZlcnNpb246IMAAGlVuc3VwcG9ydGVkIE5HU1AgdmVyc2lvbjogwAAaV3JvbmcgbnVtYmVyIG9mIGxpdGVyYWxzOiDAFCwgU2hvdWxkIGhhdmUgYmVlbjogwAAtd2luZG93X3NpemUgYmlnZ2VyIHRoYW4gYWxsb3dlZCBtYXhpbXVtLiBJczogwBgsIFNob3VsZCBiZSBsb3dlciB0aGFuOiDAAC53aW5kb3dfc2l6ZSBzbWFsbGVyIHRoYW4gYWxsb3dlZCBtaW5pbXVtLiBJczogwBosIFNob3VsZCBiZSBncmVhdGVyIHRoYW46IMAAGUZhaWxlZCB0byByZWFkIGNoZWNrc3VtOiDAACJ0cmFpbGluZyBieXRlcyBpbiB2NCBaU1REIHN0cmVhbTogwAAuRGVjb2RlciBlbmNvdW50ZXJlZCBlcnJvciB3aGlsZSBpbml0aWFsaXppbmc6IMAACVNlcV9zdW06IMAxIGlzIGRpZmZlcmVudCBmcm9tIHRoZSBkaWZmZXJlbmNlIGluIGJ1ZmZlcnNpemU6IMAAIkVycm9yIGdldHRpbmcgYmxvY2sgY29udGVudCBzaXplOiDAAChFcnJvciB3aGlsZSByZWFkaW5nIGZyYW1lIGNvbnRlbnQgc2l6ZTogwAAfVW5zdXBwb3J0ZWQgUExZIHByb3BlcnR5IHR5cGU6IMAAGkVycm9yIGdldHRpbmcgYmxvY2sgdHlwZTogwAATSW52YWxpZCBmaWxlIHR5cGU6IMAAF0ludmFsaWQgcHJvcGVydHkgbGluZTogwAAdVW5zdXBwb3J0ZWQgUExZIGhlYWRlciBsaW5lOiDAAA1yYW5rX2lkeFswXTogwAwgc2hvdWxkIGJlOiDAADdmcmFtZV9jb250ZW50X3NpemUgZG9lcyBub3QgaGF2ZSB0aGUgcmlnaHQgbGVuZ3RoLiBJczogwA0sIFNob3VsZCBiZTogwAAhTm90IGVub3VnaCBieXRlcyBpbiBkaWN0X2lkLiBJczogwA0sIFNob3VsZCBiZTogwAAjRXJyb3Igd2hpbGUgcmVhZGluZyBkaWN0aW9uYXJ5IGlkOiDAABd2NCBaU1REIHdpbmRvdyBmYWlsZWQ6IMAAFXY0IFpTVEQgaW5pdCBmYWlsZWQ6IMAAG3Y0IFpTVEQgZGVjb21wcmVzcyBmYWlsZWQ6IMAAF3Y0IFpTVEQgaGVhZGVyIGZhaWxlZDogwAAWRGVjb21wcmVzc2lvbiBmYWlsZWQ6IMAAHkVycm9yIHdoaWxlIHJlYWRpbmcgYnl0ZXMgZm9yIMACOiDAABpTUFogcGFja2VkIG1vZGVsIHJlcXVpcmVzIMAWIGJ5dGVzLCBleGNlZWRpbmcgdGhlIMALIGJ5dGUgbGltaXQAZ2F1c3NpYW4tc3BsYXQtbGliL3NyYy9zcHoucnMAZ2F1c3NpYW4tc3BsYXQtbGliL3NyYy9wbHkucnMAL3J1c3QvZGVwcy9ydXN0Yy1kZW1hbmdsZS0wLjEuMjcvc3JjL2xlZ2FjeS5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL3NsaWNlL2luZGV4LnJzAC9ydXN0L2RlcHMvaGFzaGJyb3duLTAuMTcuMS9zcmMvcmF3LnJzAGdhdXNzaWFuLXNwbGF0LXJzL3NyYy9zb3J0LnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvYWxsb2Mvc3JjL2ZtdC5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL2FueWhvdy0xLjAuOTgvc3JjL2ZtdC5ycwBnYXVzc2lhbi1zcGxhdC1ycy9zcmMvc3BsYXRzLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeXMvc3luYy9tdXRleC9ub190aHJlYWRzLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeXMvdGhyZWFkX2xvY2FsL25vX3RocmVhZHMucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3N5cy9zeW5jL3J3bG9jay9ub190aHJlYWRzLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeXMvc3luYy9vbmNlL25vX3RocmVhZHMucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9hbGxvYy9zcmMvc3RyLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvYW55aG93LTEuMC45OC9zcmMvZXJyb3IucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9jb3JlL3NyYy9zbGljZS9tZW1jaHIucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9ydXpzdGQtMC43LjMvc3JjL2RlY29kaW5nL3JpbmdidWZmZXIucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9ydXpzdGQtMC43LjMvc3JjL2RlY29kaW5nL2RlY29kZWJ1ZmZlci5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL21pbml6X294aWRlLTAuOC45L3NyYy9pbmZsYXRlL291dHB1dF9idWZmZXIucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9ydXpzdGQtMC43LjMvc3JjL2RlY29kaW5nL2xpdGVyYWxzX3NlY3Rpb25fZGVjb2Rlci5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL3J1enN0ZC0wLjcuMy9zcmMvZGVjb2Rpbmcvc2VxdWVuY2Vfc2VjdGlvbl9kZWNvZGVyLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvcnV6c3RkLTAuNy4zL3NyYy9kZWNvZGluZy9ibG9ja19kZWNvZGVyLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvcnV6c3RkLTAuNy4zL3NyYy9mc2UvZnNlX2RlY29kZXIucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9ydXpzdGQtMC43LjMvc3JjL2ZyYW1lX2RlY29kZXIucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9ydXpzdGQtMC43LjMvc3JjL2h1ZmYwL2h1ZmYwX2RlY29kZXIucnMAZ2F1c3NpYW4tc3BsYXQtbGliL3NyYy9kZWNvZGVyLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvcnV6c3RkLTAuNy4zL3NyYy9kZWNvZGluZy9iaXRfcmVhZGVyLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9pby9zdGRpby5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL3N0ci9wYXR0ZXJuLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvcnV6c3RkLTAuNy4zL3NyYy9kZWNvZGluZy9zZXF1ZW5jZV9leGVjdXRpb24ucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9jb3JlL3NyYy9vcHMvZnVuY3Rpb24ucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9ydXpzdGQtMC43LjMvc3JjL2Jsb2Nrcy9saXRlcmFsc19zZWN0aW9uLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy90aHJlYWQvbG9jYWwucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3N5bmMvbGF6eV9sb2NrLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeW5jL3JlZW50cmFudF9sb2NrLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvYWxsb2Mvc3JjL3N0cmluZy5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L3N0ZC9zcmMvcGFuaWNraW5nLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2Yvd2FzbS1iaW5kZ2VuLTAuMi4xMTcvc3JjL2V4dGVybnJlZi5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2FsbG9jL3NyYy9jb2xsZWN0aW9ucy9idHJlZS9uYXZpZ2F0ZS5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL3J1enN0ZC0wLjcuMy9zcmMvZGVjb2RpbmcvYml0X3JlYWRlcl9yZXZlcnNlLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvbWluaXpfb3hpZGUtMC44Ljkvc3JjL2luZmxhdGUvY29yZS5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL3VuaWNvZGUvcHJpbnRhYmxlLnJzAGdhdXNzaWFuLXNwbGF0LWxpYi9zcmMvc3BsYXRfZW5jb2RlLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeW5jL29uY2UucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL2JhY2t0cmFjZS5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL2ZtdC9tb2QucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9jb3JlL3NyYy9ic3RyL21vZC5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L3N0ZC9zcmMvLi4vLi4vYmFja3RyYWNlL3NyYy9zeW1ib2xpemUvbW9kLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvYWxsb2Mvc3JjL3Jhd192ZWMvbW9kLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy90aHJlYWQvaWQucnMAL3J1c3QvZGVwcy9kbG1hbGxvYy0wLjIuMTMvc3JjL2RsbWFsbG9jLnJzAGdhdXNzaWFuLXNwbGF0LXJzL3NyYy9saWIucnMAL3J1c3QvZGVwcy9ydXN0Yy1kZW1hbmdsZS0wLjEuMjcvc3JjL2xpYi5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL2NvbnNvbGVfZXJyb3JfcGFuaWNfaG9vay0wLjEuNy9zcmMvbGliLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvanMtc3lzLTAuMy45NC9zcmMvbGliLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvY29yZS9zcmMvdW5pY29kZS91bmljb2RlX2RhdGEucnMAL3J1c3QvZGVwcy9ydXN0Yy1kZW1hbmdsZS0wLjEuMjcvc3JjL3YwLnJzAA92NCBaU1REIHN0cmVhbSDAFyBtYWRlIG5vIHByb2dyZXNzIHdpdGggwA8gYnVmZmVyZWQgYnl0ZXMAIEludmFsaWQgZnJhbWVfY29udGVudF9zaXplLiBJczogwCMsIFNob3VsZCBiZSBvbmUgb2YgMSwgMiwgNCwgOCBieXRlcwAuU2tpcHBhYmxlRnJhbWUgZW5jb3VudGVyZWQgd2l0aCBNYWdpY051bWJlciAweMAMIGFuZCBsZW5ndGggwAYgYnl0ZXMAGnY0IFpTVEQgd2luZG93IHRvbyBsYXJnZTogwAYgYnl0ZXMAGXY0IFpTVEQgYmxvY2sgdG9vIGxhcmdlOiDABiBieXRlcwAeSW52YWxpZCBCbG9ja3R5cGUgbnVtYmVyLiBJczogwDMgU2hvdWxkIGJlIG9uZSBvZjogMCwgMSwgMiwgMyAoMyBpcyByZXNlcnZlZCB0aG91Z2gAD3Y0IFpTVEQgc3RyZWFtIMAkIGVuZGVkIGJlZm9yZSBpdHMgZnJhbWUgd2FzIGNvbXBsZXRlADlpbnRlcm5hbCBlcnJvcjogZW50ZXJlZCB1bnJlYWNoYWJsZSBjb2RlOiBzdHI6OmZyb21fdXRmOCjABCkgPSDAIiB3YXMgZXhwZWN0ZWQgdG8gaGF2ZSAxIGNoYXIsIGJ1dCDAESBjaGFycyB3ZXJlIGZvdW5kABFzdGFydCBieXRlIGluZGV4IMAmIGlzIG5vdCBhIGNoYXIgYm91bmRhcnk7IGl0IGlzIGluc2lkZSDACCAoYnl0ZXMgwAsgb2Ygc3RyaW5nKQAPZW5kIGJ5dGUgaW5kZXggwCYgaXMgbm90IGEgY2hhciBib3VuZGFyeTsgaXQgaXMgaW5zaWRlIMAIIChieXRlcyDACyBvZiBzdHJpbmcpAA5TUFogU0ggZGVncmVlIMA2IGlzIG5vdCBzdXBwb3J0ZWQgYnkgR2F1c3NpYW4gU3BsYXQgTGl0ZSAoaGFuZGxlcyAwLTMpACdGcmFtZSBoZWFkZXIgc3BlY2lmaWVkIGRpY3Rpb25hcnkgaWQgMHjANyB0aGF0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BAECARgYKwMsAQcCBQkpOjcBAQEECAQBAwcKAg0BDwE6AQQECAEUAhoBAgI5AQQCBAICAwMBHgIDAQsCOQEEBQECBAEUAhYGAQE6AQIBAQQIAQcCCwIeAT0BDAEyAQMBNwEBAwUDAQQHAgsCHQE6AQIBBgEFAhQCHAI5AgQECAEUAh0BSAEHAwEBWgECBwsJYgECCQkBAQdJAhsBAQEBATcOAQUBAgULASQJAWYEAQYBAgICGQIEAxAEDQECAgYBDwFeAQADAAMdAh4CHgJAAgEHCAECCwMBBQEtBTMBQQIiAXYDBAIJAQYD2wICAToBAQcBAQEBAggGCgIBJwEILgIMFAQwAQEFAQEFASgJDAIgBAICAQM4AQECAwEBAzoIAgJABlIDAQ0BBwQBBgEDAjI/DQEiZQABAQMLAw0DDQMNAgwFCAIKAQIBAgUxBQEKAQENARANMyEAAnEDfQEPAWAgLwEAASQEAwUFAV0GXQMAAQAGAAFiBAEKAQEcBFACDiJOARcDZgQDAggBAwEEARkCBQGXAhoSDQEmCBkLLgMwAQIEAgIRARUCQgYCAgICDAEIASMBCwEzAQEDAgIFAgEBGwEOAgUCAQFkBQkDeQECAQQBAAGTEQAQAwEMECIBAgGpAQcBBgELASMBAQEvAS0CQwEVAwAB4gGVBQAGASoBCQADAQIFBCgDBAGlAgAEJgEaBQEBAAIYATQGRgsxBHsBNg8pAQICCgMxBAICAgEEAQoBMgMkBQEIPgEMAjQJCgQCAV8DAgEBAgYBAgGdAQMIFQI5AgMBJQcDBUYGDQEBAQEBDgJVCAIDAQEXAVQGAQEEAgEC7gQGAgECGwJVCAIBAQJqAQEBAgYBAWUBAQECBAEFAAkBAgACAQEEAZAEAgIEASAKKAYCBAgBCQYCAy4NAQLGAQEDAQHJBwEGAQFSFgIHAQIBAnoGAwEBAgEHAQFIAgMBAQFBAQACCwI0BQUBAQEXAQARBg8ADAMDAAU7BwkEAAMoAgABPxFAAgECDQIABAEHAQIAAgEEAC4CFwADCRACBx4ElAMANwQyCAEOARYFAQ8ABwERAgcBAgEFBT4hAaAOAAE9BAAF/gLzAQIBBwIFAQkBAAdtCAAFAAEeYIDwAABwAAcALQEBAQIBAgEBSAswFRABZQcCBgICAQQjAR4bWws6CQkBGAQBCQEDAQUrAzsJKhgBIDcBAQEECAQBAwcKAh0BOgEBAQIECAEJAQoCGgECAjkBBAIEAgIDAwEeAgMBCwI5AQQFAQIEARQCFgYBAToBAQIBBAgBBwMKAh4BOwEBAQwBCQEoAQMBNwEBAwUDAQQHAgsCHQE6AQICAQEDAwEEBwILAhwCOQIBAQIECAEJAQoCHQFIAQQBAgMBAQgBUQECBwwIYgECCQsHSQIbAQEBAQE3DgEFAQIFCwEkCQFmBAEGAQICAhkCBAMQBA0BAgIGAQ8BAAMABBwDHQIeAkACAQcIAQILCQEtAwEBdQIiAXYDBAIJAQYD2wICAToBAQcBAQEBAggGCgIBMC4CDBQEMAoEAyYJDAIgBAIGOAEBAgMBAQU4CAICmAMBDQEHBAEGAQMCxkAAAcMhAAONAWAgAAZpAgAEAQogAlACAAEDAQQBGQIFAZcCGhINASYIGQsBASwDMAECBAICAgEkAUMGAgICAgwBCAEvATMBAQMCAgUCAQEqAggB7gECAQQBAAEAEBAQAAIAAeIBlQUAAwECBQQoAwQBpQIABEEFAAJNBkYLMQR7ATYPKQECAgoDMQQCAgcBPQMkBQEIPgEMAjQJAQEIBAIBXwMCBAYBAgGdAQMIFQI5AgEBAQEMAQkBDgcDBUMBAgYBAQIBAQMEAwEBDgJVCAIDAQEXAVEBAgYBAQIBAQIBAusBAgQGAgECGwJVCAIBAQJqAQEBAghlAQEBAgQBBQAJAQL1AQoEBAGQBAICBAEgCigGAgQIAQkGAgMuDQECxgEBAwEByQcBBgEBUhYCBwECAQJ6BgMBAQIBBwEBSAIDAQEBAAILAjQFBQMXAQABBg8ADAMDAAU7BwABPwRRAQsCAAIALgIXAAUDBggIAgceBJQDADcEMggBDgEWBQEPAAcBEQIHAQIBBWQBoAcAAT0EAAT+AvMBAgEHAgUBAAdtBwBggPAAAAECAQIBJgEACAgICAgMAQ8BLwEADBEAAAkAAA0OCgAQAEGs/MAACwIGAgBBwfzAAAsJBAEADwAIAAALAEHe/MAACwEFAEH4/MAAC/0KEwADEgAHAw4GBgAGBgIFDAYPBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYJBgYGBgYGBgYGBgYGBgYGBgYGBgYGBwYNBgsGBgEGBgYGBgYGBgYGBgYGBgYGBgYGBggGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGEAYGBgYKBgQAAAAAAAQAAAAEAAAArgAAAMceEABYAAAAKwAAACMAAAAgewosCigKIHsgLi4gfWVudGl0eSBub3QgZm91bmRwZXJtaXNzaW9uIGRlbmllZGNvbm5lY3Rpb24gcmVmdXNlZGNvbm5lY3Rpb24gcmVzZXRob3N0IHVucmVhY2hhYmxlbmV0d29yayB1bnJlYWNoYWJsZWNvbm5lY3Rpb24gYWJvcnRlZG5vdCBjb25uZWN0ZWRhZGRyZXNzIGluIHVzZWFkZHJlc3Mgbm90IGF2YWlsYWJsZW5ldHdvcmsgZG93bmJyb2tlbiBwaXBlZW50aXR5IGFscmVhZHkgZXhpc3Rzb3BlcmF0aW9uIHdvdWxkIGJsb2Nrbm90IGEgZGlyZWN0b3J5aXMgYSBkaXJlY3RvcnlkaXJlY3Rvcnkgbm90IGVtcHR5cmVhZC1vbmx5IGZpbGVzeXN0ZW0gb3Igc3RvcmFnZSBtZWRpdW1maWxlc3lzdGVtIGxvb3Agb3IgaW5kaXJlY3Rpb24gbGltaXQgKGUuZy4gc3ltbGluayBsb29wKXN0YWxlIG5ldHdvcmsgZmlsZSBoYW5kbGVpbnZhbGlkIGlucHV0IHBhcmFtZXRlcmludmFsaWQgZGF0YXRpbWVkIG91dHdyaXRlIHplcm9ubyBzdG9yYWdlIHNwYWNlc2VlayBvbiB1bnNlZWthYmxlIGZpbGVxdW90YSBleGNlZWRlZGZpbGUgdG9vIGxhcmdlcmVzb3VyY2UgYnVzeWV4ZWN1dGFibGUgZmlsZSBidXN5ZGVhZGxvY2tjcm9zcy1kZXZpY2UgbGluayBvciByZW5hbWV0b28gbWFueSBsaW5rc2ludmFsaWQgZmlsZW5hbWVhcmd1bWVudCBsaXN0IHRvbyBsb25nb3BlcmF0aW9uIGludGVycnVwdGVkdW5zdXBwb3J0ZWR1bmV4cGVjdGVkIGVuZCBvZiBmaWxlb3V0IG9mIG1lbW9yeWluIHByb2dyZXNzb3RoZXIgZXJyb3J1bmNhdGVnb3JpemVkIGVycm9yAAAAAAAMAAAABAAAAK8AAACwAAAAsQAAABYWEABPAAAAaQYAABUAAAAWFhAATwAAAJcGAAAVAAAAFhYQAE8AAACYBgAAFQAAABYW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AAACgAAAAP////8Phar///////8AAAAA/////wAAAAD8////AAAAAAD////v/wAAAPz//wAAAQAA8P////8PAADA///////3/wP//8BDAAAAAP//AAAAAAAA//8AAACA//9//8D///8AAAD8AAAAAAAAAPgAAP//////9/z///cDAADwVNWqqqqqqqqqqqqqqqqqqqqqqqqqqqpV/wD/AP8A30A/AP8A/wD/P/////9iFdo/AAAAAAAAAD8gAAAAAACKPADECAAAgBAyAACA//v/+xv/f+OqqqovGbn///////0HCqWqCgAAXgcAAAAAAAQgBP//z/////8B/wA/AP8A/wDcAM8A/wDcAKqqqqoaUAgA/////78gAAD/+/9/4AcAAADA3///AAAAAwAAAB8AAACqqqo6AAAAAH8A+AAAAAAA9wsAAAAAAAD/BQAAAAAAAKqqqqqqqvqTqqqqqqqq/5VAUlW1qqopqqpQuqqqgqCq/////6qqqqoAAAAAqKqrqlWrqqqqqqrUKTEkTiotUeb8//8PAADA6wBB7aTBAAsBPwBB/KTBAAsDEA45AEGMpcEACwEpAEGcpcEACwEtAEGppcEACwMIEz4AQbmlwQALDUUsADUxMyIAAAAACToAQdOlwQALBAMAEDsAQeOlwQALARQAQe+lwQALBRwAAABAAEGDpsEACwFJAEGSpsEACyUjERg2NzIwByQrAB0MIAAALwA5OTkAFxdHFyUaGSYABUgAHg9NAEHApsEACxUKPQAGAAAfAAAAAAAAACEAEBsXJygAQeCmwQALBxA0AhZGCDwAQfCmwQALAhBKAEGAp8EAC7MJQyo4C0RBEg0BQk4VS0wELgC2AEoApgCiAJ8AlgCUAI4AhgCDAEABQgFGAVMBDAEIApICjAKGAoIDpAOSAxQEsgSrAAAAAAAA////////PwD/PwAAAP///wEAAAD8//8HAVRVVVVVVVX1WlUVAAAgAAAAAAD//////wMAAAD///9f/AEAAPD///8D////A///AAAAAAAA//9VVVVVVVX+/wAAAAAAAEWAsOffHwAAAHtVVVVVVVUFbFVVVVVVVQBqkKSqSlVV0lVVKEVVVX1fVVVVVVVVVVVVqypVVVVVVVUAAAAAVVVVVQAAAABUVVRVqlRVVVVVVSvWztux1dKuEQAPAA8AHwAPAAAA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bWF4X3pNaXNzaW5nIG1heF96IHByb3BlcnR5bWluX3NjYWxlX3hNaXNzaW5nIG1pbl9zY2FsZV94IHByb3BlcnR5bWluX3NjYWxlX3lNaXNzaW5nIG1pbl9zY2FsZV95IHByb3BlcnR5bWluX3NjYWxlX3pNaXNzaW5nIG1pbl9zY2FsZV96IHByb3BlcnR5bWF4X3NjYWxlX3hNaXNzaW5nIG1heF9zY2FsZV94IHByb3BlcnR5bWF4X3NjYWxlX3lNaXNzaW5nIG1heF9zY2FsZV95IHByb3BlcnR5bWF4X3NjYWxlX3pNaXNzaW5nIG1heF9zY2FsZV96IHByb3BlcnR5bWluX3JtaW5fZ21pbl9ibWF4X3JtYXhfZ21heF9icGFja2VkX3Bvc2l0aW9uTWlzc2luZyBwYWNrZWRfcG9zaXRpb24gcHJvcGVydHlwYWNrZWRfcm90YXRpb25NaXNzaW5nIHBhY2tlZF9yb3RhdGlvbiBwcm9wZXJ0eXBhY2tlZF9zY2FsZU1pc3NpbmcgcGFja2VkX3NjYWxlIHByb3BlcnR5cGFja2VkX2NvbG9yTWlzc2luZyBwYWNrZWRfY29sb3IgcHJvcGVydHkAADsNEAAdAAAASgQAAB8AAAA7DRAAHQAAAFAEAAA9AAAAOw0QAB0AAABQBAAAIQAAADsNEAAdAAAAVgQAAD0AAAA7DRAAHQAAAFYEAAAhAAAAOw0QAB0AAABcBAAAPQAAADsNEAAdAAAAXAQAACEAAAB4TWlzc2luZyB4IHByb3BlcnR5eU1pc3NpbmcgeSBwcm9wZXJ0eXpNaXNzaW5nIHogcHJvcGVydHlzY2FsZV8wTWlzc2luZyBzY2FsZV8wIHByb3BlcnR5c2NhbGVfMU1pc3Npbmcgc2NhbGVfMSBwcm9wZXJ0eXNjYWxlXzJNaXNzaW5nIHNjYWxlXzIgcHJvcGVydHlyb3RfMU1pc3Npbmcgcm90XzAgcHJvcGVydHlyb3RfMk1pc3Npbmcgcm90XzEgcHJvcGVydHlyb3RfM01pc3Npbmcgcm90XzIgcHJvcGVydHlyb3RfME1pc3Npbmcgcm90XzMgcHJvcGVydHlvcGFjaXR5TWlzc2luZyBvcGFjaXR5IHByb3BlcnR5Zl9kY18wTWlzc2luZyBmX2RjXzAgcHJvcGVydHlm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AIQARADEACQApABkAOQAFACUAFQA1AA0ALQAdAD0AAwAjABMAMwALACsAGwA7AAcAJwAXADcADwAvAB8APwAAgCCAEIAwgAiAKIAYgDiABIAkgBSANIAMgCyAHIA8gAKAIoASgDKACoAqgBqAOoAGgCaAFoA2gA6ALoAegD6AAYAhgBGAMYAJgCmAGYA5gAWAJYAVgDWADYAtgB2APYADgCOAE4AzgAuAK4AbgDuAB4AngBeAN4APgC+AH4A/gABAIEAQQDBACEAoQBhAOEAEQCRAFEA0QAxALEAcQDxAAkAiQBJAMkAKQCpAGkA6QAZAJkAWQDZADkAuQB5APkABQCFAEUAxQAlAKUAZQDlABUAlQBVANUANQC1AHUA9QANAI0ATQDNAC0ArQBtAO0AHQCdAF0A3QA9AL0AfQD9AAMAgwBDAMMAIwCjAGMA4wATAJMAUwDTADMAswBzAPMACwCLAEsAywArAKsAawDrABsAmwBbANsAOwC7AHsA+wAHAIcARwDHACcApwBnAOcAFwCXAFcA1wA3ALcAdwD3AA8AjwBPAM8ALwCvAG8A7wAfAJ8AXwDfAD8AvwB/AP+AAICAgECAwIAggKCAYIDggBCAkIBQgNCAMICwgHCA8IAIgIiASIDIgCiAqIBogOiAGICYgFiA2IA4gLiAeID4gASAhIBEgMSAJICkgGSA5IAUgJSAVIDUgDSAtIB0gPSADICMgEyAzIAsgKyAbIDsgByAnIBcgNyAPIC8gHyA/IACgIKAQoDCgCKAooBigOKAEoCSgFKA0oAygLKAcoDygAqAioBKgMqAKoCqgGqA6oAagJqAWoDagDqAuoB6gPqABoCGgEaAxoAmgKaAZoDmgBaAloBWgNaANoC2gHaA9oAOgI6AToDOgC6AroBugO6AHoCegF6A3oA+gL6AfoD+gAGAgYBBgMGAIYChgGGA4YARgJGAUYDRgDGAsYBxgPGACYCJgEmAyYApgKmAaYDpgBmAmYBZgNmAOYC5gHmA+YAFgIWARYDFgCWApYBlgOWAFYCVgFWA1YA1gLWAdYD1gA2AjYBNgM2ALYCtgG2A7YAdgJ2AXYDdgD2AvYB9gP2AA4CDgEOAw4AjgKOAY4DjgBOAk4BTgNOAM4CzgHOA84ALgIuAS4DLgCuAq4BrgOuAG4CbgFuA24A7gLuAe4D7gAeAh4BH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Z3NraXBwZWRfYml0c0JpdHN0cmVhbVJlYWRNaXNtYXRjaHJlYWRfdGlsZXhwZWN0ZWREZWNvZGVkTGl0ZXJhbENvdW50TWlzbWF0Y2hkZWNvZGVkRlNFRGVjb2RlckVycm9yVW5zdXBwb3J0ZWRPZmZzZXRvZmZzZXRfY29kZU5vdEVub3VnaEJ5dGVzRm9yTnVtU2VxdWVuY2VzRXh0cmFCaXRzYml0c19yZW1haW5pbmdNaXNzaW5nQ29tcHJlc3Npb25Nb2RlTWlzc2luZ0J5dGVGb3JSbGVMbFRhYmxlTWlzc2luZ0J5dGVGb3JSbGVPZlRhYmxlTWlzc2luZ0J5dGVGb3JSbGVNbFRhYmxlSWxsZWdhbExpdGVyYWxTZWN0aW9uVHlwZU5vdEVub3VnaEJ5dGVzZmFpbGVkIHRvIGZpbGwgd2hvbGUgYnVmZmVyvYAQABsAAAAlAAAAAAAAAAIAAADYgBAAQWNjTG9nSXNaZXJvQWNjTG9nVG9vQmlnbWF4UHJvYmFiaWxpdHlDb3VudGVyTWlzbWF0Y2hleHBlY3RlZF9zdW1zeW1ib2xfcHJvYmFiaWxpdGllc1Rvb01hbnlTeW1ib2xzAAAAAgBUYWJsZUlzVW5pbml0aWFsaXplZEludmFsaWRGcmFtZUNvbnRlbnRTaXplRmxhZ1dpbmRvd1Rvb0JpZ1dpbmRvd1Rvb1NtYWxsRnJhbWVEZXNjcmlwdG9yRXJyb3JEaWN0SWRUb29TbWFsbE1pc21hdGNoZWRGcmFtZVNpemVGcmFtZVNpemVJc1plcm9JbnZhbGlkRnJhbWVTaXplU291cmNlSXNFbXB0eU5vdEVub3VnaEJ5dGVzRm9yV2VpZ2h0c2dvdF9ieXRlc2V4cGVjdGVkX2J5dGVzVG9vTWFueVdlaWdodHNNaXNzaW5nV2VpZ2h0c0xlZnRvdmVySXNOb3RBUG93ZXJPZjJOb3RFbm91Z2hCeXRlc1RvRGVjb21wcmVzc1dlaWdodHNGU0VUYWJsZVVzZWRUb29NYW55Qnl0ZXN1c2VkYXZhaWxhYmxlX2J5dGVzTm90RW5vdWdoQnl0ZXNJblNvdXJjZVdlaWdodEJpZ2dlclRoYW5NYXhOdW1CaXRzTWF4Qml0c1Rvb0hpZ2gAAAAAAEAGAAAAAERlY29kZXIgbXVzdCBpbml0aWFsaXplZCBvciByZXNldCBiZWZvcmUgdXNpbmcgaXRGYWlsZWQgdG8gc2tpcCBieXRlcyBmb3IgdGhlIGxlbmd0aCBnaXZlbiBpbiB0aGUgZnJhbWUgaGVhZGVyVGFyZ2V0IG11c3QgaGF2ZSBhdCBsZWFzdCBhcyBtYW55IGJ5dGVzIGFzIHRoZSBjb250ZW50c2l6ZSBvZiB0aGUgZnJhbWUgcmVwb3J0c0Vycm9yIHdoaWxlIHJlYWRpbmcgdGhlIGJsb2NrIGhlYWRlclJlc2VydmVkIGJsb2NrIG9jY3VyZWQuIFRoaXMgaXMgY29uc2lkZXJlZCBjb3JydXB0aW9uIGJ5IHRoZSBkb2N1bWVudGF0aW9uTWFnaWNOdW1iZXJSZWFkRXJyb3JCYWRNYWdpY051bWJlckZyYW1lRGVzY3JpcHRvclJlYWRFcnJvckludmFsaWRGcmFtZURlc2NyaXB0b3JXaW5kb3dEZXNjcmlwdG9yUmVhZEVycm9yRGljdGlvbmFyeUlkUmVhZEVycm9yRnJhbWVDb250ZW50U2l6ZVJlYWRFcnJvclNraXBGcmFtZW1hZ2ljX251bWJlcmxlbmd0aG5lZWRfYXRfbGVhc3RDYW4ndCBkZWNvZGUgbmV4dCBibG9jayBpZiBmYWlsZWQgYWxvbmcgdGhlIHdheS4gUmVzdWx0cyB3aWxsIGJlIG5vbnNlbnNlQ2FuJ3QgZGVjb2RlIG5leHQgYmxvY2sgYm9keSwgd2hpbGUgZXhwZWN0aW5nIHRvIGRlY29kZSB0aGUgaGVhZGVyIG9mIHRoZSBwcmV2aW91cyBibG9jay4gUmVzdWx0cyB3aWxsIGJlIG5vbnNlbnNlQmxvY2tDb250ZW50UmVhZEVycm9yTWFsZm9ybWVkU2VjdGlvbkhlYWRlcmV4cGVjdGVkX2xlbnJlbWFpbmluZ19ieXRlc0RlY29tcHJlc3NMaXRlcmFsc0Vycm9yTGl0ZXJhbHNTZWN0aW9uUGFyc2VFcnJvclNlcXVlbmNlc0hlYWRlclBhcnNlRXJyb3JEZWNvZGVTZXF1ZW5jZUVycm9yRXhlY3V0ZVNlcXVlbmNlc0Vycm9yUhsQAEwAAADiAAAAFAAAAG9uZS10aW1lIGluaXRpYWxpemF0aW9uIG1heSBub3QgYmUgcGVyZm9ybWVkIHJlY3Vyc2l2ZWx5AAAAAAQAAAAEAAAA0QAAAFIbEABMAAAA4gAAADEAAABvcGVyYXRpb24gbm90IHN1cHBvcnRlZCBvbiB0aGlzIHBsYXRmb3JtvIYQACgAAAAkAAAAAgAAAOSGEACgAAAADAAAAAQAAADSAAAA0wAAANQAAAAAAAAACAAAAAQAAADVAAAA1gAAANcAAADYAAAA2QAAABAAAAAEAAAA2gAAANsAAADcAAAA3QAAAFz26V/cAva58cFwbPJhwSTaB4xJeGVM08J9j02WnybPYXNzZXJ0aW9uIGZhaWxlZDogcHNpemUgPj0gc2l6ZSArIG1pbl9vdmVyaGVhZAAAiB0QACoAAACxBAAACQAAAGFzc2VydGlvbiBmYWlsZWQ6IHBzaXplIDw9IHNpemUgKyBtYXhfb3ZlcmhlYWQAAIgdEAAqAAAAtwQAAA0AAAByd2xvY2sgb3ZlcmZsb3dlZCByZWFkIGxvY2tznw8QAF0AAAAVAAAALAAAAGNhbm5vdCByZWN1cnNpdmVseSBhY3F1aXJlIG11dGV44w4QAFwAAAATAAAACQAAAGxvY2sgY291bnQgb3ZlcmZsb3cgaW4gcmVlbnRyYW50IG11dGV4AAA9GBAAVgAAACMBAAAtAAAAAQAAAAAAAADTIAAAaAEAACAgICAgICAgICAgICBhdCAKwyAAAGgEAAI6IADTIAAAaAEAAyAtIAAgICAgICA8dW5rbm93bj7BIACAYABjYW5ub3QgbW9kaWZ5IHRoZSBwYW5pYyBob29rIGZyb20gYSBwYW5pY2tpbmcgdGhyZWFkAAAA4BgQAEwAAACQAAAACQAAAO+/vQCFHBAAZAAAAGcBAAAwAAAATGF6eUxvY2sgaW5zdGFuY2UgaGFzIHByZXZpb3VzbHkgYmVlbiBwb2lzb25lZAAA6xcQAFEAAACfAQAABQAAAG9wZXJhdGlvbiBzdWNjZXNzZnVsZmFpbGVkIHRvIGdlbmVyYXRlIHVuaXF1ZSB0aHJlYWQgSUQ6IGJpdHNwYWNlIGV4aGF1c3RlZAA7HRAATAAAACYAAAANAAAAV291bGRCbG9jawAAAAAAAAgAAAAEAAAA3gAAAE5vdEZvdW5kUGVybWlzc2lvbkRlbmllZENvbm5lY3Rpb25SZWZ1c2VkQ29ubmVjdGlvblJlc2V0SG9zdFVucmVhY2hhYmxlTmV0d29ya1VucmVhY2hhYmxlQ29ubmVjdGlvbkFib3J0ZWROb3RDb25uZWN0ZWRBZGRySW5Vc2VBZGRyTm90QXZhaWxhYmxlTmV0d29ya0Rvd25Ccm9rZW5QaXBlQWxyZWFkeUV4aXN0c05vdEFEaXJlY3RvcnlJc0FEaXJlY3RvcnlEaXJlY3RvcnlOb3RFbXB0eVJlYWRPbmx5RmlsZXN5c3RlbUZpbGVzeXN0ZW1Mb29wU3RhbGVOZXR3b3JrRmlsZUhhbmRsZUludmFsaWRJbnB1dEludmFsaWREYXRhVGltZWRPdXRXcml0ZVplcm9TdG9yYWdlRnVsbE5vdFNlZWthYmxlUXVvdGFFeGNlZWRlZEZpbGVUb29MYXJnZVJlc291cmNlQnVzeUV4ZWN1dGFibGVGaWxlQnVzeURlYWRsb2NrQ3Jvc3Nlc0RldmljZXNUb29NYW55TGlua3NJbnZhbGlkRmlsZW5hbWVBcmd1bWVudExpc3RUb29Mb25nSW50ZXJydXB0ZWRVbnN1cHBvcnRlZFVuZXhwZWN0ZWRFb2ZPdXRPZk1lbW9yeUluUHJvZ3Jlc3NPdGhlclVuY2F0ZWdvcml6ZWR1bnN1cHBvcnRlZCBiYWNrdHJhY2VkaXNhYmxlZCBiYWNrdHJhY2UAnxsQAEwAAACKAQAAHQAAAN8AAAAQAAAABAAAAOAAAADhAAAAT3Njb2Rla2luZG1lc3NhZ2VLaW5kRXJyb3JDdXN0b21lcnJvcnBhbmlja2VkIGF0IDoKAKAAAAAMAAAABAAAAOIAAAByd2xvY2sgaGFzIG5vdCBiZWVuIGxvY2tlZCBmb3IgcmVhZGluZwAAnw8QAF0AAAA+AAAACQAAAMoVEABLAAAARQQAABQAAABudWxsIHBvaW50ZXIgcGFzc2VkIHRvIHJ1c3RyZWN1cnNpdmUgdXNlIG9mIGFuIG9iamVjdCBkZXRlY3RlZCB3aGljaCB3b3VsZCBsZWFkIHRvIHVuc2FmZSBhbGlhc2luZyBpbiBydXN0AAAtGRAAaQAAAHwAAAARAAAALRkQAGkAAACJAAAAEQAAAAAAAAACAAAAAAAAAAMAAAAAAAAABAAAAAAAAAAGAAAAAAAAABgAAAAIAAAADwAAAAYAAAAEAAAADgAAAA0AAADEZBAA3GQQAORkEADzZBAA+WQQAP1kEAALZRAABwAAAAYAAAADAAAABgAAAAUAAAACAAAABAAAALgxEAC/MRAAxTEQAMgxEADOMRAA0zEQAPlkEAAJAAAAGAAAAC0AAAAmAAAAHQAAACYAAAAmAAAAJgAAABwAAABkVhAAilYQAKdWEADNVhAA81YQABlXEAADAAAACAAAAA8AAAADAAAACAAAAA8AAAADAAAACAAAAA8AAAAFAAAADAAAAAsAAAALAAAABAAAAA4AAAA5cxAAPnMQAEpzEABVcxAAYHMQAGRzEAAYAAAACAAAAA8AAAAGAAAABAAAAA4AAAANAAAAxGQQANxkEADkZBAA82QQAPlkEAD9ZBAAC2UQAAIAAAAEAAAABAAAAAMAAAADAAAAAwAAAAAAAAACAAAABQAAAAUAAAAAAAAAAwAAAAMAAAAEAAAABAAAAAEAQfidwgALXwMAAAADAAAAAgAAAAMAAAAAAAAAAwAAAAMAAAABAAAAqXAQAJxwEACgcBAA1HAQAKRwEADRcBAAAAAAAL1wEAC4cBAAzHAQAAAAAACucBAAwnAQALRwEADIcBAAa3AQAEHgnsIAC5ARq3AQAL9wEACncBAA2HAQAAAAAACxcBAAxXAQANdwEAAFAAAADAAAAAsAAAALAAAABAAAAA4AAAA5cxAAPnMQAEpzEABVcxAAYHMQAGRzEAABAQEBAgIDAwQGBwgJCgsMDQ4PEBAAAAASAAAAFAAAABYAAAAYAAAAHAAAACAAAAAoAAAAMAAAAEAAAACAAAAAAAEAAAACAAAABAAAAAgAAAAQAAAAIAAAAEAAAACAAAAAAAEAAQEBAQICAwMEBAUHCAkKCwwNDg8QAAAAIwAAACUAAAAnAAAAKQAAACsAAAAvAAAAMwAAADsAAABDAAAAUwAAAGMAAACDAAAAAwEAAAMCAAADBAAAAwgAAAMQAAADIAAAA0AAAAOAAAADAAEAAQEBAQICAwMEBgcICQoLDA0ODxAQAAAAEgAAABQAAAAWAAAAGAAAABwAAAAgAAAAKAAAADAAAABAAAAAgAAAAAABAAAAAgAAAAQAAAAIAAAAEAAAACAAAABAAAAAgAAAAAABAAEBAQECAgMDBAQFBwgJCgsMDQ4PEAAAACMAAAAlAAAAJwAAACkAAAArAAAALwAAADMAAAA7AAAAQwAAAFMAAABjAAAAgwAAAAMBAAADAgAAAwQAAAMIAAADEAAAAyAAAANAAAADgAAAAwABAAgAAAAQAAAAEQAAAA8AAAAPAAAAEgAAABEAAAAMAAAACQAAABAAAAALAAAACgAAAA0AAAAKAAAADQAAAAwAAAARAAAAEgAAAA4AAAAWAAAADAAAAAsAAAAIAAAACQAAAAsAAAALAAAADQAAAAwAAAAMAAAAEgAAAAgAAAAOAAAADAAAAA8AAAATAAAACwAAAAsAAAANAAAACwAAAAoAAAAFAAAADQAAANyJEADkiRAA9IkQAAWKEAAUihAAI4oQADWKEABGihAAUooQAFuKEABrihAAdooQAICKEADAiRAAjYoQAJqKEACmihAAt4oQAMmKEADXihAA7YoQAPmKEAAEixAADIsQABWLEAAgixAAK4sQADiLEABEixAAUIsQAGKLEABqixAAeIsQAISLEACTixAAposQALGLEAC8ixAAyYsQANSLEADeixAA44sQAAgAAAAQAAAAEQAAAA8AAAAPAAAAEgAAABEAAAAMAAAACQAAABAAAAALAAAACgAAAA0AAAAKAAAADQAAAAwAAAARAAAAEgAAAA4AAAAWAAAADAAAAAsAAAAIAAAACQAAAAsAAAALAAAADQAAAAwAAAAMAAAAEgAAAAgAAAAOAAAADAAAAA8AAAATAAAACwAAAAsAAAANAAAACwAAAAoAAAAFAAAADQAAANyJEADkiRAA9IkQAAWKEAAUihAAI4oQADWKEABGihAAUooQAFuKEABrihAAdooQAICKEADAiRAAjYoQAJqKEACmihAAt4oQAMmKEADXihAA7YoQAPmKEAAEixAADIsQABWLEAAgixAAK4sQADiLEABEixAAUIsQAGKLEABqixAAeIsQAISLEACTixAAposQALGLEAC8ixAAyYsQANSLEADeixAA44sQABAAAAARAAAAEgAAABAAAAAQAAAAEwAAABIAAAANAAAADgAAABUAAAAMAAAACwAAABUAAAAVAAAADwAAAA4AAAATAAAAJgAAADgAAAAZAAAAFwAAAAwAAAAJAAAACgAAABAAAAAXAAAADgAAAA4AAAANAAAAFAAAAAgAAAAbAAAADgAAABAAAAAWAAAAFQAAAAsAAAAWAAAADQAAAAsAAAALAAAAEwAAACo/EAA6PxAASz8QAF0/EABtPxAAfT8QAJA/EACiPxAArz8QAL0/EADSPxAA3j8QAOk/EAD+PxAAE0AQACJAEAAwQBAAQ0AQAGlAEAChQBAAukAQANFAEADdQBAA5kAQAPBAEAAAQRAAF0EQACVBEAAzQRAAQEEQAFRBEABcQRAAd0EQAIVBEACVQRAAq0EQAMBBEADLQRAA4UEQAO5BEAD5QRAABEIQAAgAAAAQAAAAEQAAAA8AAAAPAAAAEgAAABEAAAAMAAAACQAAABAAAAALAAAACgAAAA0AAAAKAAAADQAAAAwAAAARAAAAEgAAAA4AAAAWAAAADAAAAAsAAAAIAAAACQAAAAsAAAALAAAADQAAAAwAAAAMAAAAEgAAAAgAAAAOAAAADAAAAA8AAAATAAAACwAAAAsAAAANAAAACwAAAAoAAAAFAAAADQAAANyJEADkiRAA9IkQAAWKEAAUihAAI4oQADWKEABGihAAUooQAFuKEABrihAAdooQAICKEADAiRAAjYoQAJqKEACmihAAt4oQAMmKEADXihAA7YoQAPmKEAAEixAADIsQABWLEAAgixAAK4sQADiLEABEixAAUIsQAGKLEABqixAAeIsQAISLEACTixAAposQALGLEAC8ixAAyYsQANSLEADeixAA44sQAAMAAAAEAAAABAAAAAYAAACD+aIARE5uAPwpFQDRVycA3TT1AGLbwAA8mZUAQZBDAGNR/gC73qsAt2HFADpuJADSTUIASQbgAAnqLgAcktEA6x3+ACmxHADoPqcA9TWCAES7LgCc6YQAtCZwAEF+XwDWkTkAU4M5AJz0OQCLX4QAKPm9APgfOwDe/5cAD5gFABEv7wAKWosAbR9tAM9+NgAJyycARk+3AJ5mPwAt6l8Auid1AOXrxwA9e/EA9zkHAJJSigD7a+oAH7FfAAhdjQAwA1YAe/xGAPCrawAgvM8ANvSaAOOpHQBeYZEACBvmAIWZZQCgFF8AjUBoAIDY/wAnc00ABgYxAMpWFQDJqHMAe+JgAGuMwAAAAABA+yH5PwAAAAAtRHQ+AAAAgJhG+DwAAABgUcx4OwAAAICDG/A5AAAAQCAlejgAAACAIoLjNgAAAAAd82k1AAAAPwAAAL8AQfivwgALCQEAAAAAAAAABABwCXByb2R1Y2VycwIIbGFuZ3VhZ2UBBFJ1c3QADHByb2Nlc3NlZC1ieQMFcnVzdGMdMS45Ny4xICg4YmFiMjZmNGYgMjAyNi0wNy0xNCkGd2FscnVzBjAuMjYuNAx3YXNtLWJpbmRnZW4HMC4yLjExNwB0D3RhcmdldF9mZWF0dXJlcwcrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsHc2ltZDEyOCsLYnVsay1tZW1vcnkrCHNpZ24tZXh0Kw9yZWZlcmVuY2UtdHlwZXMrCm11bHRpdmFsdWU=").buffer;
const WASM_MODULE = WebAssembly.compile(wasmBytes);
let initialized = false;
__wbg_init({ module_or_path: WASM_MODULE }).then(() => {
  initialized = true;
});
function isInitialized() {
  return initialized;
}
const jsContent = '(function() {\n  "use strict";\n  class ChunkDecoder {\n    static __wrap(ptr) {\n      ptr = ptr >>> 0;\n      const obj = Object.create(ChunkDecoder.prototype);\n      obj.__wbg_ptr = ptr;\n      ChunkDecoderFinalization.register(obj, obj.__wbg_ptr, obj);\n      return obj;\n    }\n    __destroy_into_raw() {\n      const ptr = this.__wbg_ptr;\n      this.__wbg_ptr = 0;\n      ChunkDecoderFinalization.unregister(this);\n      return ptr;\n    }\n    free() {\n      const ptr = this.__destroy_into_raw();\n      wasm.__wbg_chunkdecoder_free(ptr, 0);\n    }\n    /**\n     * @returns {any}\n     */\n    finish() {\n      const ptr = this.__destroy_into_raw();\n      const ret = wasm.chunkdecoder_finish(ptr);\n      if (ret[2]) {\n        throw takeFromExternrefTable0(ret[1]);\n      }\n      return takeFromExternrefTable0(ret[0]);\n    }\n    /**\n     * @param {Uint8Array} bytes\n     */\n    push(bytes) {\n      const ret = wasm.chunkdecoder_push(this.__wbg_ptr, bytes);\n      if (ret[1]) {\n        throw takeFromExternrefTable0(ret[0]);\n      }\n    }\n    /**\n     * @param {number} size\n     */\n    set_expected_input_size(size) {\n      const ret = wasm.chunkdecoder_set_expected_input_size(this.__wbg_ptr, size);\n      if (ret[1]) {\n        throw takeFromExternrefTable0(ret[0]);\n      }\n    }\n  }\n  if (Symbol.dispose) ChunkDecoder.prototype[Symbol.dispose] = ChunkDecoder.prototype.free;\n  function decode_to_splats(file_type, path_name) {\n    var ptr0 = isLikeNone(file_type) ? 0 : passStringToWasm0(file_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n    var len0 = WASM_VECTOR_LEN;\n    var ptr1 = isLikeNone(path_name) ? 0 : passStringToWasm0(path_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n    var len1 = WASM_VECTOR_LEN;\n    const ret = wasm.decode_to_splats(ptr0, len0, ptr1, len1);\n    if (ret[2]) {\n      throw takeFromExternrefTable0(ret[1]);\n    }\n    return ChunkDecoder.__wrap(ret[0]);\n  }\n  function set_sort_center_state(update_range_indices, update_centers, range_mesh_ids, range_bases, range_counts, range_origins) {\n    wasm.set_sort_center_state(update_range_indices, update_centers, range_mesh_ids, range_bases, range_counts, range_origins);\n  }\n  function sort32_centers(num_splats, camera_x, camera_y, camera_z, direction_x, direction_y, direction_z, radial, ordering) {\n    const ret = wasm.sort32_centers(num_splats, camera_x, camera_y, camera_z, direction_x, direction_y, direction_z, radial, ordering);\n    return ret >>> 0;\n  }\n  function __wbg_get_imports() {\n    const import0 = {\n      __proto__: null,\n      __wbg___wbindgen_debug_string_dd5d2d07ce9e6c57: function(arg0, arg1) {\n        const ret = debugString(arg1);\n        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n        const len1 = WASM_VECTOR_LEN;\n        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);\n        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);\n      },\n      __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {\n        throw new Error(getStringFromWasm0(arg0, arg1));\n      },\n      __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {\n        let deferred0_0;\n        let deferred0_1;\n        try {\n          deferred0_0 = arg0;\n          deferred0_1 = arg1;\n          console.error(getStringFromWasm0(arg0, arg1));\n        } finally {\n          wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);\n        }\n      },\n      __wbg_get_index_983d655608220248: function(arg0, arg1) {\n        const ret = arg0[arg1 >>> 0];\n        return ret;\n      },\n      __wbg_length_0c32cb8543c8e4c8: function(arg0) {\n        const ret = arg0.length;\n        return ret;\n      },\n      __wbg_length_1e701798fdcaa3b4: function(arg0) {\n        const ret = arg0.length;\n        return ret;\n      },\n      __wbg_length_526c0f6e4ebae15d: function(arg0) {\n        const ret = arg0.length;\n        return ret;\n      },\n      __wbg_length_fd4646b401926788: function(arg0) {\n        const ret = arg0.length;\n        return ret;\n      },\n      __wbg_new_227d7c05414eb861: function() {\n        const ret = new Error();\n        return ret;\n      },\n      __wbg_new_4f9fafbb3909af72: function() {\n        const ret = new Object();\n        return ret;\n      },\n      __wbg_new_with_length_41a22191b9bdfd66: function(arg0) {\n        const ret = new Uint32Array(arg0 >>> 0);\n        return ret;\n      },\n      __wbg_prototypesetcall_021fd89d67217368: function(arg0, arg1, arg2) {\n        Float64Array.prototype.set.call(getArrayF64FromWasm0(arg0, arg1), arg2);\n      },\n      __wbg_prototypesetcall_3e05eb9545565046: function(arg0, arg1, arg2) {\n        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);\n      },\n      __wbg_prototypesetcall_66c8e1fb820946be: function(arg0, arg1, arg2) {\n        Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);\n      },\n      __wbg_prototypesetcall_e42275e601e14eeb: function(arg0, arg1, arg2) {\n        Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);\n      },\n      __wbg_set_448126769bf7c181: function(arg0, arg1, arg2) {\n        arg0.set(getArrayU32FromWasm0(arg1, arg2));\n      },\n      __wbg_set_8ee2d34facb8466e: function() {\n        return handleError(function(arg0, arg1, arg2) {\n          const ret = Reflect.set(arg0, arg1, arg2);\n          return ret;\n        }, arguments);\n      },\n      __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {\n        const ret = arg1.stack;\n        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n        const len1 = WASM_VECTOR_LEN;\n        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);\n        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);\n      },\n      __wbg_subarray_0f98d3fb634508ad: function(arg0, arg1, arg2) {\n        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);\n        return ret;\n      },\n      __wbg_subarray_4342405c1ffc86d6: function(arg0, arg1, arg2) {\n        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);\n        return ret;\n      },\n      __wbg_subarray_d51e89458b3fdbf6: function(arg0, arg1, arg2) {\n        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);\n        return ret;\n      },\n      __wbindgen_cast_0000000000000001: function(arg0) {\n        const ret = arg0;\n        return ret;\n      },\n      __wbindgen_cast_0000000000000002: function(arg0, arg1) {\n        const ret = getArrayF32FromWasm0(arg0, arg1);\n        return ret;\n      },\n      __wbindgen_cast_0000000000000003: function(arg0, arg1) {\n        const ret = getArrayU32FromWasm0(arg0, arg1);\n        return ret;\n      },\n      __wbindgen_cast_0000000000000004: function(arg0, arg1) {\n        const ret = getStringFromWasm0(arg0, arg1);\n        return ret;\n      },\n      __wbindgen_init_externref_table: function() {\n        const table = wasm.__wbindgen_externrefs;\n        const offset = table.grow(4);\n        table.set(0, void 0);\n        table.set(offset + 0, void 0);\n        table.set(offset + 1, null);\n        table.set(offset + 2, true);\n        table.set(offset + 3, false);\n      }\n    };\n    return {\n      __proto__: null,\n      "./gaussian_splat_rs_bg.js": import0\n    };\n  }\n  const ChunkDecoderFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {\n  }, unregister: () => {\n  } } : new FinalizationRegistry((ptr) => wasm.__wbg_chunkdecoder_free(ptr >>> 0, 1));\n  function addToExternrefTable0(obj) {\n    const idx = wasm.__externref_table_alloc();\n    wasm.__wbindgen_externrefs.set(idx, obj);\n    return idx;\n  }\n  function debugString(val) {\n    const type = typeof val;\n    if (type == "number" || type == "boolean" || val == null) {\n      return `${val}`;\n    }\n    if (type == "string") {\n      return `"${val}"`;\n    }\n    if (type == "symbol") {\n      const description = val.description;\n      if (description == null) {\n        return "Symbol";\n      } else {\n        return `Symbol(${description})`;\n      }\n    }\n    if (type == "function") {\n      const name = val.name;\n      if (typeof name == "string" && name.length > 0) {\n        return `Function(${name})`;\n      } else {\n        return "Function";\n      }\n    }\n    if (Array.isArray(val)) {\n      const length = val.length;\n      let debug = "[";\n      if (length > 0) {\n        debug += debugString(val[0]);\n      }\n      for (let i = 1; i < length; i++) {\n        debug += ", " + debugString(val[i]);\n      }\n      debug += "]";\n      return debug;\n    }\n    const builtInMatches = /\\[object ([^\\]]+)\\]/.exec(toString.call(val));\n    let className;\n    if (builtInMatches && builtInMatches.length > 1) {\n      className = builtInMatches[1];\n    } else {\n      return toString.call(val);\n    }\n    if (className == "Object") {\n      try {\n        return "Object(" + JSON.stringify(val) + ")";\n      } catch (_) {\n        return "Object";\n      }\n    }\n    if (val instanceof Error) {\n      return `${val.name}: ${val.message}\n${val.stack}`;\n    }\n    return className;\n  }\n  function getArrayF32FromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);\n  }\n  function getArrayF64FromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);\n  }\n  function getArrayU32FromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);\n  }\n  function getArrayU8FromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);\n  }\n  let cachedDataViewMemory0 = null;\n  function getDataViewMemory0() {\n    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {\n      cachedDataViewMemory0 = new DataView(wasm.memory.buffer);\n    }\n    return cachedDataViewMemory0;\n  }\n  let cachedFloat32ArrayMemory0 = null;\n  function getFloat32ArrayMemory0() {\n    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {\n      cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);\n    }\n    return cachedFloat32ArrayMemory0;\n  }\n  let cachedFloat64ArrayMemory0 = null;\n  function getFloat64ArrayMemory0() {\n    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {\n      cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);\n    }\n    return cachedFloat64ArrayMemory0;\n  }\n  function getStringFromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return decodeText(ptr, len);\n  }\n  let cachedUint32ArrayMemory0 = null;\n  function getUint32ArrayMemory0() {\n    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {\n      cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);\n    }\n    return cachedUint32ArrayMemory0;\n  }\n  let cachedUint8ArrayMemory0 = null;\n  function getUint8ArrayMemory0() {\n    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {\n      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);\n    }\n    return cachedUint8ArrayMemory0;\n  }\n  function handleError(f, args) {\n    try {\n      return f.apply(this, args);\n    } catch (e) {\n      const idx = addToExternrefTable0(e);\n      wasm.__wbindgen_exn_store(idx);\n    }\n  }\n  function isLikeNone(x) {\n    return x === void 0 || x === null;\n  }\n  function passStringToWasm0(arg, malloc, realloc) {\n    if (realloc === void 0) {\n      const buf = cachedTextEncoder.encode(arg);\n      const ptr2 = malloc(buf.length, 1) >>> 0;\n      getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);\n      WASM_VECTOR_LEN = buf.length;\n      return ptr2;\n    }\n    let len = arg.length;\n    let ptr = malloc(len, 1) >>> 0;\n    const mem = getUint8ArrayMemory0();\n    let offset = 0;\n    for (; offset < len; offset++) {\n      const code = arg.charCodeAt(offset);\n      if (code > 127) break;\n      mem[ptr + offset] = code;\n    }\n    if (offset !== len) {\n      if (offset !== 0) {\n        arg = arg.slice(offset);\n      }\n      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;\n      const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);\n      const ret = cachedTextEncoder.encodeInto(arg, view);\n      offset += ret.written;\n      ptr = realloc(ptr, len, offset, 1) >>> 0;\n    }\n    WASM_VECTOR_LEN = offset;\n    return ptr;\n  }\n  function takeFromExternrefTable0(idx) {\n    const value = wasm.__wbindgen_externrefs.get(idx);\n    wasm.__externref_table_dealloc(idx);\n    return value;\n  }\n  let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });\n  cachedTextDecoder.decode();\n  const MAX_SAFARI_DECODE_BYTES = 2146435072;\n  let numBytesDecoded = 0;\n  function decodeText(ptr, len) {\n    numBytesDecoded += len;\n    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {\n      cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });\n      cachedTextDecoder.decode();\n      numBytesDecoded = len;\n    }\n    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));\n  }\n  const cachedTextEncoder = new TextEncoder();\n  if (!("encodeInto" in cachedTextEncoder)) {\n    cachedTextEncoder.encodeInto = function(arg, view) {\n      const buf = cachedTextEncoder.encode(arg);\n      view.set(buf);\n      return {\n        read: arg.length,\n        written: buf.length\n      };\n    };\n  }\n  let WASM_VECTOR_LEN = 0;\n  let wasm;\n  function __wbg_finalize_init(instance, module) {\n    wasm = instance.exports;\n    cachedDataViewMemory0 = null;\n    cachedFloat32ArrayMemory0 = null;\n    cachedFloat64ArrayMemory0 = null;\n    cachedUint32ArrayMemory0 = null;\n    cachedUint8ArrayMemory0 = null;\n    wasm.__wbindgen_start();\n    return wasm;\n  }\n  async function __wbg_load(module, imports) {\n    if (typeof Response === "function" && module instanceof Response) {\n      if (typeof WebAssembly.instantiateStreaming === "function") {\n        try {\n          return await WebAssembly.instantiateStreaming(module, imports);\n        } catch (e) {\n          const validResponse = module.ok && expectedResponseType(module.type);\n          if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {\n            console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\\n", e);\n          } else {\n            throw e;\n          }\n        }\n      }\n      const bytes = await module.arrayBuffer();\n      return await WebAssembly.instantiate(bytes, imports);\n    } else {\n      const instance = await WebAssembly.instantiate(module, imports);\n      if (instance instanceof WebAssembly.Instance) {\n        return { instance, module };\n      } else {\n        return instance;\n      }\n    }\n    function expectedResponseType(type) {\n      switch (type) {\n        case "basic":\n        case "cors":\n        case "default":\n          return true;\n      }\n      return false;\n    }\n  }\n  async function __wbg_init(module_or_path) {\n    if (wasm !== void 0) return wasm;\n    if (module_or_path !== void 0) {\n      if (Object.getPrototypeOf(module_or_path) === Object.prototype) {\n        ({ module_or_path } = module_or_path);\n      } else {\n        console.warn("using deprecated parameters for the initialization function; pass a single object instead");\n      }\n    }\n    const imports = __wbg_get_imports();\n    if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {\n      module_or_path = fetch(module_or_path);\n    }\n    const { instance } = await __wbg_load(await module_or_path, imports);\n    return __wbg_finalize_init(instance);\n  }\n  const rpcHandlers = {\n    setSortCenterState,\n    sortCenters32,\n    loadSplats,\n    nextChunk\n  };\n  function setSortCenterState({\n    updateRangeIndices,\n    updateCenters,\n    rangeMeshIds,\n    rangeBases,\n    rangeCounts,\n    rangeOrigins\n  }) {\n    set_sort_center_state(\n      updateRangeIndices,\n      updateCenters,\n      rangeMeshIds,\n      rangeBases,\n      rangeCounts,\n      rangeOrigins\n    );\n  }\n  function sortCenters32({\n    numSplats,\n    cameraPosition,\n    direction,\n    radial,\n    ordering\n  }) {\n    const activeSplats = sort32_centers(\n      numSplats,\n      cameraPosition[0],\n      cameraPosition[1],\n      cameraPosition[2],\n      direction[0],\n      direction[1],\n      direction[2],\n      radial,\n      ordering\n    );\n    return { activeSplats, ordering };\n  }\n  async function onMessage(event) {\n    const {\n      id,\n      name,\n      args\n    } = event.data;\n    try {\n      const handler = rpcHandlers[name];\n      if (!handler) {\n        throw new Error(`Unknown worker RPC: ${name}`);\n      }\n      const sendStatus = (data) => {\n        self.postMessage(\n          { id, status: data },\n          { transfer: getTransferable(data) }\n        );\n      };\n      const result = await handler(args, { sendStatus });\n      self.postMessage({ id, result }, { transfer: getTransferable(result) });\n    } catch (error) {\n      console.warn(`Worker error: ${error}`);\n      self.postMessage({ id, error }, { transfer: getTransferable(error) });\n    }\n  }\n  async function decodeBytesUrl({\n    decoder,\n    fileBytes,\n    url,\n    requestHeader,\n    withCredentials,\n    chunked,\n    chunkedLength,\n    sendStatus\n  }) {\n    let readStream;\n    let streamLength = 0;\n    let expectedInputLength = 0;\n    const suppliedInputLength = chunkedLength ?? 0;\n    if (!Number.isSafeInteger(suppliedInputLength) || suppliedInputLength < 0) {\n      throw new Error("streamLength must be an exact non-negative integer");\n    }\n    if (fileBytes) {\n      readStream = new ReadableStream({\n        start(controller) {\n          controller.enqueue(fileBytes);\n          controller.close();\n        }\n      });\n      streamLength = fileBytes.length;\n      expectedInputLength = streamLength;\n    } else if (url) {\n      const request = new Request(url, {\n        headers: requestHeader ? new Headers(requestHeader) : void 0,\n        credentials: withCredentials ? "include" : "same-origin"\n      });\n      const response = await fetch(request);\n      if (!response.ok || !response.body) {\n        throw new Error(\n          `Failed to fetch "${url}": ${response.status} ${response.statusText}`\n        );\n      }\n      readStream = response.body;\n      const contentLength = Number(response.headers.get("Content-Length") || "0");\n      const responseLength = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0;\n      streamLength = suppliedInputLength || responseLength;\n      const contentEncoding = response.headers.get("Content-Encoding");\n      const hasIdentityEncoding = !contentEncoding || contentEncoding.toLowerCase() === "identity";\n      if (suppliedInputLength > 0) {\n        expectedInputLength = suppliedInputLength;\n      } else if (response.type === "basic" && hasIdentityEncoding) {\n        expectedInputLength = responseLength;\n      }\n    } else if (chunked) {\n      readStream = new ReadableStream(\n        {\n          async pull(controller) {\n            const readNextChunk = new Promise((resolve) => {\n              nextChunkWaiter = resolve;\n            });\n            sendStatus({ nextChunk: true });\n            const chunk = await readNextChunk;\n            if (chunk.length === 0) {\n              controller.close();\n            } else {\n              controller.enqueue(chunk);\n            }\n          }\n        },\n        { highWaterMark: 0 }\n      );\n      streamLength = suppliedInputLength;\n      expectedInputLength = streamLength;\n    } else {\n      throw new Error("No url or fileBytes provided");\n    }\n    if (expectedInputLength > 0) {\n      decoder.set_expected_input_size(expectedInputLength);\n    }\n    const reader = readStream.getReader();\n    let loaded = 0;\n    try {\n      while (true) {\n        const { done, value } = await reader.read();\n        if (done) {\n          break;\n        }\n        loaded += value.length;\n        if (expectedInputLength > 0 && loaded > expectedInputLength) {\n          throw new Error(\n            `Input length exceeds the expected ${expectedInputLength} bytes`\n          );\n        }\n        sendStatus({ loaded, total: streamLength });\n        decoder.push(value);\n      }\n      if (expectedInputLength > 0 && loaded !== expectedInputLength) {\n        throw new Error(\n          `Input length mismatch: expected ${expectedInputLength} bytes, received ${loaded}`\n        );\n      }\n      if (chunked && streamLength === 0) {\n        sendStatus({ loaded, total: loaded });\n      }\n      return decoder.finish();\n    } catch (error) {\n      try {\n        await reader.cancel(error);\n      } catch {\n      }\n      throw error;\n    } finally {\n      reader.releaseLock();\n    }\n  }\n  function toSplatResult(decoded) {\n    return {\n      numSplats: decoded.numSplats,\n      splatArrays: [decoded.splat0, decoded.splat1],\n      extra: {\n        sh1: decoded.sh1,\n        sh2: decoded.sh2,\n        sh3a: decoded.sh3a,\n        sh3b: decoded.sh3b\n      }\n    };\n  }\n  async function loadSplats({\n    url,\n    requestHeader,\n    withCredentials,\n    fileBytes,\n    fileType,\n    pathName,\n    chunked,\n    chunkedLength\n  }, { sendStatus }) {\n    const decoder = decode_to_splats(fileType, pathName ?? url);\n    const decoded = await decodeBytesUrl({\n      decoder,\n      fileBytes,\n      url,\n      requestHeader,\n      withCredentials,\n      chunked,\n      chunkedLength,\n      sendStatus\n    });\n    return toSplatResult(decoded);\n  }\n  let nextChunkWaiter = (_chunk) => {\n  };\n  async function nextChunk({ chunk }) {\n    nextChunkWaiter(chunk);\n  }\n  function getTransferable(ctx) {\n    const buffers = [];\n    const seen = /* @__PURE__ */ new Set();\n    function traverse(obj) {\n      if (obj && typeof obj === "object" && !seen.has(obj)) {\n        seen.add(obj);\n        if (obj instanceof ArrayBuffer) {\n          buffers.push(obj);\n        } else if (ArrayBuffer.isView(obj)) {\n          buffers.push(obj.buffer);\n        } else if (Array.isArray(obj)) {\n          obj.forEach(traverse);\n        } else {\n          Object.values(obj).forEach(traverse);\n        }\n      }\n    }\n    traverse(ctx);\n    return buffers;\n  }\n  async function initialize() {\n    let resolveWaitForModule;\n    const waitForModule = new Promise((resolve) => {\n      resolveWaitForModule = resolve;\n    });\n    const pending = [];\n    const bufferMessage = (event) => {\n      if (event.data.name === "init-wasm") {\n        resolveWaitForModule(event.data.module);\n        return;\n      }\n      pending.push(event);\n    };\n    self.addEventListener("message", bufferMessage);\n    await __wbg_init({ module_or_path: await waitForModule });\n    self.removeEventListener("message", bufferMessage);\n    self.addEventListener("message", onMessage);\n    for (const event of pending) {\n      onMessage(event);\n    }\n    pending.length = 0;\n  }\n  initialize().catch(console.error);\n})();\n//# sourceMappingURL=worker-LSPxjzAW.js.map\n';
const blob = typeof self !== "undefined" && self.Blob && new Blob([jsContent], { type: "text/javascript;charset=utf-8" });
function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
    if (!objURL) throw "";
    const worker = new Worker(objURL, {
      name: options == null ? void 0 : options.name
    });
    worker.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(objURL);
    });
    return worker;
  } catch (e) {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent),
      {
        name: options == null ? void 0 : options.name
      }
    );
  } finally {
    objURL && (self.URL || self.webkitURL).revokeObjectURL(objURL);
  }
}
const _SplatWorker = class _SplatWorker {
  constructor() {
    this.messages = {};
    this.worker = new WorkerWrapper();
    this.worker.onmessage = (event) => this.onMessage(event);
    WASM_MODULE.then((module2) => {
      this.worker.postMessage({ name: "init-wasm", module: module2 });
    });
  }
  onMessage(event) {
    const { id, result, error, status } = event.data;
    const promise = this.messages[id];
    if (!promise) return;
    if (status !== void 0) {
      promise.statusQueue = promise.statusQueue.then(() => {
        var _a;
        if (this.messages[id] === promise) {
          return (_a = promise.onStatus) == null ? void 0 : _a.call(promise, status);
        }
      });
      void promise.statusQueue.catch(() => {
      });
      return;
    }
    void promise.statusQueue.then(() => {
      if (error !== void 0) throw error;
      return result;
    }).finally(() => {
      delete this.messages[id];
    }).then(promise.resolve, promise.reject);
  }
  async call(name, args, options = {}) {
    const id = ++_SplatWorker.currentId;
    const promise = new Promise((resolve, reject) => {
      this.messages[id] = {
        resolve: (value) => resolve(value),
        reject,
        onStatus: options.onStatus,
        statusQueue: Promise.resolve()
      };
    });
    this.worker.postMessage(
      { id, name, args },
      { transfer: getTransferable(args) }
    );
    return promise;
  }
  dispose() {
    this.worker.terminate();
    const messages = Object.values(this.messages);
    this.messages = {};
    for (const message of messages) {
      message.reject(new Error("Worker terminate"));
    }
  }
};
_SplatWorker.currentId = 0;
let SplatWorker = _SplatWorker;
const IDLE_WORKER_TIMEOUT_MS = 3e3;
class SplatWorkerPool {
  constructor(maxWorkers = 4) {
    this.numWorkers = 0;
    this.freelist = [];
    this.idleWorkerTimeouts = /* @__PURE__ */ new Map();
    this.queue = [];
    this.maxWorkers = maxWorkers;
  }
  async withWorker(callback) {
    const worker = await this.allocWorker();
    try {
      return await callback(worker);
    } finally {
      this.freeWorker(worker);
    }
  }
  async allocWorker() {
    const worker = this.freelist.pop();
    if (worker) {
      const timeout = this.idleWorkerTimeouts.get(worker);
      if (timeout !== void 0) {
        clearTimeout(timeout);
        this.idleWorkerTimeouts.delete(worker);
      }
      return worker;
    }
    if (this.numWorkers < this.maxWorkers) {
      const worker2 = new SplatWorker();
      this.numWorkers += 1;
      return worker2;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  freeWorker(worker) {
    if (this.numWorkers > this.maxWorkers) {
      worker.dispose();
      this.numWorkers -= 1;
      return;
    }
    const waiter = this.queue.shift();
    if (waiter) {
      waiter(worker);
      return;
    }
    this.freelist.push(worker);
    const timeout = setTimeout(() => {
      this.idleWorkerTimeouts.delete(worker);
      const index = this.freelist.indexOf(worker);
      if (index === -1) return;
      this.freelist.splice(index, 1);
      worker.dispose();
      this.numWorkers -= 1;
    }, IDLE_WORKER_TIMEOUT_MS);
    this.idleWorkerTimeouts.set(worker, timeout);
  }
}
const workerPool = new SplatWorkerPool();
class SplatLoader extends THREE.Loader {
  load(url, onLoad, onProgress, onError) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }
  async loadAsync(url, onProgress) {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, onProgress, reject);
    });
  }
  parse(splats) {
    return new SplatMesh({ splats });
  }
  loadInternal({
    splats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onLoad,
    onProgress,
    onError
  }) {
    const byteArray = fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
    const resolvedURL = byteArray ? void 0 : this.manager.resolveURL((this.path ?? "") + (url ?? ""));
    let readStream = stream == null ? void 0 : stream.getReader();
    this.manager.itemStart(resolvedURL ?? "");
    workerPool.withWorker(async (worker) => {
      const onStatus = async (data) => {
        const { loaded, total } = data;
        if (loaded !== void 0 && onProgress) {
          try {
            onProgress(
              new ProgressEvent("progress", {
                lengthComputable: total !== 0,
                loaded,
                total: total ?? 0
              })
            );
          } catch (error) {
            console.error("Progress callback failed", error);
          }
        }
        if (data.nextChunk) {
          let chunk;
          if (!readStream) {
            chunk = new Uint8Array(0);
          } else {
            const { done, value } = await readStream.read().catch(async (error) => {
              await worker.call("nextChunk", { chunk: new Uint8Array(0) });
              throw error;
            });
            if (done) {
              readStream.releaseLock();
              readStream = void 0;
              chunk = new Uint8Array(0);
            } else {
              chunk = value;
            }
          }
          await worker.call("nextChunk", { chunk });
        }
      };
      const basedUrl = resolvedURL ? new URL(resolvedURL, window.location.href).toString() : void 0;
      const decoded = await worker.call(
        "loadSplats",
        {
          url: basedUrl,
          requestHeader: this.requestHeader,
          withCredentials: this.withCredentials,
          fileBytes: byteArray == null ? void 0 : byteArray.slice(),
          fileType,
          pathName: resolvedURL || fileName,
          chunked: stream !== void 0,
          chunkedLength: streamLength
        },
        { onStatus }
      );
      const result = splats ?? new Splats();
      result.initialize(decoded);
      onLoad == null ? void 0 : onLoad(result);
    }).catch(async (error) => {
      if (readStream) {
        try {
          await readStream.cancel(error);
        } catch {
        }
        readStream.releaseLock();
        readStream = void 0;
      }
      this.manager.itemError(resolvedURL ?? "");
      onError == null ? void 0 : onError(error);
    }).finally(() => {
      this.manager.itemEnd(resolvedURL ?? "");
    });
  }
  async loadInternalAsync({
    splats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onProgress
  }) {
    return new Promise((resolve, reject) => {
      this.loadInternal({
        splats,
        url,
        fileBytes,
        fileType,
        fileName,
        stream,
        streamLength,
        onLoad: resolve,
        onProgress,
        onError: reject
      });
    });
  }
}
const _Splats = class _Splats {
  constructor(options = {}) {
    this.maxSplats = 0;
    this.numSplats = 0;
    this.splatArrays = [
      new Uint32Array(0),
      new Uint32Array(0)
    ];
    this.extra = {};
    this.isInitialized = false;
    this.needsUpdate = true;
    this.shTextures = {};
    this.textures = [_Splats.emptyTexture, _Splats.emptyTexture];
    this.initialized = Promise.resolve(this);
    this.reinitialize(options);
  }
  reinitialize(options) {
    this.isInitialized = false;
    this.disposeTextures();
    this.extra = {};
    this.maxSplats = options.maxSplats ?? 0;
    this.needsUpdate = true;
    if (options.url || options.fileBytes || options.stream || options.construct) {
      this.initialized = this.asyncInitialize(options).then(() => {
        this.isInitialized = true;
        return this;
      });
    } else {
      this.initialize(options);
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
    }
  }
  initialize(options) {
    this.disposeTextures();
    this.extra = options.extra ?? {};
    if (options.splatArrays) {
      this.splatArrays = options.splatArrays;
      this.maxSplats = Math.floor(
        Math.min(this.splatArrays[0].length, this.splatArrays[1].length) / 4
      );
      this.maxSplats = Math.floor(this.maxSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      this.numSplats = Math.min(
        this.maxSplats,
        options.numSplats ?? this.maxSplats
      );
    } else {
      this.maxSplats = options.maxSplats ?? 0;
      this.numSplats = 0;
      this.splatArrays = [new Uint32Array(0), new Uint32Array(0)];
    }
    this.needsUpdate = true;
  }
  async asyncInitialize(options) {
    var _a;
    const loader = new SplatLoader();
    if (options.fileBytes || options.url || options.stream) {
      await loader.loadInternalAsync({
        splats: this,
        url: options.url,
        fileBytes: options.fileBytes,
        fileType: options.fileType,
        fileName: options.fileName,
        stream: options.stream,
        streamLength: options.streamLength,
        onProgress: options.onProgress
      });
    }
    const maybePromise = (_a = options.construct) == null ? void 0 : _a.call(options, this);
    if (maybePromise instanceof Promise) {
      await maybePromise;
    }
  }
  dispose() {
    this.disposeTextures();
    this.splatArrays = [new Uint32Array(0), new Uint32Array(0)];
    this.extra = {};
  }
  disposeTextures() {
    for (const texture of this.textures ?? []) {
      if (texture !== _Splats.emptyTexture) {
        texture.dispose();
      }
    }
    this.textures = [_Splats.emptyTexture, _Splats.emptyTexture];
    for (const texture of Object.values(this.shTextures ?? {})) {
      texture == null ? void 0 : texture.dispose();
    }
    this.shTextures = {};
  }
  getNumSplats() {
    return this.numSplats;
  }
  getNumSh() {
    return !this.extra.sh1 ? 0 : !this.extra.sh2 ? 1 : !this.extra.sh3a || !this.extra.sh3b ? 2 : 3;
  }
  ensureSplats(numSplats) {
    const currentCapacity = this.splatArrays[0].length / 4;
    const targetSize = numSplats <= this.maxSplats ? this.maxSplats : Math.max(numSplats, 2 * this.maxSplats);
    if (targetSize > currentCapacity) {
      this.maxSplats = getTextureSize(Math.max(1, targetSize)).maxSplats;
      const first = new Uint32Array(this.maxSplats * 4);
      const second = new Uint32Array(this.maxSplats * 4);
      first.set(this.splatArrays[0]);
      second.set(this.splatArrays[1]);
      this.splatArrays = [first, second];
      this.needsUpdate = true;
    }
    return this.splatArrays;
  }
  getSplat(index) {
    if (index < 0 || index >= this.numSplats) {
      throw new Error("Invalid splat index");
    }
    return decodeSplat(this.splatArrays, index);
  }
  setSplat(index, center, scales, quaternion, opacity, color) {
    const arrays = this.ensureSplats(index + 1);
    encodeSplat(
      arrays,
      index,
      center.x,
      center.y,
      center.z,
      scales.x,
      scales.y,
      scales.z,
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
      opacity,
      color.r,
      color.g,
      color.b
    );
    this.numSplats = Math.max(this.numSplats, index + 1);
    this.needsUpdate = true;
  }
  pushSplat(center, scales, quaternion, opacity, color) {
    this.setSplat(this.numSplats, center, scales, quaternion, opacity, color);
  }
  forEachCenter(callback) {
    const [splatA, splatB] = this.splatArrays;
    const centerView = new Float32Array(
      splatA.buffer,
      splatA.byteOffset,
      splatA.length
    );
    for (let index = 0; index < this.numSplats; index += 1) {
      const i4 = index * 4;
      const scaleX = splatB[i4 + 1] >>> 16;
      const scaleY = splatB[i4 + 2] & 65535;
      const scaleZ = splatB[i4 + 2] >>> 16;
      if (scaleX === 64512 && scaleY === 64512 && scaleZ === 64512) {
        callback(index, Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      callback(index, centerView[i4], centerView[i4 + 1], centerView[i4 + 2]);
    }
  }
  forEachSplat(callback) {
    for (let index = 0; index < this.numSplats; index += 1) {
      const splat = decodeSplat(this.splatArrays, index);
      callback(
        index,
        splat.center,
        splat.scales,
        splat.quaternion,
        splat.opacity,
        splat.color
      );
    }
  }
  getSplatTextures() {
    if (this.maxSplats === 0 || this.splatArrays[0].length === 0) {
      return [_Splats.emptyTexture, _Splats.emptyTexture];
    }
    const { width, height, depth } = getTextureSize(this.maxSplats);
    const textureData = this.textures[0].image.data;
    const incompatible = this.textures[0] === _Splats.emptyTexture || this.textures[0].image.width !== width || this.textures[0].image.height !== height || this.textures[0].image.depth !== depth || textureData === null || textureData.buffer !== this.splatArrays[0].buffer;
    if (incompatible) {
      this.disposeMainTextures();
      this.textures = [
        newUintArrayTexture(this.splatArrays[0], width, height, depth),
        newUintArrayTexture(this.splatArrays[1], width, height, depth)
      ];
    } else if (this.needsUpdate) {
      this.textures[0].needsUpdate = true;
      this.textures[1].needsUpdate = true;
    }
    return this.textures;
  }
  disposeMainTextures() {
    for (const texture of this.textures) {
      if (texture !== _Splats.emptyTexture) {
        texture.dispose();
      }
    }
    this.textures = [_Splats.emptyTexture, _Splats.emptyTexture];
  }
  getShTextures() {
    this.shTextures.sh1 = this.ensureShTexture("sh1", this.shTextures.sh1);
    this.shTextures.sh2 = this.ensureShTexture("sh2", this.shTextures.sh2);
    this.shTextures.sh3a = this.ensureShTexture("sh3a", this.shTextures.sh3a);
    this.shTextures.sh3b = this.ensureShTexture("sh3b", this.shTextures.sh3b);
    return this.shTextures;
  }
  ensureShTexture(key, current) {
    let texture = current;
    const data = this.extra[key];
    if (!data) {
      texture == null ? void 0 : texture.dispose();
      return void 0;
    }
    const { width, height, depth, maxSplats } = getTextureSize(
      Math.max(1, data.length / 4)
    );
    let padded = data;
    if (data.length < maxSplats * 4) {
      padded = new Uint32Array(maxSplats * 4);
      padded.set(data);
      this.extra[key] = padded;
    }
    const incompatible = texture && (texture.image.width !== width || texture.image.height !== height || texture.image.depth !== depth || texture.image.data === null || texture.image.data.buffer !== padded.buffer);
    if (incompatible) {
      texture == null ? void 0 : texture.dispose();
      texture = void 0;
    }
    if (!texture) {
      texture = newUintArrayTexture(padded, width, height, depth);
    } else if (this.needsUpdate) {
      texture.needsUpdate = true;
    }
    return texture;
  }
};
_Splats.emptyTexture = newUintArrayTexture(null, 1, 1, 1);
let Splats = _Splats;
function newUintArrayTexture(data, width, height, depth) {
  const texture = new THREE__namespace.DataArrayTexture(
    data,
    width,
    height,
    depth
  );
  texture.format = THREE__namespace.RGBAIntegerFormat;
  texture.type = THREE__namespace.UnsignedIntType;
  texture.internalFormat = "RGBA32UI";
  texture.magFilter = THREE__namespace.NearestFilter;
  texture.minFilter = THREE__namespace.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
const raycastWorldToMesh = new THREE__namespace.Matrix4();
const raycastDirectionMatrix = new THREE__namespace.Matrix3();
const raycastOrigin = new THREE__namespace.Vector3();
const raycastDirection = new THREE__namespace.Vector3();
class SplatMesh extends THREE__namespace.Object3D {
  constructor(options = {}) {
    var _a;
    super();
    this.isInitialized = false;
    this.numSplats = 0;
    this.recolor = new THREE__namespace.Color(1, 1, 1);
    this.opacity = 1;
    this.maxSh = 3;
    this.edits = null;
    this.sdfEdits = null;
    this.version = 0;
    this.sortVersion = 0;
    this.mappingVersion = 0;
    this.lastNumSplats = -1;
    this.lastMaxSh = -1;
    this.lastMatrixWorld = new THREE__namespace.Matrix4();
    this.hasLastMatrixWorld = false;
    this.lastRecolor = new THREE__namespace.Vector4().setScalar(Number.NaN);
    this.viewOrigin = new THREE__namespace.Vector3();
    this.lastViewOrigin = new THREE__namespace.Vector3().setScalar(Number.NaN);
    this.sdfCoordinateOrigin = new THREE__namespace.Vector3();
    this.splats = options.splats ?? new Splats({ maxSplats: options.maxSplats });
    this.numSplats = this.splats.getNumSplats();
    this.editable = options.editable ?? true;
    this.raycastable = options.raycastable ?? true;
    this.minRaycastOpacity = options.minRaycastOpacity ?? 0.05;
    this.onFrame = options.onFrame;
    const mutableSplats = this.splats instanceof Splats ? this.splats : void 0;
    const needsAsyncInitialization = Boolean(
      mutableSplats && (options.url || options.fileBytes || options.stream || options.constructSplats || !mutableSplats.isInitialized)
    );
    if (needsAsyncInitialization) {
      this.initialized = this.asyncInitialize(options).then(async () => {
        var _a2;
        this.isInitialized = true;
        await ((_a2 = options.onLoad) == null ? void 0 : _a2.call(options, this));
        return this;
      });
    } else {
      this.isInitialized = true;
      const maybePromise = (_a = options.onLoad) == null ? void 0 : _a.call(options, this);
      this.initialized = maybePromise instanceof Promise ? maybePromise.then(() => this) : Promise.resolve(this);
    }
  }
  async asyncInitialize(options) {
    var _a;
    const splats = this.splats;
    if (splats instanceof Splats) {
      if (options.url || options.fileBytes || options.stream || options.constructSplats) {
        splats.reinitialize({
          url: options.url,
          fileBytes: options.fileBytes,
          fileType: options.fileType,
          fileName: options.fileName,
          stream: options.stream,
          streamLength: options.streamLength,
          maxSplats: options.maxSplats,
          construct: options.constructSplats,
          onProgress: options.onProgress
        });
      }
      await splats.initialized;
    }
    this.numSplats = ((_a = this.splats) == null ? void 0 : _a.getNumSplats()) ?? 0;
    this.updateMappingVersion();
  }
  pushSplat(center, scales, quaternion, opacity, color) {
    var _a;
    if (this.splats instanceof Splats) {
      this.splats.pushSplat(center, scales, quaternion, opacity, color);
    }
    this.numSplats = ((_a = this.splats) == null ? void 0 : _a.getNumSplats()) ?? this.numSplats;
  }
  forEachSplat(callback) {
    var _a;
    (_a = this.splats) == null ? void 0 : _a.forEachSplat(callback);
  }
  dispose() {
    var _a, _b;
    (_a = this.sdfEdits) == null ? void 0 : _a.dispose();
    this.sdfEdits = null;
    (_b = this.splats) == null ? void 0 : _b.dispose();
    this.splats = void 0;
  }
  getBoundingBox(centersOnly = true) {
    var _a, _b;
    if (!this.isInitialized) {
      throw new Error(
        "Cannot get bounding box before SplatMesh is initialized"
      );
    }
    const minimum = new THREE__namespace.Vector3().setScalar(Number.POSITIVE_INFINITY);
    const maximum = new THREE__namespace.Vector3().setScalar(Number.NEGATIVE_INFINITY);
    const corner = new THREE__namespace.Vector3();
    if (centersOnly) {
      (_a = this.splats) == null ? void 0 : _a.forEachCenter((_index, x, y, z) => {
        if (Number.isNaN(x)) return;
        corner.set(x, y, z);
        minimum.min(corner);
        maximum.max(corner);
      });
      return new THREE__namespace.Box3(minimum, maximum);
    }
    const signs = [-1, 1];
    (_b = this.splats) == null ? void 0 : _b.forEachSplat((_index, center, scales, quaternion) => {
      for (const x of signs) {
        for (const y of signs) {
          for (const z of signs) {
            corner.set(x * scales.x, y * scales.y, z * scales.z).applyQuaternion(quaternion).add(center);
            minimum.min(corner);
            maximum.max(corner);
          }
        }
      }
    });
    return new THREE__namespace.Box3(minimum, maximum);
  }
  frameUpdate({ time, deltaTime, camera, globalEdits }) {
    var _a, _b;
    (_a = this.onFrame) == null ? void 0 : _a.call(this, { mesh: this, time, deltaTime });
    const source = this.splats;
    if (!source) {
      return;
    }
    this.splats = source;
    let updated = false;
    let sortUpdated = false;
    const count = source.getNumSplats();
    if (source !== this.lastSource) {
      this.lastSource = source;
      updated = true;
      sortUpdated = true;
    }
    if (count !== this.lastNumSplats) {
      this.lastNumSplats = count;
      this.numSplats = count;
      this.mappingVersion += 1;
      updated = true;
      sortUpdated = true;
    }
    if (source.needsUpdate) {
      updated = true;
      sortUpdated = true;
    }
    if (this.maxSh !== this.lastMaxSh) {
      this.lastMaxSh = this.maxSh;
      updated = true;
    }
    if (this.maxSh > 0 && source.getNumSh() > 0) {
      camera.getWorldPosition(this.viewOrigin);
      if (!this.viewOrigin.equals(this.lastViewOrigin)) {
        this.lastViewOrigin.copy(this.viewOrigin);
        updated = true;
      }
    }
    this.updateWorldMatrix(true, false);
    if (!this.hasLastMatrixWorld || !this.lastMatrixWorld.equals(this.matrixWorld)) {
      this.lastMatrixWorld.copy(this.matrixWorld);
      this.hasLastMatrixWorld = true;
      updated = true;
      sortUpdated = true;
    }
    const recolor = new THREE__namespace.Vector4(
      this.recolor.r,
      this.recolor.g,
      this.recolor.b,
      this.opacity
    );
    if (!recolor.equals(this.lastRecolor)) {
      this.lastRecolor.copy(recolor);
      updated = true;
    }
    const edits = /* @__PURE__ */ new Set();
    if (this.editable) {
      for (const edit of globalEdits) edits.add(edit);
      if (this.edits) {
        for (const edit of this.edits) edits.add(edit);
      } else {
        this.traverseVisible((node) => {
          if (node instanceof SplatEdit) edits.add(node);
        });
      }
    }
    const orderedEdits = Array.from(edits).sort(
      (left, right) => left.ordering - right.ordering
    );
    const groups = orderedEdits.map((edit) => {
      if (edit.sdfs) return { edit, sdfs: edit.sdfs };
      const sdfs = [];
      edit.traverseVisible((node) => {
        if (node instanceof SplatEditSdf) sdfs.push(node);
      });
      return { edit, sdfs };
    });
    if (groups.length > 0 && !this.sdfEdits) {
      this.sdfEdits = new SplatEdits({
        maxEdits: groups.length,
        maxSdfs: groups.reduce((total, group) => total + group.sdfs.length, 0)
      });
      updated = true;
    }
    const sdfCoordinateOrigin = this.sdfCoordinateOrigin.setFromMatrixPosition(
      this.matrixWorld
    );
    if ((_b = this.sdfEdits) == null ? void 0 : _b.update(groups, sdfCoordinateOrigin).updated) {
      updated = true;
    }
    if (updated) {
      this.updateVersion({ sort: sortUpdated });
    }
  }
  updateVersion({ sort = true } = {}) {
    this.version += 1;
    if (sort) this.sortVersion += 1;
  }
  updateMappingVersion() {
    this.mappingVersion += 1;
    this.updateVersion();
  }
  set needsUpdate(value) {
    if (value) this.updateVersion();
  }
  raycast(raycaster, intersects) {
    if (!isInitialized() || !this.raycastable || !(this.splats instanceof Splats)) {
      return;
    }
    const { near, far, ray } = raycaster;
    if (this.numSplats === 0 || !Number.isFinite(this.minRaycastOpacity) || this.minRaycastOpacity >= 1 || near > far) {
      return;
    }
    const worldToMesh = raycastWorldToMesh.copy(this.matrixWorld).invert();
    const origin = raycastOrigin.copy(ray.origin).applyMatrix4(worldToMesh);
    const direction = raycastDirection.copy(ray.direction).applyMatrix3(raycastDirectionMatrix.setFromMatrix4(worldToMesh));
    const buffer = get_raycast_buffer();
    const buffer2 = get_raycast_buffer2();
    const capacity = buffer.length / 4;
    const [first, second] = this.splats.splatArrays;
    for (let base = 0; base < this.numSplats; base += capacity) {
      const count = Math.min(capacity, this.numSplats - base);
      buffer.set(first.subarray(base * 4, (base + count) * 4));
      buffer2.set(second.subarray(base * 4, (base + count) * 4));
      const distances = raycast_splat_buffers(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        this.minRaycastOpacity,
        near,
        far,
        count
      );
      for (let index = 0; index < distances.length; index += 1) {
        const distance = distances[index];
        intersects.push({
          distance,
          point: ray.at(distance, new THREE__namespace.Vector3()),
          object: this
        });
      }
    }
  }
}
var splatDefines_default = "const uint SPLAT_TEX_WIDTH_BITS = 11u;\nconst uint SPLAT_TEX_HEIGHT_BITS = 11u;\nconst uint SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;\n\nconst uint SPLAT_TEX_WIDTH = 1u << SPLAT_TEX_WIDTH_BITS;\nconst uint SPLAT_TEX_HEIGHT = 1u << SPLAT_TEX_HEIGHT_BITS;\n\nconst uint SPLAT_TEX_WIDTH_MASK = SPLAT_TEX_WIDTH - 1u;\nconst uint SPLAT_TEX_HEIGHT_MASK = SPLAT_TEX_HEIGHT - 1u;\n\nconst float PI = 3.1415926535897932384626433832795;\n\nconst float INFINITY = 1.0 / 0.0;\n\nvec3 srgbToLinear(vec3 rgb) {\n    return pow(rgb, vec3(2.2));\n}\n\nuint encodeQuatOctXy1010R12(vec4 q) {\n    \n    if (q.w < 0.0) {\n        q = -q;\n    }\n    \n    float halfTheta = acos(q.w);\n    float theta = 2.0 * halfTheta;\n    float s = sin(halfTheta);\n    \n    vec3 axis = (abs(s) < 1e-6) ? vec3(1.0, 0.0, 0.0) : q.xyz / s;\n    \n    \n    \n    float sum = abs(axis.x) + abs(axis.y) + abs(axis.z);\n    vec2 p = vec2(axis.x, axis.y) / sum;\n    \n    if (axis.z < 0.0) {\n        float oldPx = p.x;\n        p.x = (1.0 - abs(p.y)) * (p.x >= 0.0 ? 1.0 : -1.0);\n        p.y = (1.0 - abs(oldPx)) * (p.y >= 0.0 ? 1.0 : -1.0);\n    }\n    \n    float u_f = p.x * 0.5 + 0.5;\n    float v_f = p.y * 0.5 + 0.5;\n    \n    uint quantU = uint(clamp(round(u_f * 1023.0), 0.0, 1023.0));\n    uint quantV = uint(clamp(round(v_f * 1023.0), 0.0, 1023.0));\n    \n    \n    \n    uint angleInt = uint(clamp(round((theta / PI) * 4095.0), 0.0, 4095.0));\n    \n    \n    return (angleInt << 20u) | (quantV << 10u) | quantU;\n}\n\nvec4 decodeQuatOctXy1010R12(uint encoded) {\n    \n    uint quantU = encoded & uint(0x3FFu);               \n    uint quantV = (encoded >> 10u) & uint(0x3FFu);         \n    uint angleInt = encoded >> 20u;                      \n\n    \n    float u_f = float(quantU) / 1023.0;\n    float v_f = float(quantV) / 1023.0;\n    vec2 f = vec2(u_f * 2.0 - 1.0, v_f * 2.0 - 1.0);\n\n    vec3 axis = vec3(f.xy, 1.0 - abs(f.x) - abs(f.y));\n    float t = max(-axis.z, 0.0);\n    axis.x += (axis.x >= 0.0) ? -t : t;\n    axis.y += (axis.y >= 0.0) ? -t : t;\n    axis = normalize(axis);\n    \n    \n    float theta = (float(angleInt) / 4095.0) * PI;\n    float halfTheta = theta * 0.5;\n    float s = sin(halfTheta);\n    float w = cos(halfTheta);\n    \n    return vec4(axis * s, w);\n}\n\nvec3 decodeSplatCenter(uvec4 splatData) {\n    return vec3(\n        uintBitsToFloat(splatData.x),\n        uintBitsToFloat(splatData.y),\n        uintBitsToFloat(splatData.z)\n    );\n}\n\nvoid encodeSplatLnScale(\n    out uvec4 splatData, out uvec4 splatData2,\n    vec3 center, vec3 lnScales, vec4 quaternion, vec4 rgba, float shapeAmount\n) {\n    splatData.x = floatBitsToUint(center.x);\n    splatData.y = floatBitsToUint(center.y);\n    splatData.z = floatBitsToUint(center.z);\n    splatData.w = packHalf2x16(clamp(vec2(rgba.a, shapeAmount), 0.0, 1.0));\n\n    splatData2.x = packHalf2x16(rgba.rg);\n    splatData2.y = packHalf2x16(vec2(rgba.b, lnScales.x));\n    splatData2.z = packHalf2x16(lnScales.yz);\n    splatData2.w = encodeQuatOctXy1010R12(quaternion);\n}\n\nvec2 decodeSplatAlphaShapeAmount(uvec4 splatData) {\n    return unpackHalf2x16(splatData.w);\n}\n\nvoid decodeSplatAttributesLnScale(\n    uvec4 splatData2,\n    float alpha,\n    out vec3 lnScales, out vec4 quaternion, out vec4 rgba\n) {\n    rgba.a = alpha;\n\n    rgba.rg = unpackHalf2x16(splatData2.x);\n    vec2 split = unpackHalf2x16(splatData2.y);\n    rgba.b = split.x;\n    lnScales.x = split.y;\n    lnScales.yz = unpackHalf2x16(splatData2.z);\n    quaternion = decodeQuatOctXy1010R12(splatData2.w);\n}\n\nvec3 decodeSplatShRgb(uint encoded) {\n    uint biasedBase = (encoded >> 27u) & 0x1fu;\n    float divisor = exp2(float(int(biasedBase) - 15)) / 255.0;\n\n    vec3 rgb = vec3(uvec3(encoded & 0xffu, (encoded >> 8u) & 0xffu, (encoded >> 16u) & 0xffu));\n    rgb *= divisor;\n\n    return vec3(\n        ((encoded & 0x1000000u) != 0u) ? -rgb.r : rgb.r,\n        ((encoded & 0x2000000u) != 0u) ? -rgb.g : rgb.g,\n        ((encoded & 0x4000000u) != 0u) ? -rgb.b : rgb.b\n    );\n}\n\nvec3 quatVec(vec4 q, vec3 v) {\n    \n    vec3 t = 2.0 * cross(q.xyz, v);\n    return v + q.w * t + cross(q.xyz, t);\n}\n\nvec4 quatQuat(vec4 q1, vec4 q2) {\n    return vec4(\n        q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,\n        q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,\n        q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,\n        q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z\n    );\n}\n\nmat3 scaleQuaternionToMatrix(vec3 s, vec4 q) {\n    \n    return mat3(\n        s.x * (1.0 - 2.0 * (q.y * q.y + q.z * q.z)),\n        s.x * (2.0 * (q.x * q.y + q.w * q.z)),\n        s.x * (2.0 * (q.x * q.z - q.w * q.y)),\n        s.y * (2.0 * (q.x * q.y - q.w * q.z)),\n        s.y * (1.0 - 2.0 * (q.x * q.x + q.z * q.z)),\n        s.y * (2.0 * (q.y * q.z + q.w * q.x)),\n        s.z * (2.0 * (q.x * q.z + q.w * q.y)),\n        s.z * (2.0 * (q.y * q.z - q.w * q.x)),\n        s.z * (1.0 - 2.0 * (q.x * q.x + q.y * q.y))\n    );\n}\n\nivec3 splatTexCoord(int index) {\n    uint x = uint(index) & SPLAT_TEX_WIDTH_MASK;\n    uint y = (uint(index) >> SPLAT_TEX_WIDTH_BITS) & SPLAT_TEX_HEIGHT_MASK;\n    uint z = uint(index) >> SPLAT_TEX_LAYER_BITS;\n    return ivec3(x, y, z);\n}";
var splatFragment_default = "precision highp float;\nprecision highp int;\n\n#include <splatDefines>\n\nuniform float near;\nuniform float far;\nuniform bool encodeLinear;\nuniform float time;\nuniform bool debugFlag;\nuniform float minAlpha;\n\nout vec4 fragColor;\n\nin vec4 vRgba;\nin vec2 vSplatUv;\nin vec3 vNdc;\nflat in uint vSplatIndex;\nflat in float adjustedStdDev;\nflat in float vKernelShape;\n\n#include <logdepthbuf_pars_fragment>\n\nvoid main() {\n    vec4 rgba = vRgba;\n\n    float z2 = dot(vSplatUv, vSplatUv);\n    if (z2 > (adjustedStdDev * adjustedStdDev)) {\n        discard;\n    }\n\n    float kernelShape = vKernelShape;\n    if (kernelShape <= 1.0) {\n        rgba.a *= exp(-0.5 * z2);\n    } else {\n        float power = exp((kernelShape * kernelShape - 1.0) / 2.718281828459045);\n        float alpha = 1.0 - pow(1.0 - exp(-0.5 * z2), power);\n        rgba.a *= alpha;\n    }\n\n    if (rgba.a < minAlpha) {\n        discard;\n    }\n    if (encodeLinear) {\n        rgba.rgb = srgbToLinear(rgba.rgb);\n    }\n\n    #ifdef PREMULTIPLIED_ALPHA\n        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);\n    #else\n        fragColor = rgba;\n    #endif\n\n    #include <logdepthbuf_fragment>\n}";
var splatVertex_default = "precision highp float;\nprecision highp int;\nprecision highp usampler2DArray;\n\n#include <splatDefines>\n\nout vec4 vRgba;\nout vec2 vSplatUv;\nout vec3 vNdc;\nflat out uint vSplatIndex;\nflat out float adjustedStdDev;\nflat out float vKernelShape;\n\nuniform vec2 renderSize;\nuniform vec4 renderToViewQuat;\nuniform vec3 renderToViewPos;\n\nuniform float renderToViewScale;\nuniform float maxStdDev;\nuniform float minPixelRadius;\nuniform float maxPixelRadius;\nuniform float time;\nuniform float deltaTime;\nuniform bool debugFlag;\nuniform float minAlpha;\nuniform bool enable2DGS;\nuniform float blurAmount;\nuniform float preBlurAmount;\nuniform float clipXY;\nuniform float focalAdjustment;\n\nuniform usampler2D ordering;\nuniform usampler2DArray splats;\nuniform usampler2DArray splats2;\n\nbool isPerspectiveMatrix( mat4 m ) {\n    return m[ 2 ][ 3 ] == -1.0;\n}\n\n#include <logdepthbuf_pars_vertex>\n\nvoid main() {\n    \n    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);\n\n    ivec2 orderingCoord = ivec2((gl_InstanceID >> 2) & 4095, gl_InstanceID >> 14);\n    uint splatIndex = texelFetch(ordering, orderingCoord, 0)[gl_InstanceID & 3];\n    if (splatIndex == 0xffffffffu) {\n        \n        return;\n    }\n\n    ivec3 texCoord = splatTexCoord(int(splatIndex));\n    uvec4 splat1 = texelFetch(splats, texCoord, 0);\n    vec2 alphaShapeAmount = decodeSplatAlphaShapeAmount(splat1);\n    float alpha = alphaShapeAmount.x;\n    if ((alpha == 0.0) || (alpha < minAlpha)) {\n        return;\n    }\n    vec3 center = decodeSplatCenter(splat1);\n    \n    vec3 viewCenter = renderToViewScale * quatVec(renderToViewQuat, center) + renderToViewPos;\n\n    \n    if (viewCenter.z >= 0.0) {\n        return;\n    }\n\n    \n    vec4 clipCenter = projectionMatrix * vec4(viewCenter, 1.0);\n\n    \n    if (abs(clipCenter.z) >= clipCenter.w) {\n        return;\n    }\n\n    \n    float clip = clipXY * clipCenter.w;\n    if (abs(clipCenter.x) > clip || abs(clipCenter.y) > clip) {\n        return;\n    }\n\n    \n    \n    vec3 lnScales;\n    vec4 quaternion, rgba;\n    uvec4 splat2 = texelFetch(splats2, texCoord, 0);\n    decodeSplatAttributesLnScale(splat2, alpha, lnScales, quaternion, rgba);\n    vec3 scales = exp(lnScales);\n    bvec3 zeroScales = equal(scales, vec3(0.0));\n    if (all(zeroScales)) {\n        return;\n    }\n\n    \n    rgba.rgb = max(rgba.rgb, vec3(0.0));\n\n    \n    \n    float kernelShape = 1.0 + 4.0 * min(alphaShapeAmount.y, 1.0);\n    vKernelShape = kernelShape;\n\n    \n    adjustedStdDev = maxStdDev + 0.7 * max(kernelShape - 1.0, 0.0);\n\n    scales *= renderToViewScale;\n\n    vRgba = vec4(rgba.rgb, alpha);\n    vSplatUv = position.xy * adjustedStdDev;\n\n    \n    vSplatIndex = splatIndex;\n\n    \n    vec4 viewQuaternion = quatQuat(renderToViewQuat, quaternion);\n\n    if (enable2DGS && any(zeroScales)) {\n        vec3 offset;\n        if (zeroScales.z) {\n            offset = vec3(vSplatUv.xy * scales.xy, 0.0);\n        } else if (zeroScales.y) {\n            offset = vec3(vSplatUv.x * scales.x, 0.0, vSplatUv.y * scales.z);\n        } else {\n            offset = vec3(0.0, vSplatUv.xy * scales.yz);\n        }\n\n        vec3 viewPos = viewCenter + quatVec(viewQuaternion, offset);\n        gl_Position = projectionMatrix * vec4(viewPos, 1.0);\n        vNdc = gl_Position.xyz / gl_Position.w;\n\n        #include <logdepthbuf_vertex>\n        return;\n    }\n\n    \n    mat3 RS = scaleQuaternionToMatrix(scales, viewQuaternion);\n    mat3 cov3D = RS * transpose(RS);\n\n    \n    vec2 scaledRenderSize = renderSize * focalAdjustment;\n    vec2 focal = 0.5 * scaledRenderSize * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);\n\n    mat3 J;\n    if (isOrthographic) {\n        J = mat3(\n            focal.x, 0.0, 0.0,\n            0.0, focal.y, 0.0,\n            0.0, 0.0, 0.0\n        );\n    } else {\n        float invZ = 1.0 / viewCenter.z;\n        vec2 J1 = focal * invZ;\n        vec2 J2 = -(J1 * viewCenter.xy) * invZ;\n        J = mat3(\n            J1.x, 0.0, J2.x,\n            0.0, J1.y, J2.y,\n            0.0, 0.0, 0.0\n        );\n    }\n\n    \n    \n    mat3 cov2D = transpose(J) * cov3D * J;\n    float a = cov2D[0][0];\n    float d = cov2D[1][1];\n    float b = cov2D[0][1];\n\n    \n    a += preBlurAmount;\n    d += preBlurAmount;\n\n    \n    float detOrig = a * d - b * b;\n    a += blurAmount;\n    d += blurAmount;\n    float det = a * d - b * b;\n\n    \n    float blurAdjust = sqrt(max(0.0, detOrig / det));\n    alpha *= blurAdjust;\n    if (alpha < minAlpha) {\n        return;\n    }\n    vRgba.a = alpha;\n\n    \n    float eigenAvg = 0.5 * (a + d);\n    float eigenDelta = sqrt(max(0.0, eigenAvg * eigenAvg - det));\n    float eigen1 = eigenAvg + eigenDelta;\n    float eigen2 = eigenAvg - eigenDelta;\n\n    vec2 eigenVec1 = (abs(b) > 0.001) ? normalize(vec2(b, eigen1 - a))\n        : ((a >= d) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));\n    vec2 eigenVec2 = vec2(eigenVec1.y, -eigenVec1.x);\n\n    float scale1 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen1));\n    float scale2 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen2));\n    if (scale1 < minPixelRadius && scale2 < minPixelRadius) {\n        return;\n    }\n\n    \n    vec2 pixelOffset = position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2;\n    vec2 ndcOffset = (2.0 / scaledRenderSize) * pixelOffset;\n\n    \n    vec3 ndcCenter = clipCenter.xyz / clipCenter.w;\n    vec3 ndc = vec3(ndcCenter.xy + ndcOffset, ndcCenter.z);\n\n    vNdc = ndc;\n    gl_Position = vec4(ndc.xy * clipCenter.w, clipCenter.zw);\n\n    #include <logdepthbuf_vertex>\n}";
let shaders = null;
function getShaders() {
  if (!shaders) {
    THREE__namespace.ShaderChunk.splatDefines = splatDefines_default;
    shaders = {
      splatVertex: splatVertex_default,
      splatFragment: splatFragment_default
    };
  }
  return shaders;
}
var splatGenerate_default = "precision highp float;\nprecision highp int;\nprecision highp usampler2D;\nprecision highp usampler2DArray;\n\n#include <splatDefines>\n\nuniform uint targetLayer;\nuniform int targetBase;\nuniform int targetCount;\n\nuniform usampler2DArray sourceSplats;\nuniform usampler2DArray sourceSplats2;\n\nuniform int numSh;\nuniform usampler2DArray sh1Texture;\nuniform usampler2DArray sh2Texture;\nuniform usampler2DArray sh3TextureA;\nuniform usampler2DArray sh3TextureB;\n\nuniform mat3 objectBasis;\nuniform vec3 objectOffset;\nuniform vec3 objectLnScale;\nuniform vec4 objectQuaternion;\nuniform vec4 recolor;\n\nuniform int numSdfs;\nuniform int numEdits;\nuniform usampler2D sdfTexture;\nuniform usampler2D editTexture;\n\nlayout(location = 0) out uvec4 target;\nlayout(location = 1) out uvec4 target2;\n\nvec3 evaluateSH1(uvec4 data, vec3 direction) {\n    return decodeSplatShRgb(data.x) * (-0.4886025 * direction.y)\n        + decodeSplatShRgb(data.y) * (0.4886025 * direction.z)\n        + decodeSplatShRgb(data.z) * (-0.4886025 * direction.x);\n}\n\nvec3 evaluateSH12(uvec4 first, uvec4 second, vec3 direction) {\n    vec3 result = evaluateSH1(first, direction);\n    result += decodeSplatShRgb(first.w) * (1.0925484 * direction.x * direction.y);\n    result += decodeSplatShRgb(second.x) * (-1.0925484 * direction.y * direction.z);\n    result += decodeSplatShRgb(second.y) * (0.3153915 * (2.0 * direction.z * direction.z - direction.x * direction.x - direction.y * direction.y));\n    result += decodeSplatShRgb(second.z) * (-1.0925484 * direction.x * direction.z);\n    result += decodeSplatShRgb(second.w) * (0.5462742 * (direction.x * direction.x - direction.y * direction.y));\n    return result;\n}\n\nvec3 evaluateSH3(uvec4 first, uvec4 second, vec3 direction) {\n    float xx = direction.x * direction.x;\n    float yy = direction.y * direction.y;\n    float zz = direction.z * direction.z;\n    return decodeSplatShRgb(first.x) * (-0.5900436 * direction.y * (3.0 * xx - yy))\n        + decodeSplatShRgb(first.y) * (2.8906114 * direction.x * direction.y * direction.z)\n        + decodeSplatShRgb(first.z) * (-0.4570458 * direction.y * (4.0 * zz - xx - yy))\n        + decodeSplatShRgb(first.w) * (0.3731763 * direction.z * (2.0 * zz - 3.0 * xx - 3.0 * yy))\n        + decodeSplatShRgb(second.x) * (-0.4570458 * direction.x * (4.0 * zz - xx - yy))\n        + decodeSplatShRgb(second.y) * (1.4453057 * direction.z * (xx - yy))\n        + decodeSplatShRgb(second.z) * (-0.5900436 * direction.x * (xx - 3.0 * yy));\n}\n\nvec3 evaluateSH(ivec3 coord, vec3 direction) {\n    vec3 result = vec3(0.0);\n    if (numSh == 1) {\n        result = evaluateSH1(texelFetch(sh1Texture, coord, 0), direction);\n    } else if (numSh >= 2) {\n        result = evaluateSH12(\n            texelFetch(sh1Texture, coord, 0),\n            texelFetch(sh2Texture, coord, 0),\n            direction\n        );\n        if (numSh >= 3) {\n            result += evaluateSH3(\n                texelFetch(sh3TextureA, coord, 0),\n                texelFetch(sh3TextureB, coord, 0),\n                direction\n            );\n        }\n    }\n    return result;\n}\n\nvoid unpackSdf(\n    int index,\n    out uint flags,\n    out vec3 center,\n    out vec4 quaternion,\n    out vec3 scale,\n    out vec4 sizes,\n    out vec4 sdfRgba\n) {\n    uvec4 data = texelFetch(sdfTexture, ivec2(0, index), 0);\n    center = vec3(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z));\n    flags = data.w;\n    data = texelFetch(sdfTexture, ivec2(1, index), 0);\n    quaternion = vec4(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z), uintBitsToFloat(data.w));\n    data = texelFetch(sdfTexture, ivec2(2, index), 0);\n    scale = vec3(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z));\n    data = texelFetch(sdfTexture, ivec2(3, index), 0);\n    sizes = vec4(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z), uintBitsToFloat(data.w));\n    data = texelFetch(sdfTexture, ivec2(4, index), 0);\n    sdfRgba = vec4(uintBitsToFloat(data.x), uintBitsToFloat(data.y), uintBitsToFloat(data.z), uintBitsToFloat(data.w));\n}\n\nfloat sdfDistance(uint type, vec3 position, vec4 sizes) {\n    switch (type) {\n        case 0u: return -INFINITY;\n        case 1u: return position.z;\n        case 2u: return length(position) - sizes.w;\n        case 3u: {\n            vec3 q = abs(position) - sizes.xyz + sizes.w;\n            return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - sizes.w;\n        }\n        case 4u: {\n            float k0 = length(position / sizes.xyz);\n            float k1 = length(position / dot(sizes.xyz, sizes.xyz));\n            return k0 * (k0 - 1.0) / k1;\n        }\n        case 5u: {\n            vec2 d = abs(vec2(length(position.xz), position.y)) - sizes.wy;\n            return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));\n        }\n        case 6u: {\n            position.y -= clamp(position.y, -0.5 * sizes.y, 0.5 * sizes.y);\n            return length(position) - sizes.w;\n        }\n        case 7u: {\n            float angle = 0.25 * PI * sizes.w;\n            vec2 c = vec2(sin(angle), cos(angle));\n            vec2 q = vec2(length(position.xy), -position.z);\n            float distance = length(q - c * max(dot(q, c), 0.0));\n            return distance * (((q.x * c.y - q.y * c.x) < 0.0) ? -1.0 : 1.0);\n        }\n    }\n    return INFINITY;\n}\n\nfloat evaluateSdfs(\n    int sdfFirst,\n    int sdfCount,\n    vec3 position,\n    float smoothAmount,\n    out vec4 resultRgba\n) {\n    float distanceAccum = smoothAmount == 0.0 ? INFINITY : 0.0;\n    float maxExponent = -INFINITY;\n    resultRgba = vec4(0.0);\n    int sdfLast = min(sdfFirst + sdfCount, numSdfs);\n\n    for (int index = sdfFirst; index < sdfLast; ++index) {\n        uint flags;\n        vec3 center;\n        vec4 quaternion;\n        vec3 scale;\n        vec4 sizes;\n        vec4 value;\n        unpackSdf(index, flags, center, quaternion, scale, sizes, value);\n        vec3 sdfPosition = quatVec(quaternion, position * scale) + center;\n        float distance = sdfDistance(flags & 0xffu, sdfPosition, sizes);\n        if ((flags & 0x100u) != 0u) distance = -distance;\n\n        if (smoothAmount == 0.0) {\n            if (distance < distanceAccum) {\n                distanceAccum = distance;\n                resultRgba = value;\n            }\n        } else {\n            float exponent = -distance / smoothAmount;\n            if (exponent > maxExponent) {\n                float rescale = exp(maxExponent - exponent);\n                distanceAccum *= rescale;\n                resultRgba *= rescale;\n                maxExponent = exponent;\n            }\n            float weight = exp(exponent - maxExponent);\n            distanceAccum += weight;\n            resultRgba += weight * value;\n        }\n    }\n\n    if (smoothAmount == 0.0 || distanceAccum == 0.0) {\n        return distanceAccum == 0.0 ? INFINITY : distanceAccum;\n    }\n    resultRgba /= distanceAccum;\n    return (-log(distanceAccum) - maxExponent) * smoothAmount;\n}\n\nvoid applySdfEdits(vec3 position, inout vec4 rgba) {\n    for (int editIndex = 0; editIndex < numEdits; ++editIndex) {\n        uvec4 edit = texelFetch(editTexture, ivec2(0, editIndex), 0);\n        uint blendMode = edit.x & 0xffu;\n        bool invert = (edit.x & 0x100u) != 0u;\n        int sdfFirst = int(edit.y & 0xffffu);\n        int sdfCount = int(edit.y >> 16u);\n        float softEdge = uintBitsToFloat(edit.z);\n        float smoothAmount = uintBitsToFloat(edit.w);\n\n        vec4 sdfRgba;\n        float distance = evaluateSdfs(sdfFirst, sdfCount, position, smoothAmount, sdfRgba);\n        if (invert) distance = -distance;\n        float amount = softEdge == 0.0\n            ? (distance < 0.0 ? 1.0 : 0.0)\n            : clamp(-distance / softEdge + 0.5, 0.0, 1.0);\n        vec4 target = rgba;\n        switch (blendMode) {\n            case 0u:\n                target = rgba * sdfRgba;\n                break;\n            case 1u:\n                target = vec4(sdfRgba.rgb, rgba.a * sdfRgba.a);\n                break;\n            case 2u:\n                target = rgba + sdfRgba;\n                break;\n        }\n        rgba = mix(rgba, target, amount);\n    }\n}\n\nvoid produceSplat(int index) {\n    ivec3 coord = splatTexCoord(index);\n    uvec4 sourceSplat = texelFetch(sourceSplats, coord, 0);\n    vec2 alphaShapeAmount = decodeSplatAlphaShapeAmount(sourceSplat);\n    vec3 center = decodeSplatCenter(sourceSplat);\n    vec3 lnScales;\n    vec4 quaternion;\n    vec4 rgba;\n    decodeSplatAttributesLnScale(\n        texelFetch(sourceSplats2, coord, 0),\n        alphaShapeAmount.x,\n        lnScales,\n        quaternion,\n        rgba\n    );\n    if (all(equal(lnScales, vec3(-INFINITY)))) return;\n    float shapeAmount = alphaShapeAmount.y;\n\n    \n    \n    \n    center = objectBasis * center;\n    if (numSh > 0) {\n        vec3 worldViewDirection = center + objectOffset;\n        vec4 inverseObjectQuaternion = vec4(-objectQuaternion.xyz, objectQuaternion.w);\n        vec3 sourceViewDirection = normalize(quatVec(inverseObjectQuaternion, worldViewDirection));\n        rgba.rgb += evaluateSH(coord, sourceViewDirection);\n    }\n    lnScales += objectLnScale;\n    quaternion = quatQuat(objectQuaternion, quaternion);\n\n    vec3 editPosition = center;\n    center += objectOffset;\n\n    applySdfEdits(editPosition, rgba);\n    vec3 relativeCenter = center;\n    \n    \n    \n    rgba *= vec4(recolor.rgb, clamp(recolor.a, 0.0, 1.0));\n    \n    \n    rgba.a = clamp(rgba.a, 0.0, 1.0);\n\n    \n    encodeSplatLnScale(\n        target,\n        target2,\n        relativeCenter,\n        lnScales,\n        quaternion,\n        rgba,\n        shapeAmount\n    );\n}\n\nvoid main() {\n    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS)\n        + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS)\n        + int(gl_FragCoord.x);\n    int index = targetIndex - targetBase;\n\n    target = uvec4(0u);\n    target2 = uvec4(0u);\n    if (index >= 0 && index < targetCount) {\n        produceSplat(index);\n    }\n}";
const rotationMatrix = new THREE__namespace.Matrix4();
const axisX = new THREE__namespace.Vector3();
const axisY = new THREE__namespace.Vector3();
const axisZ = new THREE__namespace.Vector3();
const sourceAxis = new THREE__namespace.Vector3();
function decomposeSplatTransform(matrix, scale, rotation) {
  const source = matrix.elements;
  const sx = Math.hypot(source[0], source[1], source[2]);
  const sy = Math.hypot(source[4], source[5], source[6]);
  const sz = Math.hypot(source[8], source[9], source[10]);
  scale.set(sx, sy, sz);
  axisX.set(source[0], source[1], source[2]);
  axisY.set(source[4], source[5], source[6]);
  axisZ.set(source[8], source[9], source[10]);
  if (sx > 0) axisX.multiplyScalar(1 / sx);
  if (sy > 0) axisY.multiplyScalar(1 / sy);
  if (sz > 0) axisZ.multiplyScalar(1 / sz);
  const nonZeroAxes = Number(sx > 0) + Number(sy > 0) + Number(sz > 0);
  if (nonZeroAxes === 0) {
    rotation.identity();
    return;
  }
  if (nonZeroAxes === 1) {
    const localAxis = sx > 0 ? 0 : sy > 0 ? 1 : 2;
    sourceAxis.set(
      localAxis === 0 ? 1 : 0,
      localAxis === 1 ? 1 : 0,
      localAxis === 2 ? 1 : 0
    );
    rotation.setFromUnitVectors(
      sourceAxis,
      localAxis === 0 ? axisX : localAxis === 1 ? axisY : axisZ
    ).normalize();
    return;
  }
  if (sx === 0) axisX.copy(axisY).cross(axisZ).normalize();
  if (sy === 0) axisY.copy(axisZ).cross(axisX).normalize();
  if (sz === 0) axisZ.copy(axisX).cross(axisY).normalize();
  if (matrix.determinant() < 0) axisX.negate();
  rotationMatrix.makeBasis(axisX, axisY, axisZ);
  rotation.setFromRotationMatrix(rotationMatrix).normalize();
}
const _SplatAccumulator = class _SplatAccumulator {
  constructor() {
    this.time = 0;
    this.deltaTime = 0;
    this.viewOrigin = new THREE__namespace.Vector3();
    this.viewDirection = new THREE__namespace.Vector3();
    this.maxSplats = 0;
    this.numSplats = 0;
    this.target = null;
    this.mapping = [];
    this.version = -1;
    this.mappingVersion = -1;
    this.transformScale = new THREE__namespace.Vector3();
    this.transformQuaternion = new THREE__namespace.Quaternion();
    if (!threeMrtArray) {
      throw new Error("Gaussian Splat Lite requires THREE.js r179 or above");
    }
  }
  dispose() {
    var _a;
    (_a = this.target) == null ? void 0 : _a.dispose();
    this.target = null;
  }
  getTextures() {
    var _a;
    return ((_a = this.target) == null ? void 0 : _a.textures) ?? _SplatAccumulator.emptyTextures;
  }
  generateMapping(splatCounts) {
    let maxSplats = 0;
    const mapping = splatCounts.map((count) => {
      const base = maxSplats;
      maxSplats += Math.ceil(count / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      return { base, count };
    });
    return { maxSplats, mapping };
  }
  ensureGenerate({ maxSplats }) {
    if (this.target && Math.max(1, maxSplats) <= this.maxSplats) {
      return false;
    }
    this.dispose();
    const textureSize = getTextureSize(Math.max(1, maxSplats));
    const { width, height, depth } = textureSize;
    this.maxSplats = textureSize.maxSplats;
    this.target = new THREE__namespace.WebGLArrayRenderTarget(width, height, depth, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      magFilter: THREE__namespace.NearestFilter,
      minFilter: THREE__namespace.NearestFilter,
      format: THREE__namespace.RGBAIntegerFormat,
      type: THREE__namespace.UnsignedIntType
    });
    this.target.scissorTest = true;
    const second = this.target.texture.clone();
    this.target.textures = [this.target.texture, second];
    return true;
  }
  getMaterial() {
    let material = _SplatAccumulator.material;
    if (!material) {
      getShaders();
      material = new THREE__namespace.RawShaderMaterial({
        glslVersion: THREE__namespace.GLSL3,
        vertexShader: IDENT_VERTEX_SHADER,
        fragmentShader: splatGenerate_default,
        uniforms: makeGenerateUniforms(),
        depthTest: false,
        depthWrite: false
      });
      _SplatAccumulator.material = material;
    }
    return material;
  }
  prepareMaterial(mesh) {
    const source = mesh.splats;
    if (!source) {
      throw new Error("SplatMesh has no source");
    }
    const material = this.getMaterial();
    const uniforms = material.uniforms;
    const [sourceSplats, sourceSplats2] = source.getSplatTextures();
    const sh = source.getShTextures();
    source.needsUpdate = false;
    uniforms.sourceSplats.value = sourceSplats;
    uniforms.sourceSplats2.value = sourceSplats2;
    uniforms.numSh.value = Math.min(mesh.maxSh, source.getNumSh());
    uniforms.sh1Texture.value = sh.sh1 ?? _SplatAccumulator.emptyTexture;
    uniforms.sh2Texture.value = sh.sh2 ?? _SplatAccumulator.emptyTexture;
    uniforms.sh3TextureA.value = sh.sh3a ?? _SplatAccumulator.emptyTexture;
    uniforms.sh3TextureB.value = sh.sh3b ?? _SplatAccumulator.emptyTexture;
    decomposeSplatTransform(
      mesh.matrixWorld,
      this.transformScale,
      this.transformQuaternion
    );
    uniforms.objectBasis.value.setFromMatrix4(mesh.matrixWorld);
    uniforms.objectOffset.value.setFromMatrixPosition(mesh.matrixWorld);
    uniforms.objectOffset.value.sub(this.viewOrigin);
    uniforms.objectLnScale.value.set(
      Math.log(this.transformScale.x),
      Math.log(this.transformScale.y),
      Math.log(this.transformScale.z)
    );
    uniforms.objectQuaternion.value.copy(this.transformQuaternion);
    uniforms.recolor.value.set(
      mesh.recolor.r,
      mesh.recolor.g,
      mesh.recolor.b,
      mesh.opacity
    );
    const edits = mesh.sdfEdits;
    uniforms.numSdfs.value = (edits == null ? void 0 : edits.numSdfs) ?? 0;
    uniforms.numEdits.value = (edits == null ? void 0 : edits.numEdits) ?? 0;
    uniforms.sdfTexture.value = (edits == null ? void 0 : edits.sdfTexture) ?? SplatEdits.emptyTexture;
    uniforms.editTexture.value = (edits == null ? void 0 : edits.editTexture) ?? SplatEdits.emptyTexture;
    _SplatAccumulator.fullScreenQuad.material = material;
    return material;
  }
  generate({
    mesh,
    base,
    count,
    renderer
  }) {
    if (!this.target) throw new Error("Accumulator target is not initialized");
    if (base + count > this.maxSplats) {
      throw new Error("Splat generation range exceeds accumulator capacity");
    }
    const material = this.prepareMaterial(mesh);
    const uniforms = material.uniforms;
    const renderState = this.saveRenderState(renderer);
    const nextBase = Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    uniforms.targetBase.value = base;
    uniforms.targetCount.value = count;
    while (base < nextBase) {
      const layer = Math.floor(base / layerSize);
      uniforms.targetLayer.value = layer;
      const layerBase = layer * layerSize;
      const yStart = Math.floor((base - layerBase) / SPLAT_TEX_WIDTH);
      const yEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((nextBase - layerBase) / SPLAT_TEX_WIDTH)
      );
      this.target.scissor.set(0, yStart, SPLAT_TEX_WIDTH, yEnd - yStart);
      renderer.setRenderTarget(this.target, layer);
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      _SplatAccumulator.fullScreenQuad.render(renderer);
      base += SPLAT_TEX_WIDTH * (yEnd - yStart);
    }
    this.resetRenderState(renderer, renderState);
  }
  prepareGenerate({
    renderer,
    scene,
    timer,
    camera,
    previous
  }) {
    camera.getWorldPosition(this.viewOrigin);
    camera.getWorldDirection(this.viewDirection);
    this.time = timer.getElapsed();
    this.deltaTime = timer.getDelta();
    const allMeshes = [];
    scene.traverse((node) => {
      if (node instanceof SplatMesh && camera.layers.test(node.layers)) {
        allMeshes.push(node);
      }
    });
    const globalEdits = /* @__PURE__ */ new Set();
    scene.traverseVisible((node) => {
      if (!(node instanceof SplatEdit)) return;
      let ancestor = node.parent;
      while (ancestor && !(ancestor instanceof SplatMesh)) {
        ancestor = ancestor.parent;
      }
      if (!ancestor) globalEdits.add(node);
    });
    for (const mesh of allMeshes) {
      try {
        mesh.frameUpdate({
          time: this.time,
          deltaTime: this.deltaTime,
          camera,
          globalEdits: Array.from(globalEdits)
        });
      } catch (error) {
        console.error("SplatMesh frame update failed", error);
      }
    }
    const visibleMeshes = [];
    scene.traverseVisible((node) => {
      if (node instanceof SplatMesh && camera.layers.test(node.layers)) {
        visibleMeshes.push(node);
      }
    });
    const { maxSplats, mapping: ranges } = this.generateMapping(
      visibleMeshes.map((mesh) => mesh.numSplats)
    );
    this.mapping = [];
    this.numSplats = 0;
    ranges.forEach(({ base, count }, index) => {
      const node = visibleMeshes[index];
      if (!node.splats || count <= 0) return;
      this.mapping.push({
        node,
        version: node.version,
        sortVersion: node.sortVersion,
        mappingVersion: node.mappingVersion,
        base,
        count
      });
      this.numSplats = Math.max(this.numSplats, base + count);
    });
    const { splatsUpdated, mappingUpdated, sortUpdated } = previous.checkVersions(this.mapping);
    this.version = previous.version + (splatsUpdated ? 1 : 0);
    this.mappingVersion = previous.mappingVersion + (mappingUpdated ? 1 : 0);
    return {
      version: this.version,
      sortUpdated,
      generate: () => {
        this.ensureGenerate({ maxSplats });
        for (const { node, base, count } of this.mapping) {
          this.generate({ mesh: node, base, count, renderer });
        }
      }
    };
  }
  checkVersions(other) {
    if (this.mapping.length !== other.length) {
      return { splatsUpdated: true, mappingUpdated: true, sortUpdated: true };
    }
    const mappingUpdated = this.mapping.some((item, index) => {
      const previous = other[index];
      return item.node !== previous.node || item.base !== previous.base || item.count !== previous.count || item.mappingVersion !== previous.mappingVersion;
    });
    if (mappingUpdated) {
      return { splatsUpdated: true, mappingUpdated: true, sortUpdated: true };
    }
    return {
      splatsUpdated: this.mapping.some(
        (item, index) => item.version !== other[index].version
      ),
      mappingUpdated: false,
      sortUpdated: this.mapping.some(
        (item, index) => item.sortVersion !== other[index].sortVersion
      )
    };
  }
  saveRenderState(renderer) {
    return {
      target: renderer.getRenderTarget(),
      activeCubeFace: renderer.getActiveCubeFace(),
      activeMipmapLevel: renderer.getActiveMipmapLevel(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear
    };
  }
  resetRenderState(renderer, state) {
    renderer.setRenderTarget(
      state.target,
      state.activeCubeFace,
      state.activeMipmapLevel
    );
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }
};
_SplatAccumulator.emptyTexture = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const texture = new THREE__namespace.DataArrayTexture(
    new Uint32Array(maxSplats * 4),
    width,
    height,
    depth
  );
  texture.format = THREE__namespace.RGBAIntegerFormat;
  texture.type = THREE__namespace.UnsignedIntType;
  texture.internalFormat = "RGBA32UI";
  texture.needsUpdate = true;
  return texture;
})();
_SplatAccumulator.emptyTextures = [
  _SplatAccumulator.emptyTexture,
  _SplatAccumulator.emptyTexture
];
_SplatAccumulator.material = null;
_SplatAccumulator.fullScreenQuad = new Pass_js.FullScreenQuad(
  new THREE__namespace.RawShaderMaterial({ visible: false })
);
let SplatAccumulator = _SplatAccumulator;
function makeGenerateUniforms() {
  return {
    targetLayer: { value: 0 },
    targetBase: { value: 0 },
    targetCount: { value: 0 },
    sourceSplats: { value: SplatAccumulator.emptyTexture },
    sourceSplats2: { value: SplatAccumulator.emptyTexture },
    numSh: { value: 0 },
    sh1Texture: { value: SplatAccumulator.emptyTexture },
    sh2Texture: { value: SplatAccumulator.emptyTexture },
    sh3TextureA: { value: SplatAccumulator.emptyTexture },
    sh3TextureB: { value: SplatAccumulator.emptyTexture },
    objectBasis: { value: new THREE__namespace.Matrix3() },
    objectOffset: { value: new THREE__namespace.Vector3() },
    objectLnScale: { value: new THREE__namespace.Vector3() },
    objectQuaternion: { value: new THREE__namespace.Quaternion() },
    recolor: { value: new THREE__namespace.Vector4(1, 1, 1, 1) },
    numSdfs: { value: 0 },
    numEdits: { value: 0 },
    sdfTexture: { value: SplatEdits.emptyTexture },
    editTexture: { value: SplatEdits.emptyTexture }
  };
}
class SplatGeometry extends THREE__namespace.InstancedBufferGeometry {
  constructor() {
    super();
    this.setAttribute("position", new THREE__namespace.BufferAttribute(QUAD_VERTICES, 3));
    this.setIndex(new THREE__namespace.BufferAttribute(QUAD_INDICES, 1));
  }
}
const QUAD_VERTICES = new Float32Array([
  -1,
  -1,
  0,
  1,
  -1,
  0,
  1,
  1,
  0,
  -1,
  1,
  0
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
const renderToViewScaleTmp = new THREE__namespace.Vector3();
function getCameraWorldScale(camera) {
  const scale = camera.getWorldScale(renderToViewScaleTmp);
  return (scale.x + scale.y + scale.z) / 3;
}
const _GaussianSplatRenderer = class _GaussianSplatRenderer extends THREE__namespace.Mesh {
  constructor(options) {
    if (!options) {
      throw new Error("GaussianSplatRenderer options are required");
    }
    if (!options.renderer) {
      throw new Error("renderer is required in GaussianSplatRenderer options");
    }
    const uniforms = _GaussianSplatRenderer.makeUniforms();
    Object.assign(uniforms, options.extraUniforms ?? {});
    const shaders2 = getShaders();
    const premultipliedAlpha = options.premultipliedAlpha ?? true;
    const geometry = new SplatGeometry();
    const material = new THREE__namespace.ShaderMaterial({
      glslVersion: THREE__namespace.GLSL3,
      vertexShader: options.vertexShader ?? shaders2.splatVertex,
      fragmentShader: options.fragmentShader ?? shaders2.splatFragment,
      uniforms,
      premultipliedAlpha,
      transparent: options.transparent ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? false,
      side: THREE__namespace.DoubleSide,
      allowOverride: false
    });
    super(geometry, material);
    this.renderSize = new THREE__namespace.Vector2();
    this.lastFrame = -1;
    this.updateTimeoutId = -1;
    this.orderingTexture = null;
    this.maxSplats = 0;
    this.activeSplats = 0;
    this.accumulators = [];
    this.sorting = false;
    this.sortDirty = false;
    this.lastSortTime = 0;
    this.sortWorker = null;
    this.sortedCenter = new THREE__namespace.Vector3().setScalar(Number.NEGATIVE_INFINITY);
    this.sortedDir = new THREE__namespace.Vector3().setScalar(0);
    this.sortCenterCache = new SortCenterCache();
    this.sortCentersRevision = 0;
    this.uploadedSortCentersRevision = -1;
    this.updateRunning = false;
    this.updatePromise = Promise.resolve();
    this.queuedUpdate = null;
    this.disposed = false;
    this.superXY = 1;
    this.material = material;
    this.uniforms = uniforms;
    this.frustumCulled = false;
    this.renderer = options.renderer;
    this.onDirty = options.onDirty;
    this.dirty = true;
    this.autoUpdate = options.autoUpdate ?? true;
    this.preUpdate = options.preUpdate ?? true;
    this.maxStdDev = options.maxStdDev ?? Math.sqrt(8);
    this.minPixelRadius = options.minPixelRadius ?? 1;
    this.maxPixelRadius = options.maxPixelRadius ?? 512;
    this.minAlpha = options.minAlpha ?? 0.5 * (1 / 255);
    this.enable2DGS = options.enable2DGS ?? false;
    this.preBlurAmount = options.preBlurAmount ?? 0;
    this.blurAmount = options.blurAmount ?? 0.3;
    this.clipXY = options.clipXY ?? 1.25;
    this.focalAdjustment = options.focalAdjustment ?? 2;
    this.sortRadial = options.sortRadial ?? false;
    this.minSortIntervalMs = options.minSortIntervalMs ?? 0;
    const { timer, ownsTimer } = resolveTimer(options.timer);
    this.timer = timer;
    this.ownsTimer = ownsTimer;
    this.display = this.createAccumulator();
    this.current = this.display;
    this.accumulators.push(this.createAccumulator());
    const provokingVertexExt = this.renderer.getContext().getExtension("WEBGL_provoking_vertex");
    if (provokingVertexExt) {
      provokingVertexExt.provokingVertexWEBGL(
        provokingVertexExt.FIRST_VERTEX_CONVENTION_WEBGL
      );
    }
    if (options.target) {
      const {
        width,
        height,
        doubleBuffer,
        superXY: origSuperXY,
        ...origTargetOptions
      } = options.target;
      const superXY = Math.max(1, Math.min(4, origSuperXY ?? 1));
      if (width * superXY > 8192 || height * superXY > 8192) {
        throw new Error("Target size too large");
      }
      this.superXY = superXY;
      const superWidth = width * superXY;
      const superHeight = height * superXY;
      const targetOptions = {
        format: THREE__namespace.RGBAFormat,
        type: THREE__namespace.UnsignedByteType,
        colorSpace: THREE__namespace.SRGBColorSpace,
        ...origTargetOptions
      };
      this.target = new THREE__namespace.WebGLRenderTarget(
        superWidth,
        superHeight,
        targetOptions
      );
      if (doubleBuffer) {
        this.backTarget = new THREE__namespace.WebGLRenderTarget(
          superWidth,
          superHeight,
          targetOptions
        );
      }
    }
  }
  raycast(_raycaster, _intersects) {
  }
  static makeUniforms() {
    const uniforms = {
      // // number of active splats to render
      // numSplats: { value: 0 },
      // Size of render viewport in pixels
      renderSize: { value: new THREE__namespace.Vector2() },
      // Near and far plane distances
      near: { value: 0.1 },
      far: { value: 1e3 },
      // SplatAccumulator to view transformation quaternion
      renderToViewQuat: { value: new THREE__namespace.Quaternion() },
      // SplatAccumulator to view transformation translation
      renderToViewPos: { value: new THREE__namespace.Vector3() },
      // SplatAccumulator to view transformation uniform scale
      renderToViewScale: { value: 1 },
      // Maximum distance (in stddevs) from Gsplat center to render
      maxStdDev: { value: 1 },
      // Minimum pixel radius for splat rendering
      minPixelRadius: { value: 1 },
      // Maximum pixel radius for splat rendering
      maxPixelRadius: { value: 512 },
      // Minimum alpha value for splat rendering
      minAlpha: { value: 0.5 * (1 / 255) },
      // Enable interpreting 0-thickness Gsplats as 2DGS
      enable2DGS: { value: false },
      // Add to projected 2D splat covariance diagonal (thickens and brightens)
      preBlurAmount: { value: 0 },
      // Add to 2D splat covariance diagonal and adjust opacity (anti-aliasing)
      blurAmount: { value: 0.3 },
      // Clip Gsplats that are clipXY times beyond the +-1 frustum bounds
      clipXY: { value: 1.25 },
      // Debug renderSize scale factor
      focalAdjustment: { value: 2 },
      // Whether to encode Gsplat with linear RGB (for environment mapping)
      encodeLinear: { value: false },
      // Back-to-front sort ordering of splat indices
      ordering: { type: "t", value: _GaussianSplatRenderer.emptyOrdering },
      // Gsplat collection to render
      splats: { type: "t", value: SplatAccumulator.emptyTexture },
      splats2: { type: "t", value: SplatAccumulator.emptyTexture },
      // Time in seconds for time-based effects
      time: { value: 0 },
      // Delta time in seconds since last frame
      deltaTime: { value: 0 },
      // Debug flag that alternates each frame
      debugFlag: { value: false }
    };
    return uniforms;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queuedUpdate = null;
    if (this.target) {
      this.target.dispose();
      this.target = void 0;
    }
    if (this.backTarget) {
      this.backTarget.dispose();
      this.backTarget = void 0;
    }
    if (this.orderingTexture) {
      this.orderingTexture.dispose();
      this.orderingTexture = null;
    }
    const accumulators = /* @__PURE__ */ new Set();
    accumulators.add(this.display);
    accumulators.add(this.current);
    for (const accumulator of this.accumulators) {
      accumulators.add(accumulator);
    }
    for (const accumulator of accumulators) {
      accumulator.dispose();
    }
    if (this.sortWorker) {
      this.sortWorker.dispose();
      this.sortWorker = null;
    }
    this.sortCenterCache.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
  setDirty() {
    var _a;
    if (!this.dirty) {
      this.dirty = true;
      (_a = this.onDirty) == null ? void 0 : _a.call(this);
    }
  }
  createAccumulator() {
    return new SplatAccumulator();
  }
  takeAccumulator() {
    return this.accumulators.pop() ?? this.createAccumulator();
  }
  releaseAccumulator(accumulator) {
    this.accumulators.push(accumulator);
  }
  onBeforeRender(renderer, scene, camera) {
    var _a;
    const gaussianSplatRenderer = _GaussianSplatRenderer.gaussianSplatOverride ?? this;
    const frame = renderer.info.render.frame;
    const isNewFrame = frame !== gaussianSplatRenderer.lastFrame;
    gaussianSplatRenderer.lastFrame = frame;
    const currentRenderTarget = renderer.getRenderTarget();
    const isXRRenderTarget = checkIsXRRenderTarget(currentRenderTarget);
    if (currentRenderTarget) {
      gaussianSplatRenderer.renderSize.set(
        currentRenderTarget.width,
        currentRenderTarget.height
      );
      if (isXRRenderTarget && gaussianSplatRenderer.renderSize.x === 1 && gaussianSplatRenderer.renderSize.y === 1) {
        const baseLayer = (_a = renderer.xr.getSession()) == null ? void 0 : _a.renderState.baseLayer;
        if (baseLayer) {
          gaussianSplatRenderer.renderSize.x = baseLayer.framebufferWidth;
          gaussianSplatRenderer.renderSize.y = baseLayer.framebufferHeight;
        }
      }
    } else {
      renderer.getDrawingBufferSize(gaussianSplatRenderer.renderSize);
    }
    this.uniforms.renderSize.value.copy(gaussianSplatRenderer.renderSize);
    if (gaussianSplatRenderer.autoUpdate && isNewFrame) {
      const preUpdate = gaussianSplatRenderer.preUpdate && !renderer.xr.isPresenting;
      let useCamera = camera;
      if (renderer.xr.isPresenting) {
        const xrCamera = renderer.xr.getCamera();
        useCamera = xrCamera.cameras[0] ?? xrCamera;
      }
      if (preUpdate) {
        gaussianSplatRenderer.updateInternal({
          scene,
          camera: useCamera,
          autoUpdate: true
        });
      } else if (gaussianSplatRenderer.updateTimeoutId === -1) {
        gaussianSplatRenderer.updateTimeoutId = setTimeout(() => {
          gaussianSplatRenderer.updateTimeoutId = -1;
          gaussianSplatRenderer.updateInternal({
            scene,
            camera: useCamera,
            autoUpdate: true
          });
        }, 1);
      }
    }
    const typedCamera = camera;
    this.uniforms.near.value = typedCamera.near;
    this.uniforms.far.value = typedCamera.far;
    const geometry = this.geometry;
    geometry.instanceCount = gaussianSplatRenderer.activeSplats;
    const display = gaussianSplatRenderer.display;
    const accumToWorld = new THREE__namespace.Matrix4().makeTranslation(
      display.viewOrigin
    );
    const cameraToWorld = camera.matrixWorld.clone();
    const worldToCamera = cameraToWorld.invert();
    const accumToCamera = worldToCamera.multiply(accumToWorld);
    accumToCamera.decompose(
      this.uniforms.renderToViewPos.value,
      this.uniforms.renderToViewQuat.value,
      renderToViewScaleTmp
    );
    this.uniforms.renderToViewScale.value = (renderToViewScaleTmp.x + renderToViewScaleTmp.y + renderToViewScaleTmp.z) / 3;
    this.uniforms.maxStdDev.value = gaussianSplatRenderer.maxStdDev;
    this.uniforms.minPixelRadius.value = gaussianSplatRenderer.minPixelRadius;
    this.uniforms.maxPixelRadius.value = gaussianSplatRenderer.maxPixelRadius;
    this.uniforms.minAlpha.value = gaussianSplatRenderer.minAlpha;
    this.uniforms.enable2DGS.value = gaussianSplatRenderer.enable2DGS;
    this.uniforms.preBlurAmount.value = gaussianSplatRenderer.preBlurAmount;
    this.uniforms.blurAmount.value = gaussianSplatRenderer.blurAmount;
    this.uniforms.clipXY.value = gaussianSplatRenderer.clipXY;
    this.uniforms.focalAdjustment.value = gaussianSplatRenderer.focalAdjustment;
    const outputColorSpace = currentRenderTarget === null ? renderer.outputColorSpace : isXRRenderTarget ? currentRenderTarget.texture.colorSpace : THREE__namespace.ColorManagement.workingColorSpace;
    this.uniforms.encodeLinear.value = outputColorSpace !== THREE__namespace.SRGBColorSpace;
    this.uniforms.ordering.value = gaussianSplatRenderer.orderingTexture ?? _GaussianSplatRenderer.emptyOrdering;
    const splatTextures = display.getTextures();
    this.uniforms.splats.value = splatTextures[0];
    this.uniforms.splats2.value = splatTextures[1];
    this.uniforms.time.value = display.time;
    this.uniforms.deltaTime.value = display.deltaTime;
    this.uniforms.debugFlag.value = performance.now() / 1e3 % 2 < 1;
    gaussianSplatRenderer.dirty = false;
  }
  clearSplats() {
    this.activeSplats = 0;
    this.display.numSplats = 0;
    this.setDirty();
  }
  async update({
    scene,
    camera
  }) {
    await this.updateInternal({ scene, camera, autoUpdate: false });
  }
  updateInternal(request) {
    if (this.disposed) return Promise.resolve();
    const pending = this.queuedUpdate;
    this.queuedUpdate = {
      scene: request.scene,
      camera: request.camera,
      // A queued explicit update must not be weakened by a later automatic one.
      autoUpdate: request.autoUpdate && ((pending == null ? void 0 : pending.autoUpdate) ?? true)
    };
    if (!this.updateRunning) {
      this.updateRunning = true;
      this.updatePromise = this.drainUpdates();
    }
    return this.updatePromise;
  }
  async drainUpdates() {
    try {
      while (this.queuedUpdate) {
        const request = this.queuedUpdate;
        this.queuedUpdate = null;
        await this.performUpdate(request);
      }
    } catch (error) {
      this.queuedUpdate = null;
      throw error;
    } finally {
      this.updateRunning = false;
    }
  }
  async performUpdate({ scene, camera, autoUpdate }) {
    const renderer = this.renderer;
    if (this.ownsTimer) {
      this.timer.update();
    }
    const center = camera.getWorldPosition(new THREE__namespace.Vector3());
    const dir = camera.getWorldDirection(new THREE__namespace.Vector3());
    const viewChanged = center.distanceTo(this.sortedCenter) > 1e-3 * getCameraWorldScale(camera) || dir.dot(this.sortedDir) < 0.999 || this.sortRadial !== this.sortedRadial;
    const next = this.takeAccumulator();
    if (next === this.current) {
      throw new Error(
        "Next accumulator is the same as the current accumulator"
      );
    }
    let preparation;
    try {
      preparation = next.prepareGenerate({
        renderer,
        scene,
        timer: this.timer,
        camera,
        previous: this.current
      });
    } catch (error) {
      this.releaseAccumulator(next);
      throw error;
    }
    const { version, sortUpdated, generate } = preparation;
    let doUpdate = true;
    const needsUpdate = viewChanged || version !== this.current.version;
    const needsSort = viewChanged || sortUpdated;
    if (autoUpdate && !needsUpdate) {
      doUpdate = false;
    }
    if (!doUpdate) {
      this.releaseAccumulator(next);
    } else {
      try {
        generate();
      } catch (error) {
        this.releaseAccumulator(next);
        throw error;
      }
      if (sortUpdated) {
        this.sortCentersRevision += 1;
      }
      if (this.display.mappingVersion === next.mappingVersion && !needsSort) {
        this.releaseAccumulator(this.display);
        this.display = next;
      } else {
        if (this.display !== this.current) {
          this.releaseAccumulator(this.current);
        }
      }
      this.current = next;
      this.sortDirty || (this.sortDirty = needsSort);
      this.setDirty();
    }
    await this.driveSort();
  }
  async driveSort() {
    if (this.disposed || this.sorting || !this.sortDirty) {
      return;
    }
    const now = performance.now();
    const nextSortTime = this.lastSortTime ? this.lastSortTime + this.minSortIntervalMs : now;
    if (now < nextSortTime) {
      await new Promise((resolve) => setTimeout(resolve, nextSortTime - now));
      if (this.disposed) return;
    }
    this.sorting = true;
    this.sortDirty = false;
    this.lastSortTime = performance.now();
    const current = this.current;
    const previousActiveSplats = this.activeSplats;
    try {
      const { numSplats, maxSplats } = current;
      const rows = Math.max(1, Math.ceil(maxSplats / 16384));
      const orderingMaxSplats = rows * 16384;
      this.maxSplats = Math.max(this.maxSplats, orderingMaxSplats);
      const ordering = new Uint32Array(this.maxSplats);
      if (!this.sortWorker) {
        this.sortWorker = new SplatWorker();
      }
      const centersRevision = this.sortCentersRevision;
      if (this.uploadedSortCentersRevision !== centersRevision) {
        const { payload, commit } = this.sortCenterCache.prepare(current);
        await this.sortWorker.call("setSortCenterState", payload);
        commit();
        this.uploadedSortCentersRevision = centersRevision;
      }
      const sortRadial = this.sortRadial;
      const result = await this.sortWorker.call("sortCenters32", {
        numSplats,
        cameraPosition: [
          current.viewOrigin.x,
          current.viewOrigin.y,
          current.viewOrigin.z
        ],
        direction: [
          current.viewDirection.x,
          current.viewDirection.y,
          current.viewDirection.z
        ],
        radial: sortRadial,
        ordering
      });
      this.activeSplats = result.activeSplats;
      const activeRows = Math.ceil(result.activeSplats / 16384);
      if (this.orderingTexture && rows > this.orderingTexture.image.height) {
        this.orderingTexture.dispose();
        this.orderingTexture = null;
      }
      if (!this.orderingTexture) {
        const orderingTexture = new THREE__namespace.DataTexture(
          result.ordering,
          4096,
          rows,
          THREE__namespace.RGBAIntegerFormat,
          THREE__namespace.UnsignedIntType
        );
        orderingTexture.internalFormat = "RGBA32UI";
        orderingTexture.needsUpdate = true;
        this.orderingTexture = orderingTexture;
      } else {
        const renderer = this.renderer;
        if (!renderer.properties.has(this.orderingTexture)) {
          this.orderingTexture.image.data = result.ordering;
          this.orderingTexture.needsUpdate = true;
        } else if (activeRows > 0) {
          uploadU32DataTextureRows(
            renderer,
            this.orderingTexture,
            4096,
            activeRows,
            result.ordering
          );
        }
      }
      this.sortedCenter.copy(current.viewOrigin);
      this.sortedDir.copy(current.viewDirection);
      this.sortedRadial = sortRadial;
      if (this.current === current && this.display !== current) {
        this.releaseAccumulator(this.display);
        this.display = current;
      }
      this.setDirty();
    } catch (error) {
      if (this.disposed) return;
      this.sortDirty = true;
      if (this.current === current && current !== this.display && this.accumulators.length === 0) {
        this.current = this.display;
        this.releaseAccumulator(current);
        this.activeSplats = previousActiveSplats;
        this.sortDirty = false;
        this.uploadedSortCentersRevision = -1;
      }
      throw error;
    } finally {
      this.sorting = false;
    }
  }
  render(scene, camera) {
    const previousOverride = _GaussianSplatRenderer.gaussianSplatOverride;
    try {
      _GaussianSplatRenderer.gaussianSplatOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      _GaussianSplatRenderer.gaussianSplatOverride = previousOverride;
    }
  }
  renderTarget({
    scene,
    camera
  }) {
    const target = this.backTarget ?? this.target;
    if (!target) {
      throw new Error("No target");
    }
    const previousTarget = this.renderer.getRenderTarget();
    const previousOverride = _GaussianSplatRenderer.gaussianSplatOverride;
    try {
      this.renderer.setRenderTarget(target);
      _GaussianSplatRenderer.gaussianSplatOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      _GaussianSplatRenderer.gaussianSplatOverride = previousOverride;
      this.renderer.setRenderTarget(previousTarget);
    }
    if (target !== this.target) {
      [this.target, this.backTarget] = [this.backTarget, this.target];
    }
    return target;
  }
  // Read back the previously rendered target image as a Uint8Array of packed
  // RGBA values (in that order). Subsequent calls to this.readTarget()
  // will reuse the same buffers to minimize memory allocations.
  async readTarget() {
    if (!this.target) {
      throw new Error("Must initialize with target");
    }
    const { width, height } = this.target;
    const byteSize = width * height * 4;
    if (!this.superPixels || this.superPixels.length < byteSize) {
      this.superPixels = new Uint8Array(byteSize);
    }
    const superPixels = this.superPixels;
    await this.renderer.readRenderTargetPixelsAsync(
      this.target,
      0,
      0,
      width,
      height,
      superPixels
    );
    const { superXY } = this;
    if (superXY === 1) {
      return superPixels;
    }
    const subWidth = width / superXY;
    const subHeight = height / superXY;
    const subSize = subWidth * subHeight * 4;
    if (!this.targetPixels || this.targetPixels.length < subSize) {
      this.targetPixels = new Uint8Array(subSize);
    }
    const targetPixels = this.targetPixels;
    const super2 = superXY * superXY;
    for (let y = 0; y < subHeight; y++) {
      const row = y * subWidth;
      for (let x = 0; x < subWidth; x++) {
        const superCol = x * superXY;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < superXY; sy++) {
          const superRow = (y * superXY + sy) * width;
          for (let sx = 0; sx < superXY; sx++) {
            const superIndex = (superRow + superCol + sx) * 4;
            r += superPixels[superIndex];
            g += superPixels[superIndex + 1];
            b += superPixels[superIndex + 2];
            a += superPixels[superIndex + 3];
          }
        }
        const pixelIndex = (row + x) * 4;
        targetPixels[pixelIndex] = r / super2;
        targetPixels[pixelIndex + 1] = g / super2;
        targetPixels[pixelIndex + 2] = b / super2;
        targetPixels[pixelIndex + 3] = a / super2;
      }
    }
    return targetPixels;
  }
  async renderReadTarget({
    scene,
    camera
  }) {
    this.renderTarget({ scene, camera });
    return this.readTarget();
  }
  // Renders out the scene to a cube map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces.
  async renderCubeMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1e3,
    hideObjects = [],
    update = true,
    filter = false
  }) {
    if (!_GaussianSplatRenderer.cubeRender || _GaussianSplatRenderer.cubeRender.target.width !== size || _GaussianSplatRenderer.cubeRender.near !== near || _GaussianSplatRenderer.cubeRender.far !== far) {
      if (_GaussianSplatRenderer.cubeRender) {
        _GaussianSplatRenderer.cubeRender.target.dispose();
      }
      const target2 = new THREE__namespace.WebGLCubeRenderTarget(size, {
        format: THREE__namespace.RGBAFormat,
        type: THREE__namespace.UnsignedByteType,
        generateMipmaps: filter,
        minFilter: filter ? THREE__namespace.LinearMipMapLinearFilter : THREE__namespace.LinearFilter,
        magFilter: THREE__namespace.LinearFilter,
        colorSpace: filter ? THREE__namespace.LinearSRGBColorSpace : THREE__namespace.SRGBColorSpace
      });
      const cubeCamera2 = new THREE__namespace.CubeCamera(near, far, target2);
      _GaussianSplatRenderer.cubeRender = { target: target2, cubeCamera: cubeCamera2, near, far };
    }
    const { target, cubeCamera } = _GaussianSplatRenderer.cubeRender;
    cubeCamera.position.copy(worldCenter);
    const objectVisibility = /* @__PURE__ */ new Map();
    for (const object of hideObjects) {
      if (!objectVisibility.has(object)) {
        objectVisibility.set(object, object.visible);
      }
      object.visible = false;
    }
    const previousOverride = _GaussianSplatRenderer.gaussianSplatOverride;
    try {
      if (update) {
        const tempCamera = new THREE__namespace.Camera();
        tempCamera.position.copy(worldCenter);
        await this.update({ scene, camera: tempCamera });
      }
      _GaussianSplatRenderer.gaussianSplatOverride = this;
      cubeCamera.update(this.renderer, scene);
      return target.texture;
    } finally {
      _GaussianSplatRenderer.gaussianSplatOverride = previousOverride;
      for (const [object, visible] of objectVisibility.entries()) {
        object.visible = visible;
      }
    }
  }
  async readCubeTargets() {
    if (!_GaussianSplatRenderer.cubeRender) {
      throw new Error("No cube render");
    }
    const { target } = _GaussianSplatRenderer.cubeRender;
    const { width, height } = target;
    const promises = [];
    const buffers = [];
    for (let i = 0; i < target.texture.images.length; ++i) {
      const byteSize = width * height * 4;
      const readback = new Uint8Array(byteSize);
      buffers.push(readback);
      const promise = this.renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
        readback,
        i
      );
      promises.push(promise);
    }
    await Promise.all(promises);
    return buffers;
  }
  // Renders out the scene to an environment map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces,
  // then pre-filters them using THREE.PMREMGenerator and returns a THREE.Texture
  // that can assigned directly to a THREE.MeshStandardMaterial.envMap property.
  async renderEnvMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1e3,
    hideObjects = [],
    update = true
  }) {
    var _a;
    const cubeTexture = await this.renderCubeMap({
      scene,
      worldCenter,
      size,
      near,
      far,
      hideObjects,
      update,
      filter: true
    });
    if (!_GaussianSplatRenderer.pmrem) {
      _GaussianSplatRenderer.pmrem = new THREE__namespace.PMREMGenerator(this.renderer);
    }
    return (_a = _GaussianSplatRenderer.pmrem) == null ? void 0 : _a.fromCubemap(cubeTexture).texture;
  }
  // Utility function to recursively set the envMap property for any
  // THREE.MeshStandardMaterial within the subtree of root.
  recurseSetEnvMap(root, envMap) {
    root.traverse((node) => {
      if (node instanceof THREE__namespace.Mesh) {
        if (Array.isArray(node.material)) {
          for (const material of node.material) {
            if (material instanceof THREE__namespace.MeshStandardMaterial) {
              material.envMap = envMap;
            }
          }
        } else {
          if (node.material instanceof THREE__namespace.MeshStandardMaterial) {
            node.material.envMap = envMap;
          }
        }
      }
    });
  }
  get premultipliedAlpha() {
    return this.material.premultipliedAlpha;
  }
  set premultipliedAlpha(value) {
    if (this.material.premultipliedAlpha !== value) {
      this.material.premultipliedAlpha = value;
      this.material.needsUpdate = true;
    }
  }
};
_GaussianSplatRenderer.emptyOrdering = (() => {
  const numIndices = 4 * 4096 * 1;
  const emptyArray = new Uint32Array(numIndices);
  const texture = new THREE__namespace.DataTexture(emptyArray, 4096, 1);
  texture.format = THREE__namespace.RGBAIntegerFormat;
  texture.type = THREE__namespace.UnsignedIntType;
  texture.internalFormat = "RGBA32UI";
  texture.needsUpdate = true;
  return texture;
})();
_GaussianSplatRenderer.cubeRender = null;
_GaussianSplatRenderer.pmrem = null;
let GaussianSplatRenderer = _GaussianSplatRenderer;
function checkIsXRRenderTarget(renderTarget) {
  return renderTarget == null ? void 0 : renderTarget.isXRRenderTarget;
}
exports.GaussianSplatRenderer = GaussianSplatRenderer;
exports.SplatAccumulator = SplatAccumulator;
exports.SplatEdit = SplatEdit;
exports.SplatEditRgbaBlendMode = SplatEditRgbaBlendMode;
exports.SplatEditSdf = SplatEditSdf;
exports.SplatEditSdfType = SplatEditSdfType;
exports.SplatEdits = SplatEdits;
exports.SplatFileType = SplatFileType;
exports.SplatLoader = SplatLoader;
exports.SplatMesh = SplatMesh;
exports.Splats = Splats;
exports.defines = defines;
exports.fromHalf = fromHalf;
exports.toHalf = toHalf;
exports.utils = utils;
//# sourceMappingURL=gaussian-splat-lite.cjs.map
