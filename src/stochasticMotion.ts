import { type Camera, Matrix4 } from "three";

export type StochasticMotionPhase = "sorted" | "moving" | "settling";

/** Tracks camera motion separately from the last successfully sorted view. */
export class StochasticMotionState {
  private readonly matrixWorld = new Matrix4();
  private readonly projectionMatrix = new Matrix4();
  private initialized = false;
  private pendingSettle = false;
  revision = 0;

  private cameraChanged(camera: Camera) {
    return (
      !this.matrixWorld.equals(camera.matrixWorld) ||
      !this.projectionMatrix.equals(camera.projectionMatrix)
    );
  }

  /** Returns what observe() would select without advancing the motion state. */
  wouldUseStochastic(camera: Camera): boolean {
    if (!this.initialized) return false;

    return this.pendingSettle || this.cameraChanged(camera);
  }

  observe(camera: Camera): StochasticMotionPhase {
    const changed = this.initialized && this.cameraChanged(camera);

    if (!this.initialized || changed) {
      this.matrixWorld.copy(camera.matrixWorld);
      this.projectionMatrix.copy(camera.projectionMatrix);
      this.initialized = true;
    }

    if (changed) {
      this.revision += 1;
      this.pendingSettle = true;
      return "moving";
    }

    return this.pendingSettle ? "settling" : "sorted";
  }

  requestSettle() {
    this.revision += 1;
    this.pendingSettle = true;
  }

  complete(revision: number): boolean {
    if (!this.pendingSettle || revision !== this.revision) return false;
    this.pendingSettle = false;
    return true;
  }

  reset() {
    this.initialized = false;
    this.pendingSettle = false;
    this.revision = 0;
  }
}
