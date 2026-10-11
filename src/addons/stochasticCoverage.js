import * as N from "three/tsl";
import { Node } from "three/webgpu";
import { MaterialState } from "../rendering/MaterialState.js";
import { createStochasticSplatVariant } from "../rendering/tsl/SplatMaterial.js";

// Three r186 has no TSL sample-mask output. Keep the one WGSL builder
// extension here; target allocation and draw substitution use public APIs.
class SampleMaskNode extends Node {
  constructor(maskNode) {
    super("void");
    this.maskNode = maskNode;
  }
  generate(builder) {
    const mask = this.maskNode.build(builder, "uint");
    const name = builder.getBuiltin(
      "sample_mask",
      "gslSampleMask",
      "u32",
      "output",
    );
    builder.addLineFlowCode(
      `${builder.getOutputStructName()}.${name} = ${mask}`,
      this,
    );
  }
}

/** Four coverage decisions in one fragment, resolved by 4x MSAA. */
export class StochasticCoverage {
  materials = new Map();
  constructor() {
    this.coverage = (alpha, random) => {
      const phase = random.toVar();
      const mask = N.uint(0).toVar();
      for (let sample = 0; sample < 4; sample++) {
        // Wrap each shifted phase: every bit must have probability alpha,
        // including when independently seeded Splats overlap in depth.
        const hit = phase
          .add(sample / 4)
          .fract()
          .lessThan(alpha);
        mask.bitOrAssign(hit.select(N.uint(1 << sample), N.uint(0)));
      }
      mask.equal(0).discard();
      N.nodeObject(new SampleMaskNode(mask)).toStack();
    };
  }
  material(source) {
    let entry = this.materials.get(source);
    if (!entry) {
      const variant = createStochasticSplatVariant(source, this.coverage);
      if (!variant) return source;
      const dispose = () => {
        source.removeEventListener("dispose", dispose);
        variant.dispose();
        this.materials.delete(source);
      };
      entry = { variant, state: new MaterialState(source), dispose };
      this.materials.set(source, entry);
      source.addEventListener("dispose", dispose);
    }
    entry.state.sync(entry.variant, source);
    return entry.variant;
  }
  render(renderer, scene, camera) {
    const previous = renderer.getRenderObjectFunction();
    const draw = previous ?? renderer.renderObject;
    renderer.setRenderObjectFunction((...args) => {
      args[4] = this.material(args[4]);
      draw.apply(renderer, args);
    });
    try {
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderObjectFunction(previous);
    }
  }
  dispose() {
    for (const entry of this.materials.values()) entry.dispose();
  }
}
