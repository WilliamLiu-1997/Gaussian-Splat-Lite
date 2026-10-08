import * as THREE from "three";
import {
  type Node,
  NodeMaterial,
  QuadMesh,
  type TextureNode,
  type WebGPURenderer,
} from "three/webgpu";
import { N } from "../../../rendering/tsl/shaderUtils";

/**
 * A variance shadow map of one light for Splats on WebGPURenderer, which
 * keeps the one it blurs for meshes to itself: the mean and standard
 * deviation of depth around each texel. It is blurred from the light's depth
 * map as Three.js blurs its own, down and then across, over `shadow.radius`
 * texels in `shadow.blurSamples` steps.
 */
export class VarianceMap {
  /** The light's depth map, as Three.js draws it. */
  readonly depth: TextureNode;
  private readonly targets: THREE.RenderTarget[];
  private readonly materials: NodeMaterial[];
  private readonly quad: QuadMesh;
  private readonly steps = N.uniform(8);
  private readonly radius = N.uniform(1);
  private readonly size = N.uniform(new THREE.Vector2(1, 1));

  constructor(private readonly shadow: THREE.LightShadow) {
    const map = shadow.map as THREE.RenderTarget;
    this.depth = N.texture(map.depthTexture as THREE.DepthTexture);
    this.targets = [0, 1].map(
      () =>
        new THREE.RenderTarget(1, 1, {
          format: THREE.RGFormat,
          type: THREE.HalfFloatType,
          depthBuffer: false,
        }),
    );
    const down = this.blur(
      (uv) => {
        const depth = this.depth.sample(uv).r;
        return N.vec2(depth, depth.mul(depth));
      },
      N.vec2(0, 1),
    );
    const across = this.blur(
      (uv) => {
        const moments = N.texture(this.targets[0].texture).sample(uv);
        return N.vec2(
          moments.r,
          moments.g.mul(moments.g).add(moments.r.mul(moments.r)),
        );
      },
      N.vec2(1, 0),
    );
    this.materials = [down, across].map((fragmentNode) =>
      Object.assign(new NodeMaterial(), {
        fragmentNode,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      }),
    );
    this.quad = new QuadMesh(this.materials[0]);
  }

  /** The blurred map. */
  get texture() {
    return this.targets[1].texture;
  }

  /**
   * One pass: the mean of `steps` samples along `axis`, and the standard
   * deviation from the mean of their squares. `sample` returns both.
   */
  private blur(sample: (uv: Node<"vec2">) => Node<"vec2">, axis: Node<"vec2">) {
    const { steps, radius, size } = this;
    return N.Fn(() => {
      const sum = N.vec2(0).toVar();
      const single = steps.lessThanEqual(1);
      const stride = N.select(single, 0, N.float(2).div(steps.sub(1)));
      const start = N.select(single, 0, -1);
      N.Loop(
        {
          name: "i",
          type: "int",
          start: N.int(0),
          end: N.int(steps),
          condition: "<",
        },
        ({ i }) => {
          const offset = start.add(N.float(i).mul(stride)).mul(radius);
          sum.addAssign(
            sample(N.screenCoordinate.xy.add(axis.mul(offset)).div(size)),
          );
        },
      );
      const mean = sum.x.div(steps);
      const deviation = sum.y.div(steps).sub(mean.mul(mean)).max(0).sqrt();
      return N.vec4(mean, deviation, 0, 1);
    })();
  }

  /** Blurs the depth map as it is now. Call after Three.js has drawn it. */
  render(renderer: WebGPURenderer) {
    const { shadow, quad } = this;
    const { width, height } = shadow.mapSize;
    const depth = shadow.map?.depthTexture;
    // Released: the draw that asked finds out next and draws nothing.
    if (!depth) return;
    this.depth.value = depth;
    this.steps.value = shadow.blurSamples;
    this.radius.value = shadow.radius;
    this.size.value.set(width, height);
    const previous = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      level: renderer.getActiveMipmapLevel(),
      xr: renderer.xr.enabled,
      mrt: renderer.getMRT(),
    };
    try {
      renderer.xr.enabled = false;
      renderer.setMRT(null);
      this.targets.forEach((target, pass) => {
        target.setSize(width, height);
        quad.material = this.materials[pass];
        renderer.setRenderTarget(target);
        quad.render(renderer);
      });
    } finally {
      renderer.setRenderTarget(previous.target, previous.face, previous.level);
      renderer.setMRT(previous.mrt);
      renderer.xr.enabled = previous.xr;
    }
  }

  dispose() {
    for (const target of this.targets) target.dispose();
    for (const material of this.materials) material.dispose();
  }
}
