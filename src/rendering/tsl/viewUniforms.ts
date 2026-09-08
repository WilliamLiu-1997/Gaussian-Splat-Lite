import * as THREE from "three";
import * as TSL from "three/tsl";
import type { Uniforms } from "../uniforms";
import { type TSLNode, uniformBinding } from "./shaderUtils";

const N = TSL as Record<string, TSLNode>;

/** Viewport data for drawing splats that have already been projected. */
export function splatViewportUniforms(
  uniforms: Uniforms,
  camera: THREE.Camera,
) {
  const arrayCamera = camera as THREE.ArrayCamera;
  if (!arrayCamera.isArrayCamera || arrayCamera.cameras.length === 0) {
    return {
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      viewportOrigin: uniformBinding(uniforms, "viewportOrigin", "vec2"),
    };
  }

  const views = arrayCamera.cameras.map(() => new THREE.Vector4());
  const viewData = N.uniformArray(views, "vec4").onObjectUpdate(
    ({ camera }: { camera: THREE.ArrayCamera }) => {
      camera.cameras.forEach((eye, i) => {
        const size = uniforms.renderSize.value;
        views[i].set(
          eye.viewport?.z ?? size.x,
          eye.viewport?.w ?? size.y,
          eye.viewport?.x ?? 0,
          eye.viewport?.y ?? 0,
        );
      });
    },
  );
  const index = (camera as THREE.ArrayCamera & { isMultiViewCamera?: boolean })
    .isMultiViewCamera
    ? N.builtin("gl_ViewID_OVR")
    : N.cameraIndex;
  const viewport = viewData.element(index);
  return { renderSize: viewport.xy, viewportOrigin: viewport.zw };
}

export function splatViewUniforms(uniforms: Uniforms, camera: THREE.Camera) {
  const arrayCamera = camera as THREE.ArrayCamera;
  if (!arrayCamera.isArrayCamera || arrayCamera.cameras.length === 0) {
    return {
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      viewportOrigin: uniformBinding(uniforms, "viewportOrigin", "vec2"),
      renderToViewQuat: uniformBinding(uniforms, "renderToViewQuat", "vec4"),
      renderToViewPos: uniformBinding(uniforms, "renderToViewPos", "vec3"),
      renderToViewScale: uniformBinding(uniforms, "renderToViewScale", "float"),
      near: uniformBinding(uniforms, "near", "float"),
      far: uniformBinding(uniforms, "far", "float"),
    };
  }

  // ArrayCamera draws do not call onBeforeRender separately for each eye.
  // Pack rotation, position/scale, viewport/clipping and pixel origin per eye.
  const views = arrayCamera.cameras.flatMap(() => [
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
  ]);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const viewData = N.uniformArray(views, "vec4").onObjectUpdate(
    ({ camera }: { camera: THREE.ArrayCamera }) => {
      camera.cameras.forEach((eye, i) => {
        // Subtract the world origin in CPU double precision before GPU upload.
        matrix.makeTranslation(uniforms.renderOrigin.value);
        matrix.premultiply(eye.matrixWorldInverse);
        matrix.decompose(position, rotation, scale);
        views[i * 4].set(rotation.x, rotation.y, rotation.z, rotation.w);
        views[i * 4 + 1].set(
          position.x,
          position.y,
          position.z,
          (scale.x + scale.y + scale.z) / 3,
        );
        const size = uniforms.renderSize.value;
        views[i * 4 + 2].set(
          eye.viewport?.z ?? size.x,
          eye.viewport?.w ?? size.y,
          eye.near,
          eye.far,
        );
        views[i * 4 + 3].set(eye.viewport?.x ?? 0, eye.viewport?.y ?? 0, 0, 0);
      });
    },
  );
  const index = (camera as THREE.ArrayCamera & { isMultiViewCamera?: boolean })
    .isMultiViewCamera
    ? N.builtin("gl_ViewID_OVR")
    : N.cameraIndex;
  const offset = index.mul(4);
  const positionScale = viewData.element(offset.add(1));
  const viewportClip = viewData.element(offset.add(2));
  return {
    renderSize: viewportClip.xy,
    viewportOrigin: viewData.element(offset.add(3)).xy,
    renderToViewQuat: viewData.element(offset),
    renderToViewPos: positionScale.xyz,
    renderToViewScale: positionScale.w,
    near: viewportClip.z,
    far: viewportClip.w,
  };
}
