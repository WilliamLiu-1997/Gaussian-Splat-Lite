import * as THREE from "three";
import type { Node, NodeFrame } from "three/webgpu";
import { SPLAT_TEX_WIDTH } from "../../data/defines";
import type { SplatMesh } from "../../scene/SplatMesh";
import type { SplatAccumulator, SplatMapping } from "../SplatAccumulator";
import { getViews } from "../rendererUtils";
import { N, load2D } from "./shaderUtils";
import { uintTexture } from "./tslCompat";
import { viewIndex } from "./viewUniforms";

type Pose = { matrix: THREE.Matrix4; source?: SplatMesh["splats"] };
type History = {
  frame: number;
  viewProjection: THREE.Matrix4;
  previousViewProjection: THREE.Matrix4;
  poses: Map<SplatMesh, Pose>;
  previousPoses: Map<SplatMesh, Pose>;
};

// One previous-frame transform per mapping entry and view; RAD streams can map
// hundreds of batches, so tile entries across texture rows.
const TRANSFORMS_PER_ROW = 64;
// Fallback accumulator rows per row of the row-to-entry lookup texture.
const ROW_LOOKUP_WIDTH = 1024;

/** Per-view, per-source-mesh rigid motion for the actual displayed accumulator. */
export class SplatVelocity {
  accumulator!: SplatAccumulator;
  private histories = new WeakMap<THREE.Camera, History>();
  // Poses recycled from two frames ago, so steady-state updates do not allocate.
  private readonly sparePoses: Pose[] = [];
  private texture = this.makeTexture(1);
  private stride = 1;
  // Fallback only: mapping entry of each row-aligned accumulator row, rebuilt
  // when the base/count layout it was built from changes.
  private rowLookup = this.makeRowLookup(1);
  private rowLookupLayout: number[] = [];
  // Textures keep their peak capacity until shrink() fits the next update.
  private shrinkPending = false;
  private lastFrame = -1;
  private lastRender = -1;
  private lastCamera: THREE.Camera | null = null;
  // Current transform of each view, shared by every mapping entry.
  private readonly currentClips: THREE.Matrix4[] = [];
  private readonly stillClip = new THREE.Matrix4();
  private readonly previousClip = new THREE.Matrix4();
  private readonly inverseModel = new THREE.Matrix4();
  private readonly translation = new THREE.Matrix4();
  private readonly viewMatrix = new THREE.Matrix4();
  private readonly viewProjection = new THREE.Matrix4();
  readonly current = N.varyingProperty("vec4", "gslVelocityCurrent");
  readonly previous = N.varyingProperty("vec4", "gslVelocityPrevious");
  readonly mrt = N.mrt({
    velocity: N.vec4(
      N.select(
        this.previous.w.greaterThan(0),
        this.current.xy
          .div(this.current.w)
          .sub(this.previous.xy.div(this.previous.w)),
        N.vec2(2),
      ),
      0,
      1,
    ),
  });
  private readonly matrices = N.texture(this.texture).onObjectUpdate(
    (frame) => {
      this.update(frame);
      return this.texture;
    },
  );
  private readonly viewStride = N.uniform(1, "uint").onObjectUpdate((frame) => {
    this.update(frame);
    return this.stride;
  });
  private readonly rowEntries = uintTexture(this.rowLookup).onObjectUpdate(
    (frame) => {
      this.update(frame);
      return this.rowLookup;
    },
  );

  constructor(private readonly native: boolean) {}

