import {
  EventDispatcher,
  MathUtils,
  Matrix4,
  Mesh,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  Raycaster,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";
import {
  Fn,
  cameraProjectionMatrix,
  modelViewMatrix,
  positionGeometry,
  smoothstep,
  uniform,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { NodeMaterial } from "three/webgpu";

const CAMERA_CENTER_MODE_DISTANCE_SQ = 3000000 ** 2;

const _scaledOrigin = new Vector3();
const _scaledDirection = new Vector3();
const _scaledPoint = new Vector3();
const _scaledRay = new Ray();
const _zero = new Vector3();

/**
 * Axis-aligned ellipsoid centered at the origin.
 */
class Ellipsoid {
  constructor(x = 1, y = 1, z = 1) {
    this.radius = new Vector3(x, y, z);
  }

  intersectRay(ray, target) {
    const { x, y, z } = this.radius;
    if (x <= 0 || y <= 0 || z <= 0) {
      return null;
    }

    _scaledOrigin.set(ray.origin.x / x, ray.origin.y / y, ray.origin.z / z);
    _scaledDirection.set(
      ray.direction.x / x,
      ray.direction.y / y,
      ray.direction.z / z,
    );

    // Intersect the ray with a unit sphere in ellipsoid-scaled space. Keep
    // the original ray parameter so the resulting point is in world space.
    const a = _scaledDirection.lengthSq();
    if (a === 0) {
      return null;
    }
    const halfB = _scaledOrigin.dot(_scaledDirection);
    const c = _scaledOrigin.lengthSq() - 1;
    const discriminant = halfB * halfB - a * c;
    if (discriminant < 0) {
      return null;
    }

    const sqrtDiscriminant = Math.sqrt(discriminant);
    const near = (-halfB - sqrtDiscriminant) / a;
    const far = (-halfB + sqrtDiscriminant) / a;
    const distance = near >= 0 ? near : far >= 0 ? far : null;
    return distance === null ? null : ray.at(distance, target);
  }

  getPositionToNormal(position, target) {
    const { x, y, z } = this.radius;
    target.set(
      x > 0 ? position.x / (x * x) : 0,
      y > 0 ? position.y / (y * y) : 0,
      z > 0 ? position.z / (z * z) : 0,
    );
    return target.normalize();
  }

  closestPointToRayEstimate(ray, target) {
    const intersection = this.intersectRay(ray, target);
    if (intersection) {
      return intersection;
    }

    const { x, y, z } = this.radius;
    if (x <= 0 || y <= 0 || z <= 0) {
      return target.set(0, 0, 0);
    }

    _scaledRay.origin.set(ray.origin.x / x, ray.origin.y / y, ray.origin.z / z);
    _scaledRay.direction
      .set(ray.direction.x / x, ray.direction.y / y, ray.direction.z / z)
      .normalize();
    _scaledRay.closestPointToPoint(_zero, _scaledPoint);

    // A ray through the center has no unique radial estimate. Choose the
    // surface point facing its origin, or the point opposite its direction
    // when the ray also starts at the center.
    if (_scaledPoint.lengthSq() === 0) {
      _scaledPoint.copy(_scaledRay.origin);
      if (_scaledPoint.lengthSq() === 0) {
        _scaledPoint.copy(_scaledRay.direction).negate();
      }
    }

    _scaledPoint.normalize();
    return target.set(
      _scaledPoint.x * x,
      _scaledPoint.y * y,
      _scaledPoint.z * z,
    );
  }
}

class PointerTracker {
  buttons;
  pointerType;
  pointerOrder;
  previousPositions;
  pointerPositions;
  startPositions;
  hoverPosition;
  hoverSet;
  constructor() {
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.hoverPosition = new Vector2();
    this.hoverSet = false;
  }
  reset() {
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.hoverPosition = new Vector2();
    this.hoverSet = false;
  }
  // The pointers can be set multiple times per frame so track whether the pointer has
  // been set this frame or not so we don't overwrite the previous position and lose information
  // about pointer movement
  updateFrame() {
    const { previousPositions, pointerPositions } = this;
    for (const id in pointerPositions) {
      previousPositions[id].copy(pointerPositions[id]);
    }
  }
  setHoverEvent(e) {
    if (e.pointerType === "mouse" || e.type === "wheel") {
      this.getClientPointer(e, this.hoverPosition);
      this.hoverSet = true;
    }
  }
  getLatestPoint(target) {
    if (this.pointerType !== null) {
      this.getCenterPoint(target);
      return target;
    }
    if (this.hoverSet) {
      target.copy(this.hoverPosition);
      return target;
    }
    return null;
  }
  // Keep pointer positions in viewport coordinates. mouseToCoords converts
  // them to element-local NDC exactly once when a ray is needed.
  getClientPointer(e, target) {
    target.set(e.clientX, e.clientY);
  }
  addPointer(e) {
    const id = e.pointerId;
    const position = new Vector2();
    this.getClientPointer(e, position);
    if (this.pointerOrder.indexOf(id) === -1) {
      this.pointerOrder.push(id);
    }
    this.pointerPositions[id] = position;
    this.previousPositions[id] = position.clone();
    this.startPositions[id] = position.clone();
    if (this.getPointerCount() === 1) {
      this.pointerType = e.pointerType;
      this.buttons = e.buttons;
    }
  }
  updatePointer(e) {
    const id = e.pointerId;
    if (!(id in this.pointerPositions)) {
      return false;
    }
    this.getClientPointer(e, this.pointerPositions[id]);
    return true;
  }
  deletePointer(e) {
    const id = e.pointerId;
    const pointerOrder = this.pointerOrder;
    const pointerIndex = pointerOrder.indexOf(id);
    if (pointerIndex === -1) {
      return false;
    }
    pointerOrder.splice(pointerIndex, 1);
    delete this.pointerPositions[id];
    delete this.previousPositions[id];
    delete this.startPositions[id];
    if (this.getPointerCount() === 0) {
      this.buttons = 0;
      this.pointerType = null;
    }
    return true;
  }
  getPointerCount() {
    return this.pointerOrder.length;
  }
  getCenterPoint(target, pointerPositions = this.pointerPositions) {
    const pointerOrder = this.pointerOrder;
    if (this.getPointerCount() === 1 || this.getPointerType() === "mouse") {
      const id = pointerOrder[0];
      target.copy(pointerPositions[id]);
      return target;
    }
    if (this.getPointerCount() === 2) {
      const id0 = this.pointerOrder[0];
      const id1 = this.pointerOrder[1];
      const p0 = pointerPositions[id0];
      const p1 = pointerPositions[id1];
      target.addVectors(p0, p1).multiplyScalar(0.5);
      return target;
    }
    if (this.getPointerCount() > 2) {
      target.set(0, 0);
      for (let i = 0; i < pointerOrder.length; i++) {
        const id = pointerOrder[i];
        target.add(pointerPositions[id]);
      }
      target.divideScalar(pointerOrder.length);
      return target;
    }
    return null;
  }
  getPreviousCenterPoint(target) {
    return this.getCenterPoint(target, this.previousPositions);
  }
  getStartCenterPoint(target) {
    return this.getCenterPoint(target, this.startPositions);
  }
  getMoveDistance() {
    this.getCenterPoint(_vec);
    this.getPreviousCenterPoint(_vec2);
    return _vec.sub(_vec2).length();
  }
  getTouchPointerDistance(pointerPositions = this.pointerPositions) {
    if (this.getPointerCount() <= 1 || this.getPointerType() === "mouse") {
      return 0;
    }
    const { pointerOrder } = this;
    const id0 = pointerOrder[0];
    const id1 = pointerOrder[1];
    const p0 = pointerPositions[id0];
    const p1 = pointerPositions[id1];
    return p0.distanceTo(p1);
  }
  getPreviousTouchPointerDistance() {
    return this.getTouchPointerDistance(this.previousPositions);
  }
  getStartTouchPointerDistance() {
    return this.getTouchPointerDistance(this.startPositions);
  }
  getPointerType() {
    return this.pointerType;
  }
  isPointerTouch() {
    return this.getPointerType() === "touch";
  }
  getPointerButtons() {
    return this.buttons;
  }
  isLeftClicked() {
    return Boolean(this.buttons & 1);
  }
  isRightClicked() {
    return Boolean(this.buttons & 2);
  }
  isMiddleClicked() {
    return Boolean(this.buttons & 4);
  }
}

class PivotPointMesh extends Mesh {
  constructor(renderer, size = 15, thickness = 3, reversedDepth = false) {
    const material = renderer.isWebGPURenderer
      ? new PivotNodeMaterial(size, thickness)
      : new PivotMaterial(size, thickness);
    super(new PlaneGeometry(0, 0), material);
    // Three.js reverses the transparent render list when reversed depth is
    // active, including explicit renderOrder values. Keep the pivot last in
    // either depth mode so Gaussian splats cannot draw over it.
    this.renderOrder = reversedDepth
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }

  set focus(value) {
    this.material.uniforms.opacity.value = value ? 1 : 0.5;
  }

  onBeforeRender(renderer) {
    renderer.getSize(this.material.uniforms.resolution.value);
  }

  updateMatrixWorld() {
    this.matrixWorld.makeTranslation(this.position);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function makePivotUniforms(size, thickness) {
  const coreD = size + thickness;
  const planeD = coreD + 3 * thickness;
  const normThk = thickness / coreD;
  const ringR = (coreD - 0.4 * thickness - 4.0) / coreD;
  const hw = 0.4 * normThk;
  return {
    resolution: { value: new Vector2() },
    opacity: { value: 1 },
    planeD: { value: planeD },
    hw: { value: hw },
    ringR: { value: ringR },
    shadowW: { value: hw * 5.0 },
    uvScale: { value: planeD / coreD },
  };
}

class PivotMaterial extends ShaderMaterial {
  constructor(size, thickness) {
    const uniforms = makePivotUniforms(size, thickness);

    super({
      depthWrite: false,
      depthTest: false,
      transparent: true,

      uniforms,

      vertexShader: `
        uniform float planeD;
        uniform vec2 resolution;
        varying vec2 vUv;

        void main() {
          vUv = uv;
          float aspect = resolution.x / resolution.y;
          vec2 offset = uv * 2.0 - vec2(1.0);
          offset.y *= aspect;
          vec4 screenPoint = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          screenPoint.xy += offset * planeD * screenPoint.w / resolution.x;
          gl_Position = screenPoint;
        }
      `,
      fragmentShader: `
        uniform float hw;
        uniform float ringR;
        uniform float shadowW;
        uniform float opacity;
        uniform float uvScale;
        varying vec2 vUv;

        void main() {
          vec2 uv = (vUv * 2.0 - 1.0) * uvScale;
          float len = length(uv);
          float fw = fwidth(len) * 0.5;
          float d = abs(len - ringR);

          float ring = 1.0 - smoothstep(hw - fw, hw + fw, d);

          float shadow = (1.0 - smoothstep(hw, shadowW, d)) * (1.0 - smoothstep(ringR - fw, ringR + fw, len)) * 0.5;

          float white = ring;
          float black = shadow * (1.0 - white);
          float alpha = (white + black) * opacity;
          if (alpha < 0.001) discard;
          vec4 rgba = vec4(vec3(white / max(alpha / opacity, 0.001)), alpha);
          gl_FragColor = rgba;
        }
      `,
    });
  }
}

class PivotNodeMaterial extends NodeMaterial {
  constructor(size, thickness) {
    super();
    const uniforms = makePivotUniforms(size, thickness);
    const bindings = Object.fromEntries(
      Object.entries(uniforms).map(([name, entry]) => [
        name,
        uniform(entry.value).onObjectUpdate(() => entry.value),
      ]),
    );

    this.depthWrite = false;
    this.depthTest = false;
    this.transparent = true;
    this.uniforms = uniforms;

    this.vertexNode = Fn(() => {
      const pivotUv = varyingProperty("vec2", "pivotUv");
      pivotUv.assign(uv());
      const aspect = bindings.resolution.x.div(bindings.resolution.y);
      const offset = uv().mul(2).sub(vec2(1)).toVar();
      offset.y.mulAssign(aspect);
      const screenPoint = cameraProjectionMatrix
        .mul(modelViewMatrix)
        .mul(vec4(positionGeometry, 1))
        .toVar();
      screenPoint.xy.addAssign(
        offset
          .mul(bindings.planeD)
          .mul(screenPoint.w)
          .div(bindings.resolution.x),
      );
      return screenPoint;
    })();

    this.colorNode = Fn(() => {
      const pivotUv = varyingProperty("vec2", "pivotUv");
      const localUv = pivotUv.mul(2).sub(1).mul(bindings.uvScale);
      const length = localUv.length();
      const fw = length.fwidth().mul(0.5);
      const distance = length.sub(bindings.ringR).abs();
      const ring = smoothstep(
        bindings.hw.sub(fw),
        bindings.hw.add(fw),
        distance,
      ).oneMinus();
      const shadow = smoothstep(bindings.hw, bindings.shadowW, distance)
        .oneMinus()
        .mul(
          smoothstep(
            bindings.ringR.sub(fw),
            bindings.ringR.add(fw),
            length,
          ).oneMinus(),
        )
        .mul(0.5);
      const white = ring;
      const black = shadow.mul(white.oneMinus());
      const alpha = white.add(black).mul(bindings.opacity);
      alpha.lessThan(0.001).discard();
      const color = vec3(white.div(alpha.div(bindings.opacity).max(0.001)));
      return vec4(color, alpha);
    })();
  }
}

const _matrix = new Matrix4();
// custom version of set raycaster from camera that relies on the underlying matrices
// so the ray origin is position at the camera near clip.
function setRaycasterFromCamera(raycaster, coords, camera) {
  const ray = raycaster instanceof Ray ? raycaster : raycaster.ray;
  const { origin, direction } = ray;
  // With reversed depth the NDC z range is [1, 0] (near→1, far→0)
  // instead of the standard [-1, 1] (near→-1, far→1).
  const nearZ = camera.reversedDepth ? 1 : -1;
  const farZ = camera.reversedDepth ? 0 : 1;
  // get the origin and direction of the frustum ray
  origin.set(coords.x, coords.y, nearZ).unproject(camera);
  direction.set(coords.x, coords.y, farZ).unproject(camera).sub(origin);
  if (!raycaster.isRay) {
    // compute the far value based on the distance from point on the near
    // plane and point on the far plane. Then normalize the direction.
    raycaster.near = 0;
    raycaster.far = direction.length();
    raycaster.camera = camera;
  }
  // normalize the ray direction
  direction.normalize();
}
function mouseToCoords(clientX, clientY, element, target) {
  const rect = element.getBoundingClientRect();
  target.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  target.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}
function makeRotateAroundPoint(point, quat, target) {
  target.makeTranslation(-point.x, -point.y, -point.z);
  _matrix.makeRotationFromQuaternion(quat);
  target.premultiply(_matrix);
  _matrix.makeTranslation(point.x, point.y, point.z);
  target.premultiply(_matrix);
  return target;
}
export const NONE = 0;
export const DRAG = 1;
export const ROTATE = 2;
export const IDLE = 3;
const START_EVENT = { type: "start" };
const UPDATE_EVENT = { type: "update" };
const FINISH_EVENT = { type: "finish" };
const THRESHOLD = 1e-3;
const INPUT_DAMPING_EPSILON = 1e-3;
const ROTATION_DAMPING_EPSILON = 1e-4;
const ZOOM_DAMPING_EPSILON = 1e-1;
const MAX_DISTANCE_EPSILON_RATIO = 1e-9;
const MAX = 1e8;
const PIVOT_SIZE = 22;
const PIVOT_THICKNESS = 2.5;
const PIVOT_MIN_VISIBLE_DURATION = 250;
const VIRTUAL_HIT_DISTANCE = 50;
const ANCHORED_KEEP_UP_ITERATIONS = 4;
const ROTATION_OFFSETS = [-2 * Math.PI, 0, 2 * Math.PI];
const _pointer = new Vector2();
const _pointer1 = new Vector2();
const _pointer2 = new Vector2();
const _pivotPoint = new Vector3();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _forward = new Vector3(0, 0, -1);
const _worldZ = new Vector3(0, 0, 1);
const _vec = new Vector3(1, 1, 1);
const _vec1 = new Vector3();
const _vec2 = new Vector3();
const _vec3 = new Vector3();
const _vec4 = new Vector3();
const _vec6 = new Vector3();
const _axis = new Vector3();
const _localUp = new Vector3();
const _positionUp = new Vector3();
const _localRight = new Vector3();
const _anchorLocal = new Vector3();
const _anchorOffset = new Vector3();
const _rotMatrix = new Matrix4();
const _quaternion = new Quaternion();
const _plane = new Plane();
const _ray = new Ray();
const _dragEllipsoid = new Ellipsoid(1, 1, 1);
class CameraController extends EventDispatcher {
  damping;
  state;
  zooming;
  touchZooming;
  minDistance;
  minZoomLimit;
  #pointerTracker;
  #domElement;
  #camera;
  #scene;
  #pivotMesh;
  #pivotShownAt;
  #pivotHideTimeout;
  #raycaster;
  // Remaining input is consumed over subsequent updates; these are not
  // velocities and must never be reapplied without subtracting the amount.
  #zoomDelta;
  #zoomInertia;
  #lastScrollPointer;
  #rotateInertia;
  #dragInertia;
  #dragInertiaIsRotation;
  #dragAnchorPoint;
  #dragAnchorPointerOffset;
  #dragPlaneNormal;
  #enabled;
  #worldUp;
  #ellipsoid;
  #ellipsoidMaxRadius;
  #lastTime;
  #hit;
  #cameraMoving;
  #pointerDownFilter;
  #raycastHitFilter;
  constructor(renderer, scene, camera, options = {}) {
    super();
    const normalizedOptions =
      typeof options === "object" && options !== null ? options : {};
    this.#scene = scene;
    this.#camera = camera;
    this.#domElement = normalizedOptions.domElement ?? renderer.domElement;
    this.damping = normalizedOptions.damping ?? 0.15;
    this.minDistance = 0.5;
    this.minZoomLimit = false;
    this.state = NONE;
    this.zooming = false;
    this.touchZooming = false;
    this.#pointerTracker = new PointerTracker();
    this.#raycaster = new Raycaster();
    this.#raycaster.params.Points.threshold = 0.1;
    this.#pivotMesh = new PivotPointMesh(
      renderer,
      PIVOT_SIZE,
      PIVOT_THICKNESS,
      renderer.capabilities?.reversedDepthBuffer ??
        renderer.reversedDepthBuffer ??
        false,
    );
    this.#pivotMesh.visible = false;
    this.#pivotShownAt = 0;
    this.#pivotHideTimeout = null;
    this.#zoomDelta = 0;
    this.#zoomInertia = 0;
    this.#lastScrollPointer = new Vector2();
    this.#rotateInertia = new Vector2();
    this.#dragInertia = new Vector3();
    this.#dragInertiaIsRotation = false;
    this.#dragAnchorPoint = new Vector3();
    this.#dragAnchorPointerOffset = new Vector2();
    this.#dragPlaneNormal = new Vector3();
    this.#enabled = false;
    this.#worldUp = normalizedOptions.worldUp
      ? new Vector3().copy(normalizedOptions.worldUp).normalize()
      : null;
    this.#ellipsoid = null;
    this.#ellipsoidMaxRadius = 0;
    this.#lastTime = 0;
    this.#hit = null;
    this.#cameraMoving = false;
    this.#pointerDownFilter =
      typeof normalizedOptions.pointerDownFilter === "function"
        ? normalizedOptions.pointerDownFilter
        : null;
    this.#raycastHitFilter =
      typeof normalizedOptions.raycastHitFilter === "function"
        ? normalizedOptions.raycastHitFilter
        : null;
    this.init();
  }
  get enabled() {
    return this.#enabled;
  }
  set enabled(v) {
    if (v === this.enabled) {
      return;
    }
    this.#enabled = v;
    this.#resetControlState(true);
  }
  get camera() {
    return this.#camera;
  }
  get indicator() {
    return this.#pivotMesh;
  }
  #clearPivotHideTimeout() {
    if (this.#pivotHideTimeout !== null) {
      clearTimeout(this.#pivotHideTimeout);
      this.#pivotHideTimeout = null;
    }
  }
  #showPivot(restartMinimumDuration = false) {
    this.#clearPivotHideTimeout();
    if (!this.#pivotMesh.visible || restartMinimumDuration) {
      this.#pivotShownAt = performance.now();
      this.#pivotMesh.visible = true;
    }
  }
  #hidePivot(immediate = false) {
    this.#clearPivotHideTimeout();
    if (!this.#pivotMesh.visible) {
      return;
    }
    const remaining =
      PIVOT_MIN_VISIBLE_DURATION - (performance.now() - this.#pivotShownAt);
    if (immediate || remaining <= 0) {
      this.#pivotMesh.visible = false;
      this.#pivotShownAt = 0;
      return;
    }
    this.#pivotHideTimeout = setTimeout(() => {
      this.#pivotHideTimeout = null;
      this.#pivotMesh.visible = false;
      this.#pivotShownAt = 0;
      this.dispatchEvent(UPDATE_EVENT);
    }, remaining);
  }
  #setState(state = this.state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    if (state !== NONE) {
      this.#showPivot();
    }
  }
  #setZooming(zooming, touchZooming = false) {
    if (!this.zooming && this.state === NONE && zooming) {
      this.#showPivot();
    }
    this.zooming = zooming;
    this.touchZooming = touchZooming;
  }
  #resetState() {
    this.state = NONE;
    this.zooming = false;
    this.touchZooming = false;
    this.#clearTransformInertia();
    this.#dragAnchorPoint.set(0, 0, 0);
    this.#dragAnchorPointerOffset.set(0, 0);
    this.#dragPlaneNormal.set(0, 0, 0);
    this.#clearZoomInertia();
    this.#lastScrollPointer.set(0, 0);
    this.#hit = null;
    this.#hidePivot();
  }
  #clearTransformInertia() {
    this.#rotateInertia.set(0, 0);
    this.#dragInertia.set(0, 0, 0);
    this.#dragInertiaIsRotation = false;
  }
  #clearZoomInertia() {
    this.#zoomDelta = 0;
    this.#zoomInertia = 0;
  }
  #hasTransformInertia() {
    return (
      this.#rotateInertia.lengthSq() !== 0 || this.#dragInertia.lengthSq() !== 0
    );
  }
  #hasZoomInertia() {
    return this.#zoomDelta !== 0 || this.#zoomInertia !== 0;
  }
  #queueZoomDelta(delta) {
    if (delta === 0) {
      return false;
    }
    const pending = this.#zoomInertia + this.#zoomDelta;
    let nextPending = pending + delta;
    if (this.#reachCameraMinDistance() && nextPending > 0) {
      nextPending = 0;
    }
    if (this.#reachCameraMaxDistance() && nextPending < 0) {
      nextPending = 0;
    }
    const queuedDelta = nextPending - pending;
    this.#zoomDelta += queuedDelta;
    if (queuedDelta !== 0 && this.#hit !== null && this.#hit.distance > 0) {
      this.#showPivot(true);
    }
    return queuedDelta !== 0;
  }
  #getDamping() {
    // Keep this frame based: using a stalled frame's deltaTime would recreate
    // the large first-frame camera jump this pending-input model avoids.
    const damping = MathUtils.clamp(this.damping, 0.05, 0.5);
    return Number.isFinite(damping) ? damping : 0.15;
  }
  #startCameraMovement() {
    if (this.#cameraMoving) {
      return;
    }
    this.#cameraMoving = true;
    this.dispatchEvent(START_EVENT);
  }
  #hasOngoingCameraMovement() {
    if (this.zooming || this.#hasTransformInertia() || this.#hasZoomInertia()) {
      return true;
    }
    return this.state !== NONE;
  }
  #finishCameraMovementIfIdle() {
    if (!this.#cameraMoving || this.#hasOngoingCameraMovement()) {
      return;
    }
    this.#cameraMoving = false;
    this.dispatchEvent(FINISH_EVENT);
  }
  #resetControlState(resetPointerTracker) {
    if (resetPointerTracker) {
      this.#pointerTracker.reset();
    }
    this.#resetStateAndNotify();
  }
  #resetStateAndNotify(notify = true) {
    this.#resetState();
    if (notify) {
      this.dispatchEvent(UPDATE_EVENT);
    }
    this.#finishCameraMovementIfIdle();
  }
  setCamera(camera) {
    this.#camera = camera;
    this.#resetControlState(false);
  }
  setEllipsoid(ellipsoid) {
    this.#ellipsoid = ellipsoid;
    const r = ellipsoid.radius;
    this.#ellipsoidMaxRadius = Math.max(r.x, r.y, r.z);
  }
  setPointerDownFilter(filter) {
    this.#pointerDownFilter = typeof filter === "function" ? filter : null;
    this.#resetControlState(true);
  }
  setRaycastHitFilter(filter) {
    this.#raycastHitFilter = typeof filter === "function" ? filter : null;
    this.#resetControlState(false);
  }
  init() {
    this.#domElement.style.touchAction = "none";
    this.#pivotMesh.raycast = () => {};
    this.#scene.add(this.#pivotMesh);
    this.#bindEvents();
    this.#enabled = true;
  }
  getPivotPoint(target, fast = false) {
    setRaycasterFromCamera(this.#raycaster, _pointer.set(0, 0), this.#camera);
    let targetDistanceSq = Number.POSITIVE_INFINITY;
    if (fast && this.#hit && this.#hit.distance > 0) {
      target.copy(this.#hit.point);
      targetDistanceSq = target.distanceToSquared(this.#camera.position);
    }
    const sceneHit = this.#normalRaycastClosest(this.#raycaster, this.#scene);
    if (sceneHit) {
      const sceneDistanceSq = sceneHit.point.distanceToSquared(
        this.#camera.position,
      );
      if (!fast || sceneDistanceSq < targetDistanceSq) {
        target.copy(sceneHit.point);
      }
    } else if (!fast) {
      if (this.#ellipsoid) {
        this.#ellipsoid.closestPointToRayEstimate(this.#raycaster.ray, target);
      } else {
        target.set(0, 0, 0);
      }
    }
  }
  update(time = performance.now()) {
    if (!this.#enabled || !this.#camera || time === this.#lastTime) {
      return;
    }
    this.#lastTime = time;
    if (
      this.state === NONE &&
      !this.zooming &&
      !this.#hasTransformInertia() &&
      !this.#hasZoomInertia()
    ) {
      return;
    }
    switch (this.state) {
      case ROTATE:
        this.#updateRotation();
        break;
      case DRAG:
        this.#updateDrag();
        break;
      case IDLE:
        this.#updateIdle();
        break;
    }
    if (this.zooming || this.#hasZoomInertia()) {
      this.#updateZoom();
    }
    this.#pointerTracker.updateFrame();
    this.#finishCameraMovementIfIdle();
  }
  #captureRotationInput() {
    if (
      !this.#pointerTracker.getCenterPoint(_pointer1) ||
      !this.#pointerTracker.getPreviousCenterPoint(_pointer2) ||
      _pointer1.equals(_pointer2)
    ) {
      return false;
    }
    _pointer
      .subVectors(_pointer2, _pointer1)
      .multiplyScalar(this.#getRotateScale());
    this.#rotateInertia.add(_pointer);
    return true;
  }
  #consumeRotationInertia() {
    if (this.#rotateInertia.lengthSq() === 0) {
      return false;
    }
    const damping = this.#getDamping();
    _pointer.copy(this.#rotateInertia).multiplyScalar(damping);
    this.#rotateInertia.sub(_pointer);
    if (
      _pointer.lengthSq() <=
      ROTATION_DAMPING_EPSILON * ROTATION_DAMPING_EPSILON
    ) {
      this.#rotateInertia.set(0, 0);
    }
    const requestedVerticalRotation = _pointer.y;
    const appliedVerticalRotation = this.#rotate(_pointer);
    if (Number.isNaN(appliedVerticalRotation)) {
      this.#rotateInertia.set(0, 0);
    } else if (
      Math.abs(appliedVerticalRotation - requestedVerticalRotation) >
      ROTATION_DAMPING_EPSILON
    ) {
      // Do not retain input that a polar constraint rejected. Otherwise the
      // user must cancel an invisible pending amount before rotating back.
      this.#rotateInertia.y = 0;
    }
    this.#finalizeCamera();
    this.dispatchEvent(UPDATE_EVENT);
    return true;
  }
  #updateRotation() {
    this.#captureRotationInput();
    this.#consumeRotationInertia();
  }
  #captureDragInput() {
    if (
      !this.#hit ||
      this.#hit.distance <= 0 ||
      !this.#pointerTracker.getCenterPoint(_pointer1)
    ) {
      return false;
    }
    if (!this.#pointerTracker.getPreviousCenterPoint(_pointer2)) {
      return false;
    }
    if (_pointer1.equals(_pointer2)) {
      // Keep the active drag valid without recreating a tiny residual from
      // ray/plane floating-point error. Existing inertia is still consumed.
      return true;
    }
    mouseToCoords(_pointer1.x, _pointer1.y, this.#domElement, _pointer1);
    _pointer1.add(this.#dragAnchorPointerOffset);
    if (this.#shouldDragModified()) {
      return this.#modifiedDrag(_pointer1);
    }
    if (!this.#intersectDragPlane(_pointer1, _vec1)) {
      return false;
    }
    this.#dragInertia.subVectors(_vec1, this.#dragAnchorPoint);
    this.#dragInertiaIsRotation = false;
    return true;
  }
  #consumeDragInertia() {
    if (this.#dragInertia.lengthSq() === 0) {
      return false;
    }
    const damping = this.#getDamping();
    _vec.copy(this.#dragInertia).multiplyScalar(damping);
    this.#dragInertia.sub(_vec);
    const dampingEpsilon = this.#dragInertiaIsRotation
      ? ROTATION_DAMPING_EPSILON
      : INPUT_DAMPING_EPSILON;
    if (_vec.lengthSq() <= dampingEpsilon * dampingEpsilon) {
      this.#dragInertia.set(0, 0, 0);
    }
    if (this.#dragInertiaIsRotation) {
      const angle = _vec.length();
      if (angle > 0) {
        _axis.copy(_vec).multiplyScalar(1 / angle);
        _quaternion.setFromAxisAngle(_axis, angle);
        this.#applyCameraRotationAroundOrigin(_quaternion);
      }
    } else {
      this.#camera.position.sub(_vec);
    }
    this.#finalizeDragCamera();
    if (!this.#dragInertiaIsRotation && this.#shouldDragModified()) {
      this.#initializeDragAnchor();
    }
    this.dispatchEvent(UPDATE_EVENT);
    return true;
  }
  #updateDrag() {
    const shouldDragModified = this.#shouldDragModified();
    if (!this.#captureDragInput() && shouldDragModified) {
      this.#setState(IDLE);
      this.dispatchEvent(UPDATE_EVENT);
      return;
    }
    this.#consumeDragInertia();
  }
  #updateIdle() {
    let cameraUpdated = this.#consumeRotationInertia();
    if (this.#rotateInertia.lengthSq() === 0) {
      cameraUpdated = this.#consumeDragInertia() || cameraUpdated;
    }
    if (!this.#hasTransformInertia()) {
      this.#clearTransformInertia();
      if (!this.zooming && !this.#hasZoomInertia()) {
        this.#resetStateAndNotify(!cameraUpdated);
      } else {
        this.#setState(NONE);
        if (!cameraUpdated) {
          this.dispatchEvent(UPDATE_EVENT);
        }
      }
    }
  }
  #captureTouchZoomInput() {
    if (this.#pointerTracker.getPointerCount() <= 1) {
      return false;
    }
    const diagonal = Math.sqrt(
      this.#domElement.clientWidth ** 2 + this.#domElement.clientHeight ** 2,
    );
    if (diagonal === 0) {
      return false;
    }
    const previousDistance =
      this.#pointerTracker.getPreviousTouchPointerDistance();
    const currentDistance = this.#pointerTracker.getTouchPointerDistance();
    const delta = ((currentDistance - previousDistance) / diagonal) * 4000;
    return this.#queueZoomDelta(delta);
  }
  #updateZoom() {
    if (this.touchZooming) {
      this.#captureTouchZoomInput();
    }
    if (this.#zoomDelta !== 0) {
      this.#zoomInertia += this.#zoomDelta;
      this.#zoomDelta = 0;
    }
    let cameraUpdated = false;
    if (this.#zoomInertia !== 0) {
      if (
        !this.#hit ||
        this.#hit.distance <= 0 ||
        (this.#zoomInertia >= 0 && this.#reachCameraMinDistance()) ||
        (this.#zoomInertia <= 0 && this.#reachCameraMaxDistance())
      ) {
        this.#zoomInertia = 0;
      } else {
        const zoomAmount = this.#zoomInertia * this.#getDamping();
        this.#zoomInertia -= zoomAmount;
        if (Math.abs(zoomAmount) <= ZOOM_DAMPING_EPSILON) {
          this.#zoomInertia = 0;
        }
        this.#applyZoom(zoomAmount);
        if (
          (zoomAmount > 0 && this.#reachCameraMinDistance()) ||
          (zoomAmount < 0 && this.#reachCameraMaxDistance())
        ) {
          this.#zoomInertia = 0;
        }
        this.dispatchEvent(UPDATE_EVENT);
        cameraUpdated = true;
      }
    }
    if (
      !this.#hasZoomInertia() &&
      (this.state === NONE || this.state === IDLE)
    ) {
      this.#setZooming(false);
      if (!this.#hasTransformInertia()) {
        this.#resetStateAndNotify(!cameraUpdated);
      }
    }
  }
  dispose() {
    this.#domElement.removeEventListener("contextmenu", this.#contextMenu);
    this.#domElement.removeEventListener("pointerdown", this.#pointerDown);
    this.#domElement.removeEventListener("pointermove", this.#pointerMove);
    this.#domElement.removeEventListener("pointerup", this.#pointerUp);
    this.#domElement.removeEventListener("pointercancel", this.#pointerUp);
    this.#domElement.removeEventListener("wheel", this.#wheel);
    this.#domElement.removeEventListener("pointerenter", this.#pointerEnter);
    this.#hidePivot(true);
    this.#pivotMesh.removeFromParent();
    this.#pivotMesh.dispose();
    this.#domElement.style.touchAction = "";
    this.#enabled = false;
    this.#ellipsoid = null;
  }
  #bindEvents() {
    this.#domElement.addEventListener("contextmenu", this.#contextMenu);
    this.#domElement.addEventListener("pointerdown", this.#pointerDown);
    this.#domElement.addEventListener("pointermove", this.#pointerMove);
    this.#domElement.addEventListener("pointerup", this.#pointerUp);
    this.#domElement.addEventListener("pointercancel", this.#pointerUp);
    this.#domElement.addEventListener("wheel", this.#wheel);
    this.#domElement.addEventListener("pointerenter", this.#pointerEnter);
  }
  #contextMenu = (e) => {
    e.preventDefault();
  };
  #pointerDown = (e) => {
    if (!this.#enabled) {
      return;
    }
    if (this.#pointerDownFilter && !this.#pointerDownFilter(e)) {
      return;
    }
    this.#pointerTracker.addPointer(e);
    const pointerCount = this.#pointerTracker.getPointerCount();
    const pointerTouch = this.#pointerTracker.isPointerTouch();
    const twoFingerTouch = pointerCount === 2 && pointerTouch;
    if (
      twoFingerTouch ||
      (!pointerTouch && this.#pointerTracker.isRightClicked()) ||
      (this.#pointerTracker.isLeftClicked() && e.shiftKey)
    ) {
      this.#setState(DRAG);
    } else if (
      (pointerCount === 1 && pointerTouch) ||
      (!pointerTouch && this.#pointerTracker.isLeftClicked() && !e.shiftKey)
    ) {
      this.#setState(ROTATE);
    }
    if (twoFingerTouch) {
      this.#setZooming(true, true);
    }
    if (this.state === NONE) {
      this.#setState(IDLE);
    }
    if (this.state === ROTATE || this.state === DRAG) {
      this.#domElement.setPointerCapture(e.pointerId);
    }
    if (this.state === ROTATE || this.state === DRAG || this.zooming) {
      this.#pointerTracker.getCenterPoint(_pointer1);
      mouseToCoords(_pointer1.x, _pointer1.y, this.#domElement, _pointer1);
      setRaycasterFromCamera(this.#raycaster, _pointer1, this.#camera);
      this.#hit = this.#raycast(this.#raycaster);
      if (this.#hit.distance > 0) {
        this.#showPivot();
      } else {
        this.#hidePivot();
      }
      this.#pivotMesh.position.copy(this.#hit.point);
      this.#pivotMesh.focus = !this.#hit.onGlobe;
      if (this.state === DRAG && this.#hit.distance > 0) {
        this.#initializeDragAnchor(_pointer1);
      }
      this.#startCameraMovement();
    }
    this.#clearTransformInertia();
    this.dispatchEvent(UPDATE_EVENT);
  };
  #pointerMove = (e) => {
    e.preventDefault();
    if (!this.#enabled) {
      return;
    }
    this.#pointerTracker.setHoverEvent(e);
    this.#pointerTracker.updatePointer(e);
  };
  #pointerUp = (e) => {
    const pointerTracked = this.#pointerTracker.updatePointer(e);
    if (this.#enabled && pointerTracked) {
      // Capture the last pointer position before removing it. A long main-thread
      // stall can deliver pointermove and pointerup before the next update.
      if (this.state === ROTATE) {
        this.#captureRotationInput();
      } else if (this.state === DRAG) {
        this.#captureDragInput();
      }
      if (this.touchZooming) {
        this.#captureTouchZoomInput();
      }
    }
    this.#pointerTracker.deletePointer(e);
    if (this.#domElement.hasPointerCapture(e.pointerId)) {
      this.#domElement.releasePointerCapture(e.pointerId);
    }
    if (!this.#enabled) {
      return;
    }
    if (this.zooming || this.state !== NONE) {
      this.#setState(IDLE);
    }
    this.dispatchEvent(UPDATE_EVENT);
  };
  #wheel = (e) => {
    e.preventDefault();
    if (!this.#enabled) {
      return;
    }
    const tooClose =
      this.#pivotMesh.position.distanceTo(this.#camera.position) <=
      this.#camera.near;
    const releasedTransformTail =
      this.state === IDLE && this.#hasTransformInertia();
    if (releasedTransformTail) {
      // A fresh wheel gesture owns its own raycast anchor. Stop the released
      // rotate / pan tail so it cannot be retargeted to the new zoom hit.
      this.#clearTransformInertia();
      this.#setState(NONE);
    }
    const orbitRotating = this.state === ROTATE;
    const panning = this.state === DRAG;
    if (!this.zooming || tooClose) {
      this.#clearZoomInertia();
    }
    this.#pointerTracker.setHoverEvent(e);
    this.#pointerTracker.updatePointer(e);
    this.#pointerTracker.getLatestPoint(_pointer1);
    const pointerMoved = !this.#lastScrollPointer.equals(_pointer1);
    this.#lastScrollPointer.copy(_pointer1);
    const panAnchorDistance = this.#hit
      ? this.#camera.position.distanceTo(this.#hit.point)
      : 0;
    const panAnchorNeedsRefresh =
      panning &&
      (!this.#hit ||
        this.#hit.distance <= 0 ||
        panAnchorDistance <= this.#camera.near);
    const preservePanAnchor = panning && !panAnchorNeedsRefresh;
    if (
      !orbitRotating &&
      !preservePanAnchor &&
      (releasedTransformTail ||
        panAnchorNeedsRefresh ||
        !this.zooming ||
        this.touchZooming ||
        pointerMoved)
    ) {
      mouseToCoords(_pointer1.x, _pointer1.y, this.#domElement, _pointer1);
      setRaycasterFromCamera(this.#raycaster, _pointer1, this.#camera);
      this.#hit = this.#raycast(this.#raycaster);
      if (this.#hit.distance > 0) {
        this.#showPivot();
        this.#pivotMesh.position.copy(this.#hit.point);
        this.#pivotMesh.focus = !this.#hit.onGlobe;
      } else {
        this.#hidePivot();
      }
    }
    let delta = 0;
    switch (e.deltaMode) {
      case 2: // Pages
        delta = e.deltaY * 800;
        break;
      case 1: // Lines
        delta = e.deltaY * 40;
        break;
      case 0: // Pixels
        delta = e.deltaY;
        break;
    }
    // use LOG to scale the scroll delta and hopefully normalize them across platforms
    const deltaSign = Math.sign(delta);
    const normalizedDelta = Math.max(40, Math.abs(delta));
    this.#queueZoomDelta(-0.8 * deltaSign * normalizedDelta);
    this.#setZooming(true);
    this.#startCameraMovement();
    this.dispatchEvent(UPDATE_EVENT);
  };
  #pointerEnter = (e) => {
    if (!this.#enabled) {
      return;
    }
    if (e.buttons !== this.#pointerTracker.getPointerButtons()) {
      this.#pointerTracker.deletePointer(e);
      this.#resetStateAndNotify();
    }
  };
  #finalizeDragCamera() {
    // Drag movement already determines the camera position. Keep the follow-up
    // up and polar corrections rotation-only so they do not fix the hit anchor.
    this.#finalizeCamera(false, false);
  }
  #finalizeCamera(preservePolarAnchor = true, preserveKeepUpAnchor = true) {
    const hitPoint =
      this.#hit && this.#hit.distance > 0 ? this.#hit.point : undefined;
    this.#limitCameraDistance(hitPoint);
    const anchorPoint = this.#hit?.virtual ? undefined : hitPoint;
    const keepCameraUpAnchor =
      preserveKeepUpAnchor && !this.#isCameraCenterMode()
        ? anchorPoint
        : undefined;
    this.#convergeCameraUp(keepCameraUpAnchor);
    const isCameraCenterMode = this.#isCameraCenterMode();
    const referenceUp = isCameraCenterMode
      ? this.#getWorldUpDirection()
      : this.#getPositionUpDirection(this.#camera.position, _positionUp);
    // Modified globe drag already rotates around the Earth center. Preserving
    // an off-center anchor during a polar correction would translate the
    // camera and make the globe silhouette drift or change size.
    this.#clampCameraPolarAngle(
      referenceUp,
      isCameraCenterMode || !preservePolarAnchor ? undefined : anchorPoint,
    );
    this.#camera.updateMatrixWorld();
  }
  #getWorldUpDirection() {
    return this.#worldUp || _worldZ;
  }
  #getPositionUpDirection(position, target) {
    if (this.#ellipsoid) {
      this.#ellipsoid.getPositionToNormal(position, target);
      if (target.lengthSq() > THRESHOLD * THRESHOLD) {
        return target;
      }
    }
    if (position.lengthSq() > THRESHOLD * THRESHOLD) {
      return target.copy(position).normalize();
    }
    return target.copy(_worldZ);
  }
  #rotatesAroundCamera() {
    return !!this.#hit?.virtual;
  }
  #computeCameraBasis() {
    this.#camera.getWorldDirection(_forward);
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    _right.crossVectors(_forward, _up).normalize();
  }
  #clampVerticalDelta(requestedAngle, cameraVerticalAngle) {
    const minVerticalAngle = THRESHOLD;
    const maxVerticalAngle = Math.PI - THRESHOLD;
    return MathUtils.clamp(
      requestedAngle,
      minVerticalAngle - cameraVerticalAngle,
      maxVerticalAngle - cameraVerticalAngle,
    );
  }
  #applyPivotRotation(rotation, rotateAroundCamera, rotationCenter) {
    if (rotateAroundCamera) {
      this.#camera.quaternion.premultiply(rotation).normalize();
      this.#camera.updateMatrixWorld();
      return;
    }
    makeRotateAroundPoint(rotationCenter, rotation, _rotMatrix);
    this.#camera.matrixWorld.premultiply(_rotMatrix);
    this.#camera.matrixWorld.decompose(
      this.#camera.position,
      this.#camera.quaternion,
      _vec6,
    );
    this.#camera.quaternion.normalize();
  }
  #getRotateScale() {
    const camera = this.#camera;
    const rotateAroundCamera = this.#rotatesAroundCamera();
    const anchorDistance = this.#hit?.distance ?? VIRTUAL_HIT_DISTANCE;
    const verticalRange = !rotateAroundCamera
      ? 2 * Math.PI
      : "isPerspectiveCamera" in camera
        ? MathUtils.degToRad(camera.getEffectiveFOV())
        : 0.5 *
          Math.atan(
            (camera.top - camera.bottom) / (2 * camera.zoom * anchorDistance),
          );
    return verticalRange / this.#domElement.clientHeight;
  }
  #rotateNearAnchor(rotateVec) {
    const worldUp = this.#getWorldUpDirection();
    const rotateAroundCamera = this.#rotatesAroundCamera();
    const rotationCenter = rotateAroundCamera
      ? this.#camera.position
      : this.#hit.point;
    const rotationDirection = rotateAroundCamera ? -1 : 1;
    this.#camera.getWorldDirection(_forward);
    const cameraVerticalAngle = Math.PI - _forward.angleTo(worldUp);
    const verticalAngle = this.#clampVerticalDelta(
      rotateVec.y * rotationDirection,
      cameraVerticalAngle,
    );
    const horizontalAngle = rotateVec.x * rotationDirection;
    _quaternion.setFromAxisAngle(worldUp, horizontalAngle);
    this.#applyPivotRotation(_quaternion, rotateAroundCamera, rotationCenter);
    this.#camera.getWorldDirection(_forward);
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    _vec1.crossVectors(_forward, _up).normalize();
    _right.copy(_vec1).projectOnPlane(worldUp);
    if (_right.lengthSq() <= THRESHOLD * THRESHOLD) {
      _right.crossVectors(_forward, worldUp);
    }
    if (_right.lengthSq() <= THRESHOLD * THRESHOLD) {
      return 0;
    }
    _right.normalize();
    if (_right.dot(_vec1) < 0) {
      _right.negate();
    }
    _quaternion.setFromAxisAngle(_right, verticalAngle);
    this.#applyPivotRotation(_quaternion, rotateAroundCamera, rotationCenter);
    return verticalAngle / rotationDirection;
  }
  #clampVerticalRotateAngle(axis, pivotPoint, verticalAngle) {
    if (verticalAngle <= 0) {
      return verticalAngle;
    }
    _up.copy(this.#camera.up).transformDirection(this.#camera.matrixWorld);
    const axisDotUp = axis.dot(_up);
    const axisDotPivot = axis.dot(pivotPoint);
    const axisProjection = axisDotPivot * axisDotUp;
    const a = pivotPoint.dot(_up) - axisProjection;
    const b = pivotPoint.dot(_vec1.crossVectors(axis, _up));
    const d = this.#camera.position.dot(_up) - a;
    const amplitude = Math.hypot(a, b);
    if (amplitude <= THRESHOLD) {
      return verticalAngle;
    }
    const cosValue = -d / amplitude;
    if (cosValue < -1 - THRESHOLD || cosValue > 1 + THRESHOLD) {
      return verticalAngle;
    }
    const clampedCosValue = MathUtils.clamp(cosValue, -1, 1);
    const phase = Math.atan2(b, a);
    const delta = Math.acos(clampedCosValue);
    const firstCandidate = phase - delta;
    const secondCandidate = phase + delta;
    let result = verticalAngle;
    for (let i = 0; i < 2; i++) {
      const candidate = i === 0 ? firstCandidate : secondCandidate;
      for (const offset of ROTATION_OFFSETS) {
        const angle = candidate + offset;
        if (angle > THRESHOLD && angle < result && angle <= verticalAngle) {
          result = angle;
        }
      }
    }
    return result;
  }
  #rotate(rotateVec) {
    if (!this.#hit) {
      return Number.NaN;
    }
    if (this.#isCameraCenterMode()) {
      return this.#rotateNearAnchor(rotateVec);
    }
    const rotateAroundCamera = this.#rotatesAroundCamera();
    const rotationDirection = rotateAroundCamera ? -1 : 1;
    const rotationCenter = rotateAroundCamera
      ? this.#camera.position
      : this.#hit.point;
    this.#computeCameraBasis();
    if (this.#hit) {
      this.#getPositionUpDirection(this.#hit.point, _localUp);
    }
    this.#getPositionUpDirection(this.#camera.position, _positionUp);
    const cameraVerticalAngle = Math.PI - _forward.angleTo(_positionUp);
    let verticalAngle = this.#clampVerticalDelta(
      rotateVec.y * rotationDirection,
      cameraVerticalAngle,
    );
    const horizontalAngle = rotateVec.x * rotationDirection;
    const horizontalUp = rotateAroundCamera ? _positionUp : _localUp;
    if (rotateAroundCamera) {
      _quaternion.setFromAxisAngle(_right, verticalAngle);
      this.#camera.quaternion.premultiply(_quaternion);
      _quaternion.setFromAxisAngle(horizontalUp, horizontalAngle);
      this.#camera.quaternion.premultiply(_quaternion).normalize();
      this.#camera.updateMatrixWorld();
      return verticalAngle / rotationDirection;
    }
    _pivotPoint.copy(rotationCenter);
    _ray.set(_pivotPoint.sub(_vec6.copy(_right).multiplyScalar(MAX)), _right);
    _plane.setFromNormalAndCoplanarPoint(_right, this.#camera.position);
    _ray.intersectPlane(_plane, _pivotPoint);
    verticalAngle = this.#clampVerticalRotateAngle(
      _right,
      _pivotPoint,
      verticalAngle,
    );
    // Rotate around the right axis
    _quaternion.setFromAxisAngle(_right, verticalAngle);
    this.#applyPivotRotation(_quaternion, false, _pivotPoint);
    // Rotate around the up axis
    _quaternion.setFromAxisAngle(horizontalUp, horizontalAngle);
    this.#applyPivotRotation(_quaternion, false, rotationCenter);
    return verticalAngle / rotationDirection;
  }
  #initializeDragAnchor(pointer) {
    if (!this.#hit || this.#hit.distance <= 0) {
      return;
    }
    this.#dragAnchorPoint.copy(this.#hit.point);
    if (pointer) {
      _vec6.copy(this.#dragAnchorPoint).project(this.#camera);
      this.#dragAnchorPointerOffset.set(
        _vec6.x - pointer.x,
        _vec6.y - pointer.y,
      );
    }
  }
  #intersectDragPlane(pointer, target) {
    this.#camera.getWorldDirection(this.#dragPlaneNormal);
    _plane.setFromNormalAndCoplanarPoint(
      this.#dragPlaneNormal,
      this.#dragAnchorPoint,
    );
    setRaycasterFromCamera(this.#raycaster, pointer, this.#camera);
    return this.#raycaster.ray.intersectPlane(_plane, target) !== null;
  }
  #modifiedDrag(pointer) {
    if (!this.#hit || this.#hit.distance <= 0 || this.#hit.virtual) {
      return false;
    }
    const radius = this.#dragAnchorPoint.length();
    if (radius <= THRESHOLD) {
      return false;
    }
    _dragEllipsoid.radius.setScalar(radius);
    setRaycasterFromCamera(this.#raycaster, pointer, this.#camera);
    if (!_dragEllipsoid.intersectRay(this.#raycaster.ray, _vec1)) {
      return false;
    }
    _vec1.normalize();
    if (this.#raycaster.ray.direction.dot(_vec1) > 0) {
      return false;
    }
    _vec2.copy(this.#dragAnchorPoint).normalize();
    _quaternion.setFromUnitVectors(_vec1, _vec2);
    this.#setModifiedDragInertia(_quaternion);
    return true;
  }
  #setModifiedDragInertia(rotation) {
    _axis.set(rotation.x, rotation.y, rotation.z);
    if (rotation.w < 0) {
      _axis.negate();
    }
    const axisLength = _axis.length();
    if (axisLength === 0) {
      this.#dragInertia.set(0, 0, 0);
      this.#dragInertiaIsRotation = true;
      return;
    }
    const angle = 2 * Math.atan2(axisLength, Math.abs(rotation.w));
    this.#dragInertia.copy(_axis).multiplyScalar(angle / axisLength);
    this.#dragInertiaIsRotation = true;
  }
  #applyCameraRotationAroundOrigin(rotation) {
    this.#applyPivotRotation(rotation, false, _vec3.set(0, 0, 0));
  }
  #getZoomDistanceScale(zoomAmount, source) {
    if (zoomAmount >= 0 || !this.#ellipsoid || this.#isCameraCenterMode()) {
      return 1;
    }
    const taperStartRadius = this.#ellipsoidMaxRadius * 2;
    const maxRadius = this.#ellipsoidMaxRadius * 3;
    const currentDistance = source.length();
    if (currentDistance <= taperStartRadius) {
      return 1;
    }
    if (currentDistance >= maxRadius) {
      return 0;
    }
    return (maxRadius - currentDistance) / (maxRadius - taperStartRadius);
  }
  #applyZoom(zoomAmount) {
    const hit = this.#hit;
    if (!hit || hit.distance <= 0) return;
    // Regenerate virtual hit at 50m from current camera position
    if (hit.virtual) {
      _forward.subVectors(hit.point, this.#camera.position).normalize();
      hit.point
        .copy(this.#camera.position)
        .addScaledVector(_forward, VIRTUAL_HIT_DISTANCE);
      hit.distance = VIRTUAL_HIT_DISTANCE;
      this.#pivotMesh.position.copy(hit.point);
    }
    let zoomFactor = Math.exp(-zoomAmount * 0.001);
    if (this.minDistance > 0 && zoomFactor < 1) {
      const distance = this.#camera.position.distanceTo(hit.point);
      if (distance * zoomFactor < this.minDistance) {
        zoomFactor = this.minDistance / distance;
      }
    }
    // @ts-expect-error - OrthographicCamera-specific zoom is not narrowed on the private union field.
    if (this.#camera.isOrthographicCamera) {
      this.#camera.zoom /= zoomFactor;
      this.#camera.updateProjectionMatrix();
    }
    const source = _vec4.copy(this.#camera.position);
    // Preserve the established exterior-zoom alignment for the whole step.
    const useExteriorZoomAlignment =
      !!this.#ellipsoid && !this.#isPositionInsideEllipsoid(source);
    const distanceScale = this.#getZoomDistanceScale(zoomAmount, source);
    this.#camera.position
      .copy(source)
      .sub(hit.point)
      .multiplyScalar(1 + (zoomFactor - 1) * distanceScale)
      .add(hit.point);
    this.#limitCameraDistance(hit.point);
    const keepZoomAnchor =
      !this.#ellipsoid || this.#isCameraInAnchorExteriorHalfSpace(hit.point);
    const isCameraCenterMode = this.#isCameraCenterMode();
    const zoomAnchor =
      keepZoomAnchor && !isCameraCenterMode ? hit.point : undefined;
    // Preserve the established exterior zoom pitch adjustment, then use the
    // standard pure-roll correction to converge against the local up at the
    // anchor-compensated camera position.
    if (useExteriorZoomAlignment && !isCameraCenterMode) {
      this.#convergeCameraUp(zoomAnchor, true);
    }
    this.#camera.updateMatrixWorld();
    if (this.state === DRAG) {
      this.#initializeDragAnchor();
    }
  }
  #reachCameraMinDistance() {
    return (
      this.minDistance > 0 &&
      !!this.#hit &&
      this.#hit.distance > 0 &&
      this.#camera.position.distanceTo(this.#hit.point) <=
        this.minDistance + INPUT_DAMPING_EPSILON
    );
  }
  #reachCameraMaxDistance() {
    if (!this.#ellipsoid || this.#isCameraCenterMode()) return false;
    const maxDistance = this.#ellipsoidMaxRadius * 3;
    const epsilon = Math.max(
      INPUT_DAMPING_EPSILON,
      maxDistance * MAX_DISTANCE_EPSILON_RATIO,
    );
    return this.#camera.position.length() >= maxDistance - epsilon;
  }
  #isCameraCenterMode() {
    return this.#camera.position.lengthSq() <= CAMERA_CENTER_MODE_DISTANCE_SQ;
  }
  #isPositionInsideEllipsoid(position) {
    if (!this.#ellipsoid) return false;
    return _vec3.copy(position).divide(this.#ellipsoid.radius).lengthSq() < 1;
  }
  #isCameraInAnchorExteriorHalfSpace(anchorPoint) {
    return (
      anchorPoint.dot(_vec3.subVectors(this.#camera.position, anchorPoint)) >= 0
    );
  }
  #limitCameraDistance(pivotPosition) {
    if (!this.#ellipsoid || this.#isCameraCenterMode()) return;
    // Compute max allowed radius
    const maxRadius = this.#ellipsoidMaxRadius * 3;
    // Get current camera distance from origin
    const currentDistance = this.#camera.position.length();
    // If the camera is already within limits, do nothing
    if (currentDistance <= maxRadius) return;
    if (pivotPosition) {
      // Vector from pivotPosition to cameraPosition
      _vec6.subVectors(this.#camera.position, pivotPosition);
      const a = _vec6.lengthSq();
      if (a <= THRESHOLD * THRESHOLD) {
        this.#camera.position.setLength(maxRadius);
        return;
      }
      // Solve for t in: |pivotPosition + t * (cameraPosition - pivotPosition)| = maxRadius
      const b = 2 * pivotPosition.dot(_vec6); // Projection onto pivotPosition
      const c = pivotPosition.lengthSq() - maxRadius ** 2; // Constraint for final length
      // Solve quadratic equation: a*t^2 + b*t + c = 0
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) {
        // No real solution, just clamp to maxRadius
        this.#camera.position.setLength(maxRadius);
        return;
      }
      const sqrtDiscriminant = Math.sqrt(discriminant);
      const t0 = (-b - sqrtDiscriminant) / (2 * a);
      const t1 = (-b + sqrtDiscriminant) / (2 * a);
      // Clamp to the intersection that lies on the current pivot->camera segment.
      // If the line only intersects outside the segment, fall back to radial clamp
      // to avoid large jumps when the pivot is virtual or near-tangent.
      let t = Number.NaN;
      if (t0 >= 0 && t0 <= 1) {
        t = t0;
      }
      if (t1 >= 0 && t1 <= 1) {
        t = Number.isNaN(t) ? t1 : Math.max(t, t1);
      }
      if (Number.isNaN(t)) {
        this.#camera.position.setLength(maxRadius);
        return;
      }
      // Move camera to the correct position
      this.#camera.position.copy(pivotPosition).addScaledVector(_vec6, t);
    } else {
      // Just set the length to maxRadius if no pivotPosition is given
      this.#camera.position.setLength(maxRadius);
    }
  }
  #shouldDragModified() {
    return (
      !!this.#ellipsoid &&
      !this.#isCameraCenterMode() &&
      this.#camera.position.length() >= this.#ellipsoidMaxRadius * 1.05
    );
  }
  #alignCameraRollForExteriorZoom(referenceUp) {
    this.#computeCameraBasis();
    _localRight.crossVectors(_up, referenceUp).normalize();
    if (_localRight.dot(_right) < 0) {
      _localRight.negate();
    }
    _quaternion.setFromUnitVectors(_right, _localRight);
    this.#camera.quaternion.premultiply(_quaternion).normalize();
    this.#computeCameraBasis();
    _localUp.crossVectors(_forward, referenceUp);
    if (_localUp.dot(_right) < 0) {
      const forwardAngle = _forward.angleTo(referenceUp);
      const targetUp =
        forwardAngle < Math.PI / 2
          ? referenceUp
          : _vec4.copy(referenceUp).negate();
      _axis.crossVectors(_forward, targetUp).normalize();
      _quaternion.setFromAxisAngle(_axis, _forward.angleTo(targetUp));
      this.#camera.quaternion.premultiply(_quaternion).normalize();
    }
  }
  #alignCameraRoll(referenceUp) {
    this.#camera.updateMatrixWorld();
    _forward.set(0, 0, -1).transformDirection(this.#camera.matrixWorld);
    _right.set(-1, 0, 0).transformDirection(this.#camera.matrixWorld);
    // Fade the correction when forward and referenceUp are nearly parallel,
    // where a unique screen-up direction does not exist.
    let alpha = MathUtils.mapLinear(
      1 - Math.abs(_forward.dot(referenceUp)),
      0,
      0.2,
      0,
      1,
    );
    alpha = MathUtils.clamp(alpha, 0, 1);
    // Keep this a pure roll by rotating the camera-side vector around forward.
    _localRight
      .crossVectors(referenceUp, _forward)
      .lerp(_right, 1 - alpha)
      .normalize();
    _quaternion.setFromUnitVectors(_right, _localRight);
    this.#camera.quaternion.premultiply(_quaternion).normalize();
  }
  #clampCameraPolarAngle(referenceUp, fixedPoint) {
    this.#camera.updateMatrixWorld();
    _forward.set(0, 0, 1).transformDirection(this.#camera.matrixWorld);
    _right.set(1, 0, 0).transformDirection(this.#camera.matrixWorld);
    const minVerticalAngle = THRESHOLD;
    const maxVerticalAngle = Math.PI - THRESHOLD;
    const verticalAngle = referenceUp.angleTo(_forward);
    const side = _vec.crossVectors(referenceUp, _forward).dot(_right);
    let targetAngle;
    if (side < 0) {
      // The signed angle wrapped across an endpoint of the legal 0..PI arc.
      // Select the closest endpoint so crossing PI cannot snap back to zero.
      targetAngle =
        verticalAngle < Math.PI / 2 ? minVerticalAngle : maxVerticalAngle;
    } else if (verticalAngle < minVerticalAngle) {
      targetAngle = minVerticalAngle;
    } else if (verticalAngle > maxVerticalAngle) {
      targetAngle = maxVerticalAngle;
    } else {
      return;
    }
    if (fixedPoint) {
      // Preserve the complete camera-local anchor position so the final polar
      // correction cannot move the active rotate / drag point on screen.
      this.#captureCameraLocalAnchor(fixedPoint);
    }
    _right.projectOnPlane(referenceUp);
    if (_right.lengthSq() <= THRESHOLD * THRESHOLD) {
      if (Math.abs(referenceUp.z) > 0.9) {
        _axis.set(0, 1, 0);
      } else {
        _axis.set(0, 0, 1);
      }
      _right.crossVectors(_axis, referenceUp);
    }
    _right.normalize();
    _forward.copy(referenceUp);
    _quaternion.setFromAxisAngle(_right, targetAngle);
    _forward.applyQuaternion(_quaternion).normalize();
    _localUp.crossVectors(_forward, _right).normalize();
    _rotMatrix.makeBasis(_right, _localUp, _forward);
    this.#camera.quaternion.setFromRotationMatrix(_rotMatrix);
    if (fixedPoint) {
      this.#restoreCameraLocalAnchor(fixedPoint);
    }
    this.#camera.updateMatrixWorld();
  }
  #captureCameraLocalAnchor(anchorPoint) {
    _anchorLocal
      .copy(anchorPoint)
      .applyMatrix4(this.#camera.matrixWorldInverse);
  }
  #restoreCameraLocalAnchor(anchorPoint) {
    this.#camera.updateMatrixWorld();
    _anchorLocal.applyMatrix4(this.#camera.matrixWorld);
    this.#camera.position.add(
      _anchorOffset.subVectors(anchorPoint, _anchorLocal),
    );
  }
  #keepCameraUp(anchorPoint, useExteriorZoomAlignment = false) {
    if (anchorPoint) {
      // Preserve the complete camera-local anchor position. This works on both
      // sides of the ellipsoid tangent plane and keeps perspective as well as
      // orthographic projection stable through the roll correction.
      this.#camera.updateMatrixWorld();
      this.#captureCameraLocalAnchor(anchorPoint);
    }
    // Near the ellipsoid centre the surface normal is unstable, so fall back to
    // the world up direction.
    const referenceUp = this.#isCameraCenterMode()
      ? this.#getWorldUpDirection()
      : this.#getPositionUpDirection(this.#camera.position, _positionUp);
    if (useExteriorZoomAlignment) {
      this.#alignCameraRollForExteriorZoom(referenceUp);
    } else {
      this.#alignCameraRoll(referenceUp);
    }
    if (anchorPoint) {
      this.#restoreCameraLocalAnchor(anchorPoint);
      this.#camera.updateMatrixWorld();
    }
  }
  #convergeCameraUp(anchorPoint, includeExteriorAlignment = false) {
    // Preserving the anchor translates the camera and changes its local
    // ellipsoid normal. Iterate to converge the final roll against the normal
    // at the compensated camera position while keeping the anchor fixed.
    const iterations = anchorPoint
      ? ANCHORED_KEEP_UP_ITERATIONS * (includeExteriorAlignment ? 2 : 1)
      : 1;
    for (let i = 0; i < iterations; i++) {
      if (includeExteriorAlignment) {
        this.#keepCameraUp(anchorPoint, true);
      }
      this.#keepCameraUp(anchorPoint);
    }
    if (includeExteriorAlignment) {
      this.#keepCameraUp(undefined, true);
    }
    this.#keepCameraUp();
  }
  #normalRaycastClosest(raycaster, objects) {
    const targets = Array.isArray(objects) ? objects : [objects];
    if (targets.length === 0) {
      return null;
    }
    const intersects = raycaster.intersectObjects(targets, true);
    for (const intersection of intersects) {
      if (
        this.#raycastHitFilter &&
        !this.#raycastHitFilter(intersection, raycaster)
      ) {
        continue;
      }
      return {
        point: intersection.point.clone(),
        distance: intersection.point.distanceTo(this.#camera.position),
      };
    }
    return null;
  }
  #raycast(raycaster) {
    const sceneHit = this.#normalRaycastClosest(raycaster, this.#scene);
    if (sceneHit) {
      return sceneHit;
    }
    const result = this.#isCameraCenterMode()
      ? undefined
      : this.#ellipsoid?.intersectRay(raycaster.ray, _vec6);
    if (result) {
      const hit = {
        point: _vec6.clone(),
        distance: _vec6.distanceTo(this.#camera.position),
        onGlobe: true,
      };
      return hit;
    }
    return this.#getVirtualHit(raycaster);
  }
  #getVirtualHit(raycaster) {
    return {
      point: raycaster.ray.at(VIRTUAL_HIT_DISTANCE, _vec6).clone(),
      distance: VIRTUAL_HIT_DISTANCE,
      onGlobe: true,
      virtual: true,
    };
  }
}

export { CameraController };
