import type * as THREE from "three";
/** Keeps public material state and explicit shader updates across variants. */
export declare class MaterialState {
  private versions;
  constructor(material: THREE.Material);
  sync(target: THREE.Material, source: THREE.Material): void;
  /** Records updates made by the renderer itself. */
  record(material: THREE.Material): void;
}