  private makeTexture(rows: number) {
    const height = Math.ceil(rows / TRANSFORMS_PER_ROW);
    const texture = new THREE.DataTexture(
      new Float32Array(height * TRANSFORMS_PER_ROW * 16),
      4 * TRANSFORMS_PER_ROW,
      height,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    texture.needsUpdate = true;
    return texture;
  }

  private makeRowLookup(rows: number) {
    const height = Math.ceil(rows / ROW_LOOKUP_WIDTH);
    const texture = new THREE.DataTexture(
      new Uint32Array(height * ROW_LOOKUP_WIDTH),
      ROW_LOOKUP_WIDTH,
      height,
      THREE.RedIntegerFormat,
      THREE.UnsignedIntType,
    );
    texture.needsUpdate = true;
    return texture;
  }

  private fits(texture: THREE.DataTexture, height: number) {
    const current = texture.image.height;
    return this.shrinkPending ? current === height : current >= height;
  }

  private ensureCapacity(rows: number) {
    if (this.fits(this.texture, Math.ceil(rows / TRANSFORMS_PER_ROW))) return;
    this.texture.dispose();
    this.texture = this.makeTexture(rows);
  }

  /** Fallback mapping entries start on accumulator rows and own whole rows. */
  private updateRowLookup(mapping: SplatMapping[]) {
    const layout = this.rowLookupLayout;
    if (
      !this.shrinkPending &&
      layout.length === mapping.length * 2 &&
      mapping.every(
        ({ base, count }, i) =>
          layout[i * 2] === base && layout[i * 2 + 1] === count,
      )
    )
      return;
    this.rowLookupLayout = mapping.flatMap(({ base, count }) => [base, count]);
    const last = mapping[mapping.length - 1];
    const rows = Math.max(
      1,
      last ? Math.ceil((last.base + last.count) / SPLAT_TEX_WIDTH) : 0,
    );
    if (!this.fits(this.rowLookup, Math.ceil(rows / ROW_LOOKUP_WIDTH))) {
      this.rowLookup.dispose();
      this.rowLookup = this.makeRowLookup(rows);
    }
    const data = this.rowLookup.image.data as Uint32Array;
    mapping.forEach(({ base, count }, index) => {
      data.fill(
        index,
        base / SPLAT_TEX_WIDTH,
        Math.ceil((base + count) / SPLAT_TEX_WIDTH),
      );
    });
    this.rowLookup.needsUpdate = true;
  }

  /** The view's history, rotated once per frame, holding `viewProjection`. */
  private advanceHistory(
    view: THREE.Camera,
    frameId: number,
    viewProjection: THREE.Matrix4,
  ) {
    let history = this.histories.get(view);
    if (!history) {
      history = {
        frame: frameId,
        viewProjection: viewProjection.clone(),
        previousViewProjection: viewProjection.clone(),
        poses: new Map(),
        previousPoses: new Map(),
      };
      this.histories.set(view, history);
    } else if (history.frame !== frameId) {
      history.frame = frameId;
      history.previousViewProjection.copy(history.viewProjection);
      const recycled = history.previousPoses;
      for (const pose of recycled.values()) {
        pose.source = undefined;
        this.sparePoses.push(pose);
      }
      recycled.clear();
      history.previousPoses = history.poses;
      history.poses = recycled;
    }
    history.viewProjection.copy(viewProjection);
    return history;
  }

  /** Fit the textures to the next update instead of their peak capacity. */
  shrink() {
    this.shrinkPending = true;
  }

  private update({ frameId, renderId, camera }: NodeFrame) {
    // A camera can render several times per frame with a different pose,
    // projection or accumulator: refresh the current data once per render, but
    // advance each view's history below only once per frame.
    if (
      !camera ||
      (frameId === this.lastFrame &&
        renderId === this.lastRender &&
        camera === this.lastCamera)
    )
      return;
    this.lastFrame = frameId;
    this.lastRender = renderId;
    this.lastCamera = camera;
    const accumulator = this.accumulator;
    const views = getViews(camera);
    const multiView = views[0] !== camera;
    this.stride = Math.max(1, accumulator.mapping.length);
    if (!this.native) this.updateRowLookup(accumulator.mapping);
    this.ensureCapacity(this.stride * views.length);
    this.shrinkPending = false;
    const data = this.texture.image.data as Float32Array;
    this.translation.makeTranslation(accumulator.viewOrigin);
    for (let eye = 0; eye < views.length; eye++) {
      const view = views[eye];
      // TRAANode installs its unjittered projection on Three's velocity node.
      // Invert matrixWorld like the splat projection: Camera.matrixWorldInverse
      // can omit rig scale.
      this.viewProjection.multiplyMatrices(
        multiView
          ? view.projectionMatrix
          : (N.velocity.projectionMatrix ?? view.projectionMatrix),
        this.viewMatrix.copy(view.matrixWorld).invert(),
      );
      const history = this.advanceHistory(view, frameId, this.viewProjection);
      this.currentClips[eye] ??= new THREE.Matrix4();
      const currentClip = this.currentClips[eye].multiplyMatrices(
        this.viewProjection,
        this.translation,
      );
      // An unmoved mesh's points only move with the view.
      this.stillClip.multiplyMatrices(
        history.previousViewProjection,
        this.translation,
      );
      accumulator.mapping.forEach((entry, index) => {
        const { node } = entry;
        const matrix = entry.matrixWorld;
        const source = entry.source;
        const previous = history.previousPoses.get(node);
        let previousClip = currentClip;
        if (previous && previous.source === source) {
          if (previous.matrix.equals(matrix)) {
            previousClip = this.stillClip;
          } else if (matrix.determinant() !== 0) {
            this.inverseModel.copy(matrix).invert();
            previousClip = this.previousClip
              .copy(history.previousViewProjection)
              .multiply(previous.matrix)
              .multiply(this.inverseModel)
              .multiply(this.translation);
          }
        }
        previousClip.toArray(data, (eye * this.stride + index) * 16);
        let pose = history.poses.get(node);
        if (!pose) {
          pose = this.sparePoses.pop() ?? { matrix: new THREE.Matrix4() };
          history.poses.set(node, pose);
        }
        pose.matrix.copy(matrix);
        pose.source = source;
      });
    }
    this.texture.needsUpdate = true;
  }

  /** Mapping entry of a fallback accumulator row; native projection stores it. */
  entryForRow(row: Node<"uint">) {
    return load2D(
      this.rowEntries,
      N.ivec2(row.mod(ROW_LOOKUP_WIDTH), row.div(N.uint(ROW_LOOKUP_WIDTH))),
    ).r;
  }

  assign(point: Node<"vec3">, index: Node<"uint">, camera: THREE.Camera) {
    const eye = viewIndex(camera);
    const clips = getViews(camera).map(() => new THREE.Matrix4());
    const currentClip = N.uniformArray<"mat4">(clips, "mat4")
      .onObjectUpdate((frame) => {
        this.update(frame);
        clips.forEach((clip, i) => {
          const current = this.currentClips[i];
          if (current) clip.copy(current);
        });
      })
      .element(eye);
    const entry = index.add(eye.mul(this.viewStride));
    const row = N.int(entry.div(N.uint(TRANSFORMS_PER_ROW)));
    const start = N.int(entry.mod(TRANSFORMS_PER_ROW).mul(4));
    const column = (x: number) =>
      load2D(this.matrices, N.ivec2(start.add(x), row));
    // Interpolate clip coordinates, then divide in the fragment shader so
    // zoom and rotation also reproject the pixels away from the Splat center.
    const position = N.vec4(point, 1);
    this.current.assign(currentClip.mul(position));
    this.previous.assign(
      N.mat4(column(0), column(1), column(2), column(3)).mul(position),
    );
  }

  dispose() {
    this.texture.dispose();
    this.rowLookup.dispose();
    // Drop mesh, source and camera references a live camera could retain.
    this.histories = new WeakMap();
    this.sparePoses.length = 0;
    this.currentClips.length = 0;
    this.lastCamera = null;
  }
}
