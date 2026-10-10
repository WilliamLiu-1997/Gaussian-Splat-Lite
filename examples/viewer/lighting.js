import * as THREE from "three";

const LIGHT_COLORS = [0xff2020, 0x20ff40, 0x3060ff];

// One set of lights for the scene; `bind` names the renderer they light.
export function createViewerLighting(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const geometry = new THREE.SphereGeometry(1, 20, 12);
  const lights = LIGHT_COLORS.map((color) => {
    const light = new THREE.PointLight(color, 2, 0, 1);
    const ball = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    ball.raycast = () => {};
    light.add(ball);
    group.add(light);
    return light;
  });
  const ambient = new THREE.AmbientLight(0xffffff);
  group.add(ambient);
  const center = new THREE.Vector3();
  const settings = {
    enabled: false,
    animate: true,
    ambient: 0.35,
    intensity: 2,
  };
  let splats = null;
  let scale = 1;
  let angle = 0;
  let lastTime;
  let framed = false;
  let wasMoving = false;

  function update(time) {
    const visible = framed && settings.enabled;
    const moving = visible && settings.animate;
    // Draw once more when motion stops or the lamps are hidden.
    const changed = moving || wasMoving || group.visible !== visible;
    if (moving && lastTime !== undefined) {
      angle += Math.min((time - lastTime) / 1000, 0.1) * 0.45;
    }
    wasMoving = moving;
    lastTime = time;
    group.visible = visible;
    splats.lighting = visible;
    if (!visible) return changed;

    ambient.intensity = settings.ambient * Math.PI;
    lights.forEach((light, index) => {
      light.intensity = settings.intensity * scale;
      light.distance = scale * 4;
      const phase = angle + (index * Math.PI * 2) / 3;
      light.position
        .set(
          Math.cos(phase) * scale * 1.5,
          scale * (0.65 + 0.2 * Math.sin(phase * 2)),
          Math.sin(phase) * scale * 1.5,
        )
        .add(center);
    });
    return changed;
  }

  return {
    settings,
    bind(renderer) {
      splats = renderer;
      update(performance.now());
    },
    syncColors() {
      lights.forEach((light, index) => {
        light.color.setHex(LIGHT_COLORS[index]);
        // Lighting uses linear energy even when the viewer blends in sRGB.
        if (THREE.ColorManagement.workingColorSpace === THREE.SRGBColorSpace)
          light.color.convertSRGBToLinear();
        light.children[0].material.color.setHex(LIGHT_COLORS[index]);
      });
    },
    setFrame(position, radius) {
      center.copy(position);
      scale = radius;
      framed = true;
      for (const light of lights)
        light.children[0].scale.setScalar(scale * 0.025);
      update(performance.now());
    },
    clear() {
      framed = false;
      group.visible = false;
      splats.lighting = false;
      lastTime = undefined;
      wasMoving = false;
    },
    update,
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      for (const light of lights) light.children[0].material.dispose();
    },
  };
}
