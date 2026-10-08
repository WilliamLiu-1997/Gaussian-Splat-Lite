import { SplatEdit, SplatMesh } from "gaussian-splat-lite";
import { SplatLightingPlugin } from "gaussian-splat-lite/plugins";
import * as THREE from "three";

const LIGHT_COLORS = [0xff2020, 0x20ff40, 0x3060ff];
// A paused light redraws its shadow map this often at most while casters
// keep changing, as streamed detail does under a moving camera.
const SHADOW_REFRESH_MS = 200;

// The plugin owns Splat lighting; the example owns the scene's lights and lamps.
export function createViewerLighting(renderer, scene, splats) {
  const plugin = new SplatLightingPlugin({ enabled: false });
  splats.registerPlugin(plugin);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const geometry = new THREE.CylinderGeometry(0.4, 1, 1.5, 16).rotateX(
    Math.PI / 2,
  );
  const lensGeometry = new THREE.CircleGeometry(0.85, 16).rotateY(Math.PI);
  const haloPixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const radius = Math.hypot((x + 0.5) / 16 - 1, (y + 0.5) / 16 - 1);
      const index = (y * 32 + x) * 4;
      haloPixels.set(
        [255, 255, 255, Math.round(Math.max(0, 1 - radius) ** 3 * 160)],
        index,
      );
    }
  const haloTexture = new THREE.DataTexture(haloPixels, 32, 32);
  haloTexture.needsUpdate = true;
  const light = new THREE.SpotLight(
    LIGHT_COLORS[0],
    1,
    0,
    Math.PI / 3,
    0.3,
    0.5,
  );
  const housing = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x383838, toneMapped: false }),
  );
  const lens = new THREE.Mesh(
    lensGeometry,
    new THREE.MeshBasicMaterial({ color: LIGHT_COLORS[0], toneMapped: false }),
  );
  lens.position.z = -0.76;
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTexture,
      color: LIGHT_COLORS[0],
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  halo.position.z = -0.8;
  halo.scale.setScalar(4.5);
  const lamp = new THREE.Group();
  lamp.add(housing, lens, halo);
  for (const object of lamp.children) object.raycast = () => {};
  light.add(lamp);
  const ambient = new THREE.AmbientLight(0xffffff);
  group.add(light, light.target, ambient);
  light.shadow.mapSize.set(256, 256);
  const colors = LIGHT_COLORS.map((color) => new THREE.Color(color));
  const center = new THREE.Vector3();
  const settings = {
    enabled: false,
    animate: true,
    shadows: true,
    ambient: 0.35,
    intensity: 1,
  };
  let scale = 1;
  let angle = 0;
  let lastTime;
  let framed = false;
  let shadowsEnabled = false;
  const lightPosition = new THREE.Vector3();
  const casters = new Map();
  let quality = [];
  // Casters changed since the shadow maps were last asked to redraw, and when.
  let castersChanged = false;
  let shadowsRefreshed = Number.NEGATIVE_INFINITY;
  // This update asked for new shadow maps, so the viewer has a frame to draw.
  let shadowsStale = false;

  function updateShadows(time) {
    const nextQuality = [
      scale,
      splats.maxStdDev,
      splats.minAlpha,
      splats.preBlurAmount,
      splats.blurAmount,
      splats.clipXY,
      splats.focalAdjustment,
    ];
    let changed =
      !shadowsEnabled || nextQuality.some((value, i) => value !== quality[i]);
    quality = nextQuality;
    let dynamic = settings.animate;
    const visible = new Set();
    scene.traverseVisible((object) => {
      const isSplat = object instanceof SplatMesh;
      // These can change during rendering, after this snapshot is taken.
      if (object instanceof SplatEdit) dynamic = true;
      if (isSplat && object.onFrame) dynamic = true;
      const castShadow = isSplat
        ? plugin.getModelOptions(object).castShadow
        : object.castShadow;
      if (!castShadow) return;
      if (!isSplat) {
        // The Splat renderer's children are its own shadow draws.
        if (object.isMesh && object.parent !== splats) dynamic = true;
        return;
      }
      if (!object.isInitialized) return;
      if (object.edits?.length) dynamic = true;
      object.updateWorldMatrix(true, false);
      visible.add(object);
      let previous = casters.get(object);
      if (
        !previous ||
        previous.source !== object.splats ||
        previous.version !== object.version ||
        previous.opacity !== object.opacity ||
        previous.layers !== object.layers.mask ||
        object.splats.needsUpdate ||
        !previous.matrix.equals(object.matrixWorld)
      ) {
        castersChanged = true;
        previous ??= { matrix: new THREE.Matrix4() };
        previous.source = object.splats;
        previous.version = object.version;
        previous.opacity = object.opacity;
        previous.layers = object.layers.mask;
        previous.matrix.copy(object.matrixWorld);
        casters.set(object, previous);
      }
    });
    for (const object of casters.keys()) {
      if (visible.has(object)) continue;
      casters.delete(object);
      castersChanged = true;
    }
    // A single change redraws the maps at once; a run of them, such as a
    // streamed scene fading between levels of detail, at the pace above. The
    // last change of a run is always followed by a redraw.
    if (
      dynamic ||
      (castersChanged && time - shadowsRefreshed >= SHADOW_REFRESH_MS)
    )
      changed = true;
    shadowsStale = false;
    light.shadow.autoUpdate = dynamic;
    if (changed || !lightPosition.equals(light.position)) {
      light.shadow.needsUpdate = true;
      shadowsStale = !dynamic;
    }
    lightPosition.copy(light.position);
    if (changed) {
      castersChanged = false;
      shadowsRefreshed = time;
    }
    shadowsEnabled = true;
  }

  function update(time) {
    if (
      lastTime !== undefined &&
      settings.animate &&
      settings.enabled &&
      framed
    ) {
      angle += Math.min((time - lastTime) / 1000, 0.1) * 0.45;
    }
    lastTime = time;
    group.visible = framed && settings.enabled;
    plugin.enabled = group.visible;
    ambient.intensity = settings.ambient * Math.PI;
    const colorPhase = (time / 3000) % colors.length;
    const colorIndex = Math.floor(colorPhase);
    light.color.lerpColors(
      colors[colorIndex],
      colors[(colorIndex + 1) % colors.length],
      colorPhase - colorIndex,
    );
    lens.material.color.copy(light.color);
    if (THREE.ColorManagement.workingColorSpace === THREE.SRGBColorSpace)
      lens.material.color.convertLinearToSRGB();
    halo.material.color.copy(lens.material.color);
    light.intensity = settings.intensity * scale * scale;
    light.distance = scale * 3.75;
    light.castShadow = settings.shadows;
    // Keep the range stable while reusing a shadow map, so receivers
    // decode its stored depth with the same projection.
    const camera = light.shadow.camera;
    const near = scale * 0.01;
    if (camera.near !== near || camera.far !== light.distance) {
      camera.near = near;
      camera.far = light.distance;
      camera.updateProjectionMatrix();
    }
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = scale * 0.015;
    // Sweep the front (+Z) semicircle, reversing smoothly at either side.
    const sweep = Math.sin(angle) * (Math.PI / 2);
    light.position
      .set(
        Math.sin(sweep) * scale * 1.8,
        scale * 1.2,
        Math.cos(sweep) * scale * 1.8,
      )
      .add(center);
    light.lookAt(center);
    lamp.scale.setScalar(scale * 0.04);
    if (group.visible && settings.shadows) updateShadows(time);
    else {
      shadowsEnabled = false;
      shadowsStale = false;
    }
  }

  return {
    plugin,
    settings,
    group,
    syncColors() {
      colors.forEach((color, index) => {
        color.setHex(LIGHT_COLORS[index]);
        // Light energy is linear even when splats blend in an sRGB working space.
        if (THREE.ColorManagement.workingColorSpace === THREE.SRGBColorSpace)
          color.convertSRGBToLinear();
      });
    },
    get frame() {
      return framed ? { position: center, radius: scale } : null;
    },
    /** The enabled light keeps drawing as its color changes. */
    get needsRender() {
      return (framed && settings.enabled) || shadowsStale;
    },
    setFrame(position, radius) {
      center.copy(position);
      scale = Math.max(radius, 0.01);
      light.target.position.copy(center);
      framed = true;
      update(performance.now());
    },
    clear() {
      framed = false;
      group.visible = false;
      plugin.enabled = false;
      lastTime = undefined;
      shadowsEnabled = false;
      shadowsStale = false;
      casters.clear();
    },
    update,
    dispose() {
      casters.clear();
      group.removeFromParent();
      geometry.dispose();
      lensGeometry.dispose();
      light.shadow.dispose();
      for (const object of lamp.children) object.material.dispose();
      haloTexture.dispose();
    },
  };
}
