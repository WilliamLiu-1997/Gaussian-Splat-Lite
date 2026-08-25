import { SplatShTextures, SplatSource } from './SplatSource.cjs';
import { SplatFileType } from './defines.cjs';
import * as THREE from "three";
export type SplatsOptions = {
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    /** Exact number of bytes yielded by stream; also used for allocation validation. */
    streamLength?: number;
    maxSplats?: number;
    splatArrays?: [Uint32Array, Uint32Array];
    numSplats?: number;
    construct?: (splats: Splats) => Promise<void> | void;
    onProgress?: (event: ProgressEvent) => void;
    extra?: Record<string, unknown>;
};
/** A mutable splat source with two 16-byte texture records per splat. */
export declare class Splats implements SplatSource {
    maxSplats: number;
    numSplats: number;
    splatArrays: [Uint32Array, Uint32Array];
    extra: Record<string, unknown>;
    initialized: Promise<Splats>;
    isInitialized: boolean;
    needsUpdate: boolean;
    private textures;
    private shTextures;
    constructor(options?: SplatsOptions);
    reinitialize(options: SplatsOptions): void;
    initialize(options: SplatsOptions): void;
    private asyncInitialize;
    dispose(): void;
    private disposeTextures;
    getNumSplats(): number;
    getNumSh(): 1 | 0 | 2 | 3;
    ensureSplats(numSplats: number): [Uint32Array, Uint32Array];
    getSplat(index: number): {
        center: THREE.Vector3;
        scales: THREE.Vector3;
        quaternion: THREE.Quaternion;
        color: THREE.Color;
        opacity: number;
    };
    setSplat(index: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color): void;
    pushSplat(center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color): void;
    forEachCenter(callback: (index: number, x: number, y: number, z: number) => void): void;
    forEachSplat(callback: (index: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => void): void;
    getSplatTextures(): readonly [THREE.DataArrayTexture, THREE.DataArrayTexture];
    private disposeMainTextures;
    getShTextures(): SplatShTextures;
    private ensureShTexture;
    static emptyTexture: THREE.DataArrayTexture;
}
