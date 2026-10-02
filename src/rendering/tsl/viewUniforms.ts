import * as THREE from "three";
import type { Node } from "three/webgpu";
import { getViews } from "../rendererUtils";
import type { Uniforms } from "../uniforms";
import type { ProjectionView } from "./ProjectionProgram";
import { N, uniformBinding } from "./shaderUtils";

/** Eye of the current WebXR draw; multiview draws both eyes at once. */
export function viewIndex(camera: THREE.Camera): Node<"uint"> {
  if (getViews(camera)[0] === camera) return N.uint(0);
  return (camera as { isMultiViewCamera?: boolean }).isMultiViewCamera
    ? N.builtin("gl_ViewID_OVR")
    : N.cameraIndex;
}

/** Viewport data for drawing splats that have already been projected. */
export function splatViewportUniforms(
  uniforms: Uniforms,
  camera: THREE.Camera,
) {
  const eyes = getViews(camera);
  if (eyes[0] === camera) {
    return {
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      viewportOrigin: uniformBinding(uniforms, "viewportOrigin", "vec2"),
    };
  }

  // WebXR eye viewports are physical pixels; Three draws them as given.
  const views = eyes.map(() => new THREE.Vector4());
  const viewData = N.uniformArray<"vec4">(views, "vec4").onObjectUpdate(
    ({ camera }) => {
      getViews(camera as THREE.Camera).forEach((eye, i) => {
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

export function splatViewUniforms(
  uniforms: Uniforms,
  camera: THREE.Camera,
): Omit<ProjectionView, "projectionMatrix"> & { viewportOrigin: Node<"vec2"> } {
  const eyes = getViews(camera);
  if (eyes[0] === camera) {
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

  // WebXR draws do not call onBeforeRender separately for each eye.
  // Pack rotation, position/scale, viewport/clipping and pixel origin per eye.
  const views = eyes.flatMap(() => [
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
  ]);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const viewData = N.uniformArray<"vec4">(views, "vec4").onObjectUpdate(
    ({ camera }) => {
      (getViews(camera as THREE.Camera) as THREE.PerspectiveCamera[]).forEach(
        (eye, i) => {
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
          views[i * 4 + 3].set(
            eye.viewport?.x ?? 0,
            eye.viewport?.y ?? 0,
            0,
            0,
          );
        },
      );
    },
  );
  const index = viewIndex(camera);
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
