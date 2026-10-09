import * as THREE from "three";
export function resolveTimer(timer) {
  return {
    timer: timer ?? new THREE.Timer(),
    // A caller-supplied timer may be shared with other systems, so only update
    // the timer that Gaussian Splat Lite creates and owns itself.
    ownsTimer: timer === undefined,
  };
}
export const threeRevision = Number.parseInt(THREE.REVISION);
