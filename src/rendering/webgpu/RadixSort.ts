import * as TSL from "three/tsl";
import { StorageBufferAttribute } from "three/webgpu";

// biome-ignore lint/suspicious/noExplicitAny: Three's public TSL typings do not expose a common chainable node type.
type TSLNode = any;
const N = TSL as Record<string, TSLNode>;

const RADIX_BITS = 4;
const RADIX_BUCKETS = 1 << RADIX_BITS;
const WEBGPU_SORT_KEY_BITS = 32;
const RADIX_PASSES = WEBGPU_SORT_KEY_BITS / RADIX_BITS;
const WORKGROUP_SIZE = 256;
const ELEMENTS_PER_THREAD = 8;
const ELEMENTS_PER_WORKGROUP = WORKGROUP_SIZE * ELEMENTS_PER_THREAD;
const PREFIX_ITEMS_PER_WORKGROUP = WORKGROUP_SIZE * 2;
const PREFIX_LEVELS = 3;

type MutableUniform = { value: number };

type BufferRef = { value: StorageBufferAttribute };
type KeyGenerator = (index: TSLNode) => TSLNode;

type CountTask = {
  compute: TSLNode;
  elementCount: MutableUniform;
};

type PrefixLevel = {
  scan: CountTask;
  add: CountTask | null;
  blockSums: BufferRef;
};

type RadixPass = {
  histogram: TSLNode;
  reorder: TSLNode;
};

function storage(
  buffer: BufferRef,
  type: string,
  name: string,
  readOnly = false,
) {
  const getBuffer = () => buffer.value;
  const node = N.storage(getBuffer(), type).onObjectUpdate(getBuffer);
  node.name = name;
  return readOnly ? node.toReadOnly() : node;
}

function mutableUniform(value: number, type: string) {
  const holder: MutableUniform = { value };
  return {
    holder,
    node: N.uniform(value, type).onObjectUpdate(() => holder.value),
  };
}

function makeBuffer(count: number) {
  return new StorageBufferAttribute(new Uint32Array(Math.max(1, count)), 1);
}

function makeBufferRef(count: number): BufferRef {
  return { value: makeBuffer(count) };
}

function getPrefixBlockCount(itemCount: number) {
  return Math.max(1, Math.ceil(itemCount / PREFIX_ITEMS_PER_WORKGROUP));
}

function makeHistogramTask({
  input,
  blockSums,
  elementCount,
  bitOffset,
  firstPass,
  keyGenerator,
}: {
  input: BufferRef;
  blockSums: BufferRef;
  elementCount: TSLNode;
  bitOffset: number;
  firstPass: boolean;
  keyGenerator: KeyGenerator;
}) {
  const inputKeys = storage(input, "uint", "gslRadixInputKeys", !firstPass);
  const sums = storage(blockSums, "uint", "gslRadixBlockSums");
  const bit = N.uint(bitOffset);
  const histogram = N.workgroupArray("uint", RADIX_BUCKETS).setName(
    "gslRadixHistogram",
  );

  return N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = N.workgroupId.x;

    N.If(tid.lessThan(RADIX_BUCKETS), () => {
      N.atomicStore(histogram.element(tid), N.uint(0));
    });
    N.workgroupBarrier();

    N.Loop(
      {
        start: N.uint(0),
        end: N.uint(ELEMENTS_PER_THREAD),
        type: "uint",
        condition: "<",
      },
      ({ i: round }: { i: TSLNode }) => {
        const index = workgroup
          .mul(ELEMENTS_PER_WORKGROUP)
          .add(round.mul(WORKGROUP_SIZE))
          .add(tid);
        N.If(index.lessThan(elementCount), () => {
          const key = (
            firstPass ? keyGenerator(index) : inputKeys.element(index)
          ).toVar();
          if (firstPass) inputKeys.element(index).assign(key);
          const digit = key.shiftRight(bit).bitAnd(RADIX_BUCKETS - 1);
          N.atomicAdd(histogram.element(digit), N.uint(1));
        });
      },
    );

    N.workgroupBarrier();
    N.If(tid.lessThan(RADIX_BUCKETS), () => {
      sums
        .element(tid.mul(N.numWorkgroups.x).add(workgroup))
        .assign(N.atomicLoad(histogram.element(tid)));
    });
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix histogram");
}

