import * as THREE from "three";
export declare const threeRevision: number;
export declare const threeMrtArray: boolean;
export declare function floatBitsToUint(f: number): number;
export declare function uintBitsToFloat(u: number): number;
export declare const toHalf: typeof toHalfNative;
export declare const fromHalf: typeof fromHalfNative;
declare function toHalfNative(f: number): number;
declare function fromHalfNative(u: number): number;
export declare function getTransferable(ctx: unknown): Transferable[];
export declare function encodeSplat(splatArrays: [Uint32Array, Uint32Array], index: number, x: number, y: number, z: number, scaleX: number, scaleY: number, scaleZ: number, quatX: number, quatY: number, quatZ: number, quatW: number, opacity: number, r: number, g: number, b: number): void;
export declare function decodeSplat(splatArrays: [Uint32Array, Uint32Array], index: number): {
    center: THREE.Vector3;
    scales: THREE.Vector3;
    quaternion: THREE.Quaternion;
    color: THREE.Color;
    opacity: number;
};
export declare function getTextureSize(numSplats: number): {
    width: number;
    height: number;
    depth: number;
    maxSplats: number;
};
export declare const IDENT_VERTEX_SHADER = "\nprecision highp float;\n\nin vec3 position;\n\nvoid main() {\n  gl_Position = vec4(position.xy, 0.0, 1.0);\n}\n";
export declare function encodeQuatOctXy1010R12(qx: number, qy: number, qz: number, qw: number): number;
export declare function decodeQuatOctXy1010R12(encoded: number, out: THREE.Quaternion): THREE.Quaternion;
export declare function uploadU32DataTextureRows(renderer: THREE.WebGLRenderer, texture: THREE.Texture, width: number, rows: number, data: Uint32Array): void;
export declare function resolveTimer(timer?: THREE.Timer): {
    timer: THREE.Timer;
    ownsTimer: boolean;
};
export {};
