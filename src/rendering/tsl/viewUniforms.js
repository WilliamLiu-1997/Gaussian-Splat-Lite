import * as THREE from "three";
import { getViews } from "../rendererUtils.js";
import { N, uniformBinding } from "./shaderUtils.js";
/** Eye of the current WebXR draw; multiview draws both eyes at once. */
export function viewIndex(camera) {
  if (getViews(camera)[0] === camera) return N.uint(0);
  return camera.isMultiViewCamera ? N.builtin("gl_ViewID_OVR") : N.cameraIndex;
}
/** A per-layout projection array also supports changing WebXR eye counts. */
export function splatProjectionMatrix(camera) {
  const eyes = getViews(camera);
  if (eyes[0] === camera) return N.cameraProjectionMatrix;
  const matrices = eyes.map((eye) => eye.projectionMatrix);
  return N.uniformArray(matrices, "mat4")
    .onObjectUpdate(({ camera }) => {
      getViews(camera).forEach((eye, i) => {
        matrices[i] = eye.projectionMatrix;
      });
    })
    .element(viewIndex(camera));
}
/** Viewport data for drawing splats that have already been projected. */
export function splatViewportUniforms(uniforms, camera) {
  const eyes = getViews(camera);
  if (eyes[0] === camera) {
    return {
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      viewportOrigin: uniformBinding(uniforms, "viewportOrigin", "vec2"),
    };
  }
  // WebXR eye viewports are physical pixels; Three draws them as given.
  const views = eyes.map(() => new THREE.Vector4());
  const viewData = N.uniformArray(views, "vec4").onObjectUpdate(
    ({ camera }) => {
      getViews(camera).forEach((eye, i) => {
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
  const index = viewIndex(camera);
  const viewport = viewData.element(index);
  return { renderSize: viewport.xy, viewportOrigin: viewport.zw };
}
export function splatViewUniforms(uniforms, camera) {
  const eyes = getViews(camera);
  if (eyes[0] === camera) {
    return {
      projectionMatrix: splatProjectionMatrix(camera),
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      viewportOrigin: uniformBinding(uniforms, "viewportOrigin", "vec2"),
      renderToViewQuat: uniformBinding(uniforms, "renderToViewQuat", "vec4"),
      renderToViewPos: uniformBinding(uniforms, "renderToViewPos", "vec3"),
      renderToViewScale: uniformBinding(uniforms, "renderToViewScale", "float"),
      near: uniformBinding(uniforms, "near", "float"),
      far: uniformBinding(uniforms, "far", "float"),
    };
  }
  // WebXR draws do not call onBeforeRender separately for each eye.
  // Pack rotation, position/scale, viewport/clipping and pixel origin per eye.
  const views = eyes.flatMap(() => [
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
  ]);
  const matrix = new THREE.Matrix4();
  const translation = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const viewData = N.uniformArray(views, "vec4").onObjectUpdate(
    ({ camera }) => {
      translation.makeTranslation(uniforms.renderOrigin.value);
      getViews(camera).forEach((eye, i) => {
        // Subtract the world origin in CPU double precision before GPU upload.
        // Camera.matrixWorldInverse strips the XR rig's scale in Three.js.
        matrix.copy(eye.matrixWorld).invert().multiply(translation);
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
  const index = viewIndex(camera);
  const offset = index.mul(4);
  const positionScale = viewData.element(offset.add(1));
  const viewportClip = viewData.element(offset.add(2));
  return {
    projectionMatrix: splatProjectionMatrix(camera),
    renderSize: viewportClip.xy,
    viewportOrigin: viewData.element(offset.add(3)).xy,
    renderToViewQuat: viewData.element(offset),
    renderToViewPos: positionScale.xyz,
    renderToViewScale: positionScale.w,
    near: viewportClip.z,
    far: viewportClip.w,
  };
}