function makePrefixScanTask(
  itemsBuffer: BufferRef,
  blockSumsBuffer: BufferRef,
): CountTask {
  const items = storage(itemsBuffer, "uint", "gslPrefixItems");
  const blockSums = storage(blockSumsBuffer, "uint", "gslPrefixBlockSums");
  const countUniform = mutableUniform(0, "uint");
  const temp = N.workgroupArray("uint", PREFIX_ITEMS_PER_WORKGROUP).setName(
    "gslPrefixTemp",
  );

  const compute = N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = N.workgroupId.x;
    const first = workgroup.mul(PREFIX_ITEMS_PER_WORKGROUP).add(tid.mul(2));
    const second = first.add(1);

    temp.element(tid.mul(2)).assign(0);
    temp.element(tid.mul(2).add(1)).assign(0);
    N.If(first.lessThan(countUniform.node), () => {
      temp.element(tid.mul(2)).assign(items.element(first));
    });
    N.If(second.lessThan(countUniform.node), () => {
      temp.element(tid.mul(2).add(1)).assign(items.element(second));
    });

    const offset = N.uint(1).toVar();
    N.Loop(
      {
        start: N.uint(PREFIX_ITEMS_PER_WORKGROUP >> 1),
        end: N.uint(0),
        type: "uint",
        condition: ">",
        update: ">>= 1",
      },
      ({ i: distance }: { i: TSLNode }) => {
        N.workgroupBarrier();
        N.If(tid.lessThan(distance), () => {
          const a = offset.mul(tid.mul(2).add(1)).sub(1);
          const b = offset.mul(tid.mul(2).add(2)).sub(1);
          temp.element(b).addAssign(temp.element(a));
        });
        offset.mulAssign(2);
      },
    );
    N.workgroupBarrier();

    N.If(tid.equal(0), () => {
      blockSums
        .element(workgroup)
        .assign(temp.element(N.uint(PREFIX_ITEMS_PER_WORKGROUP - 1)));
      temp.element(N.uint(PREFIX_ITEMS_PER_WORKGROUP - 1)).assign(0);
    });

    N.Loop(
      {
        start: N.uint(1),
        end: N.uint(PREFIX_ITEMS_PER_WORKGROUP),
        type: "uint",
        condition: "<",
        update: "<<= 1",
      },
      ({ i: distance }: { i: TSLNode }) => {
        offset.shiftRightAssign(1);
        N.workgroupBarrier();
        N.If(tid.lessThan(distance), () => {
          const a = offset.mul(tid.mul(2).add(1)).sub(1);
          const b = offset.mul(tid.mul(2).add(2)).sub(1);
          const value = temp.element(a).toVar();
          temp.element(a).assign(temp.element(b));
          temp.element(b).addAssign(value);
        });
      },
    );

    N.workgroupBarrier();
    N.If(first.lessThan(countUniform.node), () => {
      items.element(first).assign(temp.element(tid.mul(2)));
    });
    N.If(second.lessThan(countUniform.node), () => {
      items.element(second).assign(temp.element(tid.mul(2).add(1)));
    });
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix prefix scan");

  return { compute, elementCount: countUniform.holder };
}

