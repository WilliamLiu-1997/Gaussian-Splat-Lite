import * as THREE from "three";
export declare enum SplatEditSdfType {
    ALL = "all",
    PLANE = "plane",
    SPHERE = "sphere",
    BOX = "box",
    ELLIPSOID = "ellipsoid",
    CYLINDER = "cylinder",
    CAPSULE = "capsule",
    INFINITE_CONE = "infinite_cone"
}
/** RGBA-only operations supported by the SDF pipeline. */
export declare enum SplatEditRgbaBlendMode {
    MULTIPLY = "multiply",
    SET_RGB = "set_rgb",
    ADD_RGBA = "add_rgba"
}
export type SplatEditSdfOptions = {
    type?: SplatEditSdfType;
    invert?: boolean;
    opacity?: number;
    color?: THREE.Color;
    radius?: number;
};
/** A signed-distance shape carrying only color and opacity. */
export declare class SplatEditSdf extends THREE.Object3D {
    type: SplatEditSdfType;
    invert: boolean;
    opacity: number;
    color: THREE.Color;
    radius: number;
    constructor(options?: SplatEditSdfOptions);
}
export type SplatEditOptions = {
    name?: string;
    rgbaBlendMode?: SplatEditRgbaBlendMode;
    sdfSmooth?: number;
    softEdge?: number;
    invert?: boolean;
    sdfs?: SplatEditSdf[];
};
/** An ordered RGBA operation evaluated over one or more SDF shapes. */
export declare class SplatEdit extends THREE.Object3D {
    ordering: number;
    rgbaBlendMode: SplatEditRgbaBlendMode;
    sdfSmooth: number;
    softEdge: number;
    invert: boolean;
    sdfs: SplatEditSdf[] | null;
    static nextOrdering: number;
    constructor(options?: SplatEditOptions);
    addSdf(sdf: SplatEditSdf): void;
    removeSdf(sdf: SplatEditSdf): void;
}
export type SplatEditGroup = {
    edit: SplatEdit;
    sdfs: SplatEditSdf[];
};
/** Encodes SDF geometry/RGBA and edit operations as regular integer textures. */
export declare class SplatEdits {
    maxSdfs: number;
    numSdfs: number;
    sdfData: Uint32Array;
    sdfFloatData: Float32Array;
    sdfTexture: THREE.DataTexture;
    maxEdits: number;
    numEdits: number;
    editData: Uint32Array;
    editFloatData: Float32Array;
    editTexture: THREE.DataTexture;
    constructor({ maxSdfs, maxEdits }?: {
        maxSdfs?: number | undefined;
        maxEdits?: number | undefined;
    });
    dispose(): void;
    update(groups: SplatEditGroup[], coordinateOrigin?: THREE.Vector3): {
        updated: boolean;
    };
    private ensureCapacity;
    private encodeEdit;
    private encodeSdf;
    private setSdfUint;
    private setSdfFloat;
    private setEditUint;
    private setEditFloat;
    static emptyTexture: THREE.DataTexture;
}
