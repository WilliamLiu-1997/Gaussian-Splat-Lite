import * as N from "three/tsl";
import { Node } from "three/webgpu";
import { usesNativeWebGPU } from "../rendererUtils.js";

// Three r186 has no TSL sample-mask output. Keep the one localized builder
// extension here; target allocation and draw substitution use public APIs.
class SampleMaskNode extends Node {
  constructor(maskNode) {
    super("void");
    this.maskNode = maskNode;
  }
  generate(builder) {
    const mask = this.maskNode.build(builder, "uint");
    if (!usesNativeWebGPU(builder.renderer)) {
      builder.enableExtension("GL_OES_sample_variables", "require");
      builder.addLineFlowCode(`gl_SampleMask[0] = int(${mask})`, this);
      return;
    }
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

/** Matches the four stratified coverage decisions in splatFragment.glsl. */
export function stochasticCoverage(alpha, random) {
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
}