function makePrefixAddTask(
  itemsBuffer: BufferRef,
  blockSumsBuffer: BufferRef,
): CountTask {
  const items = storage(itemsBuffer, "uint", "gslPrefixItems");
  const blockSums = storage(
    blockSumsBuffer,
    "uint",
    "gslPrefixBlockSums",
    true,
  );
  const countUniform = mutableUniform(0, "uint");

  const compute = N.Fn(() => {
    const first = N.instanceIndex.mul(2);
    const second = first.add(1);
    const workgroup = N.workgroupId.x;
    N.If(first.lessThan(countUniform.node), () => {
      const value = blockSums.element(workgroup);
      items.element(first).addAssign(value);
      N.If(second.lessThan(countUniform.node), () => {
        items.element(second).addAssign(value);
      });
    });
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix prefix add");

  return { compute, elementCount: countUniform.holder };
}

function makeReorderTask({
  inputKeysAttribute,
  outputKeysAttribute,
  inputValuesAttribute,
  outputValuesAttribute,
  prefixAttribute,
  elementCount,
  bitOffset,
  firstPass,
  lastPass,
}: {
  inputKeysAttribute: BufferRef;
  outputKeysAttribute: BufferRef;
  inputValuesAttribute: BufferRef;
  outputValuesAttribute: BufferRef;
  prefixAttribute: BufferRef;
  elementCount: TSLNode;
  bitOffset: number;
  firstPass: boolean;
  lastPass: boolean;
}) {
  const inputKeys = storage(
    inputKeysAttribute,
    "uint",
    "gslRadixInputKeys",
    true,
  );
  const outputKeys = lastPass
    ? null
    : storage(outputKeysAttribute, "uint", "gslRadixOutputKeys");
  const inputValues = storage(
    inputValuesAttribute,
    "uint",
    "gslRadixInputValues",
    true,
  );
  const outputValues = storage(
    outputValuesAttribute,
    "uint",
    "gslRadixOutputValues",
  );
  const prefix = storage(prefixAttribute, "uint", "gslRadixPrefix", true);
  const bitOffsetNode = N.uint(bitOffset);
  const digitMasks = N.workgroupArray("uint", RADIX_BUCKETS * 8).setName(
    "gslRadixDigitMasks",
  );
  const digitOffsets = N.workgroupArray("uint", RADIX_BUCKETS).setName(
    "gslRadixDigitOffsets",
  );

  return N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = N.workgroupId.x;
    const word = tid.shiftRight(5);
    const bit = tid.bitAnd(31);

    N.If(tid.lessThan(RADIX_BUCKETS), () => {
      digitOffsets.element(tid).assign(0);
    });
    N.If(tid.lessThan(RADIX_BUCKETS * 8), () => {
      N.atomicStore(digitMasks.element(tid), N.uint(0));
    });
    N.workgroupBarrier();

    N.Loop(
      {
        start: N.uint(0),
        end: N.uint(ELEMENTS_PER_THREAD),
        type: "uint",
        condition: "<",
      },
      ({ i: round }: { i: TSLNode }) => {
        const index = workgroup
          .mul(ELEMENTS_PER_WORKGROUP)
          .add(round.mul(WORKGROUP_SIZE))
          .add(tid);
        const valid = index.lessThan(elementCount);
        const key = N.uint(0).toVar();
        const digit = N.uint(0).toVar();
        const value = index.toVar();
        N.If(valid, () => {
          key.assign(inputKeys.element(index));
          digit.assign(key.shiftRight(bitOffsetNode).bitAnd(RADIX_BUCKETS - 1));
          if (!firstPass) value.assign(inputValues.element(index));
          N.atomicOr(
            digitMasks.element(digit.mul(8).add(word)),
            N.uint(1).shiftLeft(bit),
          );
        });

        N.workgroupBarrier();
        N.If(valid, () => {
          // Materialize this before the loop. Without toVar(), TSL emits the
          // expression only at its first use inside the loop, leaving the
          // zero-word path with a stale/uninitialized base.
          const base = digit.mul(8).toVar();
          const localPrefix = digitOffsets.element(digit).toVar();
          N.Loop(
            {
              start: N.uint(0),
              end: word,
              type: "uint",
              condition: "<",
            },
            ({ i: precedingWord }: { i: TSLNode }) => {
              localPrefix.addAssign(
                N.countOneBits(
                  N.atomicLoad(digitMasks.element(base.add(precedingWord))),
                ),
              );
            },
          );
          const lowerBits = N.uint(1).shiftLeft(bit).sub(1);
          localPrefix.addAssign(
            N.countOneBits(
              N.atomicLoad(digitMasks.element(base.add(word))).bitAnd(
                lowerBits,
              ),
            ),
          );
          const prefixIndex = digit.mul(N.numWorkgroups.x).add(workgroup);
          const sortedIndex = prefix.element(prefixIndex).add(localPrefix);
          outputKeys?.element(sortedIndex).assign(key);
          outputValues.element(sortedIndex).assign(value);
        });

        N.If(round.lessThan(ELEMENTS_PER_THREAD - 1), () => {
          N.workgroupBarrier();
          N.If(tid.lessThan(RADIX_BUCKETS), () => {
            const count = N.uint(0).toVar();
            N.Loop(
              {
                start: N.uint(0),
                end: N.uint(8),
                type: "uint",
                condition: "<",
              },
              ({ i: maskWord }: { i: TSLNode }) => {
                const maskIndex = tid.mul(8).add(maskWord);
                count.addAssign(
                  N.countOneBits(N.atomicLoad(digitMasks.element(maskIndex))),
                );
                N.atomicStore(digitMasks.element(maskIndex), N.uint(0));
              },
            );
            digitOffsets.element(tid).addAssign(count);
          });
          N.workgroupBarrier();
        });
      },
    );
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix reorder");
}

/** Portable stable 4-bit GPU radix sort specialized for positive depth keys. */
export class WebGPURadixSort {
  capacity: number;
  readonly nodes: TSLNode[];

  private readonly elementCount = mutableUniform(0, "uint");
  private readonly keys: [BufferRef, BufferRef];
  private readonly values: [BufferRef, BufferRef];
  private readonly blockSums: BufferRef;
  private readonly prefixLevels: PrefixLevel[] = [];
  private readonly passes: RadixPass[] = [];
  private dispatchWorkgroups = 0;
  private dispatchNodes: TSLNode[] = [];

  constructor(capacity: number, keyGenerator: KeyGenerator) {
    const safeCapacity = Math.max(1, capacity);
    this.capacity = safeCapacity;
    this.keys = [makeBufferRef(safeCapacity), makeBufferRef(safeCapacity)];
    this.values = [makeBufferRef(safeCapacity), makeBufferRef(safeCapacity)];

    const maxWorkgroups = Math.max(
      1,
      Math.ceil(safeCapacity / ELEMENTS_PER_WORKGROUP),
    );
    this.blockSums = makeBufferRef(RADIX_BUCKETS * maxWorkgroups);
    this.createPrefixLevels(RADIX_BUCKETS * maxWorkgroups);

    for (let pass = 0; pass < RADIX_PASSES; pass++) {
      const firstPass = pass === 0;
      const inputIndex = pass & 1;
      const outputIndex = inputIndex ^ 1;
      this.passes.push({
        histogram: makeHistogramTask({
          input: this.keys[inputIndex],
          blockSums: this.blockSums,
          elementCount: this.elementCount.node,
          bitOffset: pass * RADIX_BITS,
          firstPass,
          keyGenerator,
        }),
        reorder: makeReorderTask({
          inputKeysAttribute: this.keys[inputIndex],
          outputKeysAttribute: this.keys[outputIndex],
          inputValuesAttribute: this.values[inputIndex],
          outputValuesAttribute: this.values[outputIndex],
          prefixAttribute: this.blockSums,
          elementCount: this.elementCount.node,
          bitOffset: pass * RADIX_BITS,
          firstPass,
          lastPass: pass === RADIX_PASSES - 1,
        }),
      });
    }
    this.nodes = this.passes.flatMap(({ histogram, reorder }) => [
      histogram,
      reorder,
    ]);
    for (const { scan, add } of this.prefixLevels) {
      this.nodes.push(scan.compute);
      if (add) this.nodes.push(add.compute);
    }
  }

  get ordering() {
    // An even pass count leaves the final values in the first ping-pong buffer.
    return this.values[RADIX_PASSES & 1].value;
  }

  private replaceBuffer(buffer: BufferRef, count: number) {
    const nextCount = Math.max(1, count);
    if (buffer.value.count === nextCount) return;

    const previous = buffer.value;
    buffer.value = makeBuffer(nextCount);
    previous.dispose();
  }

  private createPrefixLevels(itemCount: number) {
    let items = this.blockSums;
    let currentCount = itemCount;

    for (let levelIndex = 0; levelIndex < PREFIX_LEVELS; levelIndex++) {
      const blockCount = getPrefixBlockCount(currentCount);
      const blockSums = makeBufferRef(blockCount);
      this.prefixLevels.push({
        scan: makePrefixScanTask(items, blockSums),
        add:
          levelIndex < PREFIX_LEVELS - 1
            ? makePrefixAddTask(items, blockSums)
            : null,
        blockSums,
      });
      items = blockSums;
      currentCount = blockCount;
    }
  }

  private resizePrefixBuffers(itemCount: number) {
    let currentCount = itemCount;
    for (const level of this.prefixLevels) {
      const blockCount = getPrefixBlockCount(currentCount);
      this.replaceBuffer(level.blockSums, blockCount);
      currentCount = blockCount;
    }
  }

  private appendPrefixNodes(itemCount: number, nodes: TSLNode[]) {
    const activeLevels: { level: PrefixLevel; count: number }[] = [];
    let currentCount = itemCount;
    for (const level of this.prefixLevels) {
      const blockCount = getPrefixBlockCount(currentCount);
      level.scan.elementCount.value = currentCount;
      level.scan.compute.dispatchSize = [blockCount, 1, 1];
      nodes.push(level.scan.compute);
      activeLevels.push({ level, count: currentCount });
      if (blockCount === 1) break;
      currentCount = blockCount;
    }

    for (let index = activeLevels.length - 1; index >= 0; index--) {
      const { level, count } = activeLevels[index];
      if (!level.add) continue;
      const blockCount = getPrefixBlockCount(count);
      if (blockCount <= 1) continue;
      level.add.elementCount.value = count;
      level.add.compute.dispatchSize = [blockCount, 1, 1];
      nodes.push(level.add.compute);
    }
  }

  resize(capacity: number, shrinkResources = false) {
    const requiredCapacity = Math.max(1, capacity);
    if (!shrinkResources && requiredCapacity <= this.capacity) return;

    if (requiredCapacity === this.capacity) return;

    for (const buffer of this.keys) {
      this.replaceBuffer(buffer, requiredCapacity);
    }
    for (const buffer of this.values) {
      this.replaceBuffer(buffer, requiredCapacity);
    }

    const maxWorkgroups = Math.max(
      1,
      Math.ceil(requiredCapacity / ELEMENTS_PER_WORKGROUP),
    );
    this.replaceBuffer(this.blockSums, RADIX_BUCKETS * maxWorkgroups);
    this.resizePrefixBuffers(RADIX_BUCKETS * maxWorkgroups);
    this.capacity = requiredCapacity;
  }

  prepare(elementCount: number): TSLNode[] {
    if (
      !Number.isSafeInteger(elementCount) ||
      elementCount < 0 ||
      elementCount > this.capacity
    ) {
      throw new RangeError(
        "Sort count must be an integer within buffer capacity",
      );
    }
    if (elementCount === 0) return [];

    this.elementCount.holder.value = elementCount;
    const workgroupCount = Math.ceil(elementCount / ELEMENTS_PER_WORKGROUP);
    if (workgroupCount === this.dispatchWorkgroups) return this.dispatchNodes;

    const prefixCount = RADIX_BUCKETS * workgroupCount;
    const dispatchSize = [workgroupCount, 1, 1];
    const nodes: TSLNode[] = [];
    const prefixNodes: TSLNode[] = [];
    // Every radix pass scans the same number of buckets. Configure the shared
    // prefix graph once, and reuse the complete dispatch list until it changes.
    this.appendPrefixNodes(prefixCount, prefixNodes);

    for (const pass of this.passes) {
      pass.histogram.dispatchSize = dispatchSize;
      pass.reorder.dispatchSize = dispatchSize;
      nodes.push(pass.histogram, ...prefixNodes, pass.reorder);
    }

    this.dispatchWorkgroups = workgroupCount;
    this.dispatchNodes = nodes;
    return nodes;
  }

  dispose() {
    for (const node of this.nodes) node.dispose();
    for (const level of this.prefixLevels) {
      level.blockSums.value.dispose();
    }
    this.blockSums.value.dispose();
    for (const buffer of this.keys) buffer.value.dispose();
    for (const buffer of this.values) buffer.value.dispose();
    this.capacity = 0;
  }
}
