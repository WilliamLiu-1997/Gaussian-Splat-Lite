import { SplatMesh } from './SplatMesh.cjs';
import * as THREE from "three";
export type SplatMapping = {
    node: SplatMesh;
    version: number;
    sortVersion: number;
    mappingVersion: number;
    base: number;
    count: number;
};
type SplatDataTextures = readonly [
    THREE.DataArrayTexture,
    THREE.DataArrayTexture
];
export declare class SplatAccumulator {
    time: number;
    deltaTime: number;
    viewOrigin: THREE.Vector3;
    viewDirection: THREE.Vector3;
    maxSplats: number;
    numSplats: number;
    target: THREE.WebGLArrayRenderTarget | null;
    mapping: SplatMapping[];
    version: number;
    mappingVersion: number;
    private transformScale;
    private transformQuaternion;
    constructor();
    dispose(): void;
    getTextures(): SplatDataTextures;
    generateMapping(splatCounts: number[]): {
        maxSplats: number;
        mapping: {
            base: number;
            count: number;
        }[];
    };
    ensureGenerate({ maxSplats }: {
        maxSplats: number;
    }): boolean;
    private getMaterial;
    private prepareMaterial;
    generate({ mesh, base, count, renderer, }: {
        mesh: SplatMesh;
        base: number;
        count: number;
        renderer: THREE.WebGLRenderer;
    }): void;
    prepareGenerate({ renderer, scene, timer, camera, previous, }: {
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        timer: THREE.Timer;
        camera: THREE.Camera;
        previous: SplatAccumulator;
    }): {
        version: number;
        sortUpdated: boolean;
        generate: () => void;
    };
    checkVersions(other: SplatMapping[]): {
        splatsUpdated: boolean;
        mappingUpdated: boolean;
        sortUpdated: boolean;
    };
    private saveRenderState;
    private resetRenderState;
    static emptyTexture: THREE.DataArrayTexture;
    static emptyTextures: SplatDataTextures;
    private static material;
    private static fullScreenQuad;
}
export {};
