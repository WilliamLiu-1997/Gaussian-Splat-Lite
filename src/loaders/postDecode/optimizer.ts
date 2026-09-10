import {
  Opcode,
  type PostDecodeSource,
  type SplatPostDecodeOutputs,
} from "./protocol";

/** Fuse only single-use intermediates; shared values must still run once. */
export function fuseArithmetic(
  source: PostDecodeSource,
  outputs: SplatPostDecodeOutputs,
): PostDecodeSource {
  const uses = new Uint32Array(source.instructions.length);
  for (const instruction of source.instructions) {
    for (const argument of instruction.args) uses[argument] += 1;
  }
  for (const register of [
    outputs.when,
    outputs.position,
    outputs.scale,
    outputs.quaternion,
    outputs.opacity,
    outputs.alpha,
    outputs.color,
    ...(outputs.sh ?? []),
  ]) {
    if (register !== undefined) uses[register] += 1;
  }

  const instructions = source.instructions.slice();
  for (let index = 0; index < instructions.length; index += 1) {
    const outer = instructions[index];
    if (outer.opcode !== Opcode.Add && outer.opcode !== Opcode.Multiply) {
      continue;
    }
    const innerOpcode =
      outer.opcode === Opcode.Add ? Opcode.Multiply : Opcode.Add;
    for (let side = 0; side < 2; side += 1) {
      const register = outer.args[side];
      const inner = instructions[register];
      if (uses[register] !== 1 || inner.opcode !== innerOpcode) continue;
      instructions[index] = {
        ...outer,
        opcode:
          outer.opcode === Opcode.Add ? Opcode.MultiplyAdd : Opcode.AddMultiply,
        args: [...inner.args, outer.args[1 - side]],
        // Keep the outer operand order as well as its rounding boundary.
        immediate: side,
      };
      break;
    }
  }
  // The compiler's dependency walk removes the bypassed intermediates.
  return { ...source, instructions };
}
