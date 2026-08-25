import { SplatAccumulator } from './SplatAccumulator';
import type * as THREE from "three";
/**
 * Re-expresses an affine transform so it consumes positions relative to
 * `origin` instead of absolute world positions.
 *
 * If `matrix` maps p to A * p + t, the rebased matrix maps (p - origin) to
 * A * (p - origin) + (A * origin + t), which is the same result without doing
 * a large-coordinate subtraction in float32 shader code.
 */
export declare function rebaseAffineTransform(matrix: THREE.Matrix4, origin: THREE.Vector3): THREE.Matrix4;
/**
 * Tracks the per-mesh sort centers cached by the worker. The main thread only
 * builds changed meshes; unchanged centers remain exclusively in WASM.
 */
export declare class SortCenterCache {
    private entries;
    private freeMeshIds;
    private nextMeshId;
    private allocateMeshId;
    dispose(): void;
    prepare(current: SplatAccumulator): {
        payload: {
            updateRangeIndices: Uint32Array<ArrayBuffer>;
            updateCenters: Float32Array<ArrayBuffer>;
            rangeMeshIds: Uint32Array<ArrayBuffer>;
            rangeBases: Uint32Array<ArrayBuffer>;
            rangeCounts: Uint32Array<ArrayBuffer>;
            rangeOrigins: Float64Array<ArrayBuffer>;
        };
        commit: () => void;
    };
}
