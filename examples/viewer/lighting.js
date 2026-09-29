import * as THREE from "three";

const LIGHT_COLORS = [0xff2020, 0x20ff40, 0x3060ff];

// The example owns only scene objects; lighting and shadows belong to the library.
export function createViewerLighting(renderer, scene, splats) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const geometry = new THREE.SphereGeometry(1, 20, 12);
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
  const lights = LIGHT_COLORS.map((color) => {
    const light = new THREE.PointLight(color, 1);
    const ball = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    ball.raycast = () => {};
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTexture,
        color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    halo.raycast = () => {};
    light.add(ball, halo);
    group.add(light);
    return light;
  });
  const ambient = new THREE.AmbientLight(0xffffff);
  group.add(ambient);
  for (const light of lights) light.shadow.mapSize.set(256, 256);
  const center = new THREE.Vector3();
  const settings = {
    enabled: true,
    animate: true,
    shadows: true,
    ambient: 0.35,
    intensity: 0.8,
  };
  let scale = 1;
  let angle = 0;
  let lastTime;
  let framed = false;
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
    splats.lighting = group.visible;
    ambient.intensity = settings.ambient * Math.PI;
    lights.forEach((light, index) => {
      light.intensity = settings.intensity * scale * scale;
      light.distance = scale * 2.5;
      light.castShadow = settings.shadows;
      light.shadow.camera.near = scale * 0.01;
      light.shadow.camera.far = scale * 3;
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = scale * 0.015;
      const phase = angle + (index * Math.PI * 2) / 3;
      light.position
        .set(
          Math.cos(phase) * scale * 1.5,
          scale * (0.65 + 0.2 * Math.sin(phase * 2)),
          Math.sin(phase) * scale * 1.5,
        )
        .add(center);
      light.children[0].scale.setScalar(scale * 0.025);
      light.children[1].scale.setScalar(scale * 0.18);
    });
  }

  return {
    settings,
    group,
    syncColors() {
      lights.forEach((light, index) => {
        light.color.setHex(LIGHT_COLORS[index]);
        // Light energy is linear even when splats blend in an sRGB working space.
        if (THREE.ColorManagement.workingColorSpace === THREE.SRGBColorSpace)
          light.color.convertSRGBToLinear();
        for (const child of light.children)
          child.material.color.setHex(LIGHT_COLORS[index]);
      });
    },
    get frame() {
      return framed ? { position: center, radius: scale } : null;
    },
    get animated() {
      return framed && settings.enabled && settings.animate;
    },
    setFrame(position, radius) {
      center.copy(position);
      scale = Math.max(radius, 0.01);
      framed = true;
      update(performance.now());
    },
    clear() {
      framed = false;
      group.visible = false;
      lastTime = undefined;
    },
    update,
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      for (const light of lights) {
        light.shadow.dispose();
        for (const child of light.children) child.material.dispose();
      }
      haloTexture.dispose();
    },
  };
}
