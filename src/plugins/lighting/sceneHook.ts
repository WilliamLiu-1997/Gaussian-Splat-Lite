import type * as THREE from "three";

export type SceneRenderListener = {
  /**
   * A render of the scene begins: before Three.js draws that render's shadow
   * maps, where an object's own onBeforeRender comes after them.
   */
  begin(renderer: unknown, camera: THREE.Camera): void;
  /** That render is over. Renders nest: shadow passes run inside one. */
  end(renderer: unknown): void;
};

type Hook = {
  listeners: Set<SceneRenderListener>;
  before: [THREE.Scene["onBeforeRender"], THREE.Scene["onBeforeRender"]];
  after: [THREE.Scene["onAfterRender"], THREE.Scene["onAfterRender"]];
};

const hooks = new WeakMap<THREE.Scene, Hook>();

/**
 * Tells `listener` of each render of `scene`, through the scene's render
 * callbacks. Returns a function that ends this.
 */
export function onSceneRender(
  scene: THREE.Scene,
  listener: SceneRenderListener,
) {
  let hook = hooks.get(scene);
  if (!hook) {
    const listeners = new Set<SceneRenderListener>();
    const previousBefore = scene.onBeforeRender;
    const previousAfter = scene.onAfterRender;
    const before: THREE.Scene["onBeforeRender"] = function (
      this: THREE.Scene,
      ...args
    ) {
      previousBefore.apply(this, args);
      for (const each of listeners) each.begin(args[0], args[2]);
    };
    const after: THREE.Scene["onAfterRender"] = function (
      this: THREE.Scene,
      ...args
    ) {
      previousAfter.apply(this, args);
      for (const each of listeners) each.end(args[0]);
    };
    hook = {
      listeners,
      before: [previousBefore, before],
      after: [previousAfter, after],
    };
    hooks.set(scene, hook);
    scene.onBeforeRender = before;
    scene.onAfterRender = after;
  }
  const installed = hook;
  installed.listeners.add(listener);
  return () => {
    installed.listeners.delete(listener);
    if (installed.listeners.size > 0 || hooks.get(scene) !== installed) return;
    // Leave callbacks that were installed over these in place.
    const [previousBefore, before] = installed.before;
    const [previousAfter, after] = installed.after;
    if (scene.onBeforeRender === before) scene.onBeforeRender = previousBefore;
    if (scene.onAfterRender === after) scene.onAfterRender = previousAfter;
    hooks.delete(scene);
  };
}
