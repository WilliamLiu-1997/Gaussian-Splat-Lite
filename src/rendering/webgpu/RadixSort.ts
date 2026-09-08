import * as TSL from "three/tsl";
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
} from "three/webgpu";

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
type ValueGenerator = (index: TSLNode) => TSLNode;

export type WebGPURadixSortOptions = {
  /** GPU count of compact input records. Omit for the CPU-count interface. */
  count?: TSLNode;
  /** Payload of each compact input record. Defaults to its input index. */
  valueGenerator?: ValueGenerator;
  /** Optional final-pass write, compiled once with the persistent sort graph. */
  storeOrder?: (index: TSLNode, value: TSLNode) => void;
  maxComputeWorkgroupsPerDimension?: number;
  maxStorageBufferBindingSize?: number;
  maxBufferSize?: number;
};

type PrefixLevel = {
  scan: TSLNode;
  add: TSLNode | null;
  dispatch: IndirectStorageBufferAttribute;
  blockSums: BufferRef;
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

function workgroupIndex() {
  return N.workgroupId.y.mul(N.numWorkgroups.x).add(N.workgroupId.x);
}

function makeHistogramTask({
  input,
  blockSums,
  elementCount,
  bitOffset,
  workgroupCount,
}: {
  input: BufferRef;
  blockSums: BufferRef;
  elementCount: TSLNode;
  bitOffset: number;
  workgroupCount: TSLNode;
}) {
  const inputKeys = storage(input, "uint", "gslRadixInputKeys", true);
  const sums = storage(blockSums, "uint", "gslRadixBlockSums");
  const bit = N.uint(bitOffset);
  const histogram = N.workgroupArray("uint", RADIX_BUCKETS)
    .toAtomic()
    .setName("gslRadixHistogram");

  return N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = workgroupIndex();

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
          const key = inputKeys.element(index).toVar();
          const digit = key.shiftRight(bit).bitAnd(RADIX_BUCKETS - 1);
          N.atomicAdd(histogram.element(digit), N.uint(1));
        });
      },
    );

    N.workgroupBarrier();
    N.If(tid.lessThan(RADIX_BUCKETS), () => {
      sums
        .element(tid.mul(workgroupCount).add(workgroup))
        .assign(N.atomicLoad(histogram.element(tid)));
    });
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix histogram");
}

function makePrefixScanTask(
  itemsBuffer: BufferRef,
  blockSumsBuffer: BufferRef,
  elementCount: TSLNode,
) {
  const items = storage(itemsBuffer, "uint", "gslPrefixItems");
  const blockSums = storage(blockSumsBuffer, "uint", "gslPrefixBlockSums");
  const temp = N.workgroupArray("uint", PREFIX_ITEMS_PER_WORKGROUP).setName(
    "gslPrefixTemp",
  );

  const compute = N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = workgroupIndex();
    const first = workgroup.mul(PREFIX_ITEMS_PER_WORKGROUP).add(tid.mul(2));
    const second = first.add(1);

    temp.element(tid.mul(2)).assign(0);
    temp.element(tid.mul(2).add(1)).assign(0);
    N.If(first.lessThan(elementCount), () => {
      temp.element(tid.mul(2)).assign(items.element(first));
    });
    N.If(second.lessThan(elementCount), () => {
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
    N.If(first.lessThan(elementCount), () => {
      items.element(first).assign(temp.element(tid.mul(2)));
    });
    N.If(second.lessThan(elementCount), () => {
      items.element(second).assign(temp.element(tid.mul(2).add(1)));
    });
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix prefix scan");

  return compute;
}

function makePrefixAddTask(
  itemsBuffer: BufferRef,
  blockSumsBuffer: BufferRef,
  elementCount: TSLNode,
) {
  const items = storage(itemsBuffer, "uint", "gslPrefixItems");
  const blockSums = storage(
    blockSumsBuffer,
    "uint",
    "gslPrefixBlockSums",
    true,
  );

  const compute = N.Fn(() => {
    const workgroup = workgroupIndex();
    const first = workgroup
      .mul(PREFIX_ITEMS_PER_WORKGROUP)
      .add(N.invocationLocalIndex.mul(2));
    const second = first.add(1);
    N.If(first.lessThan(elementCount), () => {
      const value = blockSums.element(workgroup);
      items.element(first).addAssign(value);
      N.If(second.lessThan(elementCount), () => {
        items.element(second).addAssign(value);
      });
    });
  })()
    .compute([1, 1, 1], [WORKGROUP_SIZE])
    .setName("Splat radix prefix add");

  return compute;
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
  valueGenerator,
  workgroupCount,
  storeOrder,
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
  valueGenerator?: ValueGenerator;
  workgroupCount: TSLNode;
  storeOrder?: (index: TSLNode, value: TSLNode) => void;
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
  const digitMasks = N.workgroupArray("uint", RADIX_BUCKETS * 8)
    .toAtomic()
    .setName("gslRadixDigitMasks");
  const digitOffsets = N.workgroupArray("uint", RADIX_BUCKETS).setName(
    "gslRadixDigitOffsets",
  );

  return N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = workgroupIndex();
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
          else if (valueGenerator) value.assign(valueGenerator(index));
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
          const prefixIndex = digit.mul(workgroupCount).add(workgroup);
          const sortedIndex = prefix.element(prefixIndex).add(localPrefix);
          outputKeys?.element(sortedIndex).assign(key);
          outputValues.element(sortedIndex).assign(value);
          storeOrder?.(sortedIndex, value);
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

/** Stable 32-bit radix sort. Borrows and overwrites input keys; their owner manages storage. */
export class WebGPURadixSort {
  capacity: number;
  readonly maxCapacity: number;
  readonly nodes: TSLNode[];

  private readonly elementCount = mutableUniform(0, "uint");
  private readonly keys: [BufferRef, BufferRef];
  private readonly values: [BufferRef, BufferRef];
  private readonly blockSums: BufferRef;
  // Count, padded histogram workgroups, and item count for each prefix level.
  private readonly counts = makeBufferRef(PREFIX_LEVELS + 2);
  private readonly sortDispatch = new IndirectStorageBufferAttribute(
    new Uint32Array(3),
    1,
  );
  private readonly prefixLevels: PrefixLevel[] = [];
  private readonly maxWorkgroups: number;
  private readonly dispatchNodes: TSLNode[][];

  constructor(
    capacity: number,
    inputKeys: BufferRef,
    options: WebGPURadixSortOptions = {},
  ) {
    this.maxWorkgroups = options.maxComputeWorkgroupsPerDimension ?? 65535;
    this.maxCapacity = Math.min(
      0xffffffff - ELEMENTS_PER_WORKGROUP + 1,
      Math.floor(
        (options.maxStorageBufferBindingSize ?? Number.POSITIVE_INFINITY) / 4,
      ),
      Math.floor((options.maxBufferSize ?? Number.POSITIVE_INFINITY) / 4),
    );
    const safeCapacity = this.validateCapacity(capacity);
    this.capacity = safeCapacity;
    // Projection fills the borrowed buffer before each sort. Reuse it for
    // ping-pong instead of allocating and copying another full set of keys.
    this.keys = [inputKeys, makeBufferRef(safeCapacity)];
    this.values = [makeBufferRef(safeCapacity), makeBufferRef(safeCapacity)];

    const histogramCount =
      RADIX_BUCKETS *
      this.paddedWorkgroups(safeCapacity, ELEMENTS_PER_WORKGROUP);
    this.blockSums = makeBufferRef(histogramCount);
    const counts = storage(this.counts, "uint", "gslRadixCounts", true);
    this.createPrefixLevels(histogramCount, counts);
    const setup = this.makeSetupTask(options.count);
    // Prebuild dispatch lists for every supported prefix depth. Choosing a
    // smaller list only omits work; it never creates or recompiles a node.
    const prefixNodes = this.prefixLevels.map((_, lastLevel) => {
      const nodes = this.prefixLevels
        .slice(0, lastLevel + 1)
        .map((level) => level.scan);
      for (let index = lastLevel - 1; index >= 0; index--) {
        const add = this.prefixLevels[index].add;
        if (add) nodes.push(add);
      }
      return nodes;
    });
    this.nodes = [setup, ...prefixNodes[PREFIX_LEVELS - 1]];
    this.dispatchNodes = prefixNodes.map(() => [setup]);
    for (let pass = 0; pass < RADIX_PASSES; pass++) {
      const firstPass = pass === 0;
      const inputIndex = pass & 1;
      const outputIndex = inputIndex ^ 1;
      const histogram = makeHistogramTask({
        input: this.keys[inputIndex],
        blockSums: this.blockSums,
        elementCount: counts.element(0),
        workgroupCount: counts.element(1),
        bitOffset: pass * RADIX_BITS,
      });
      const reorder = makeReorderTask({
        inputKeysAttribute: this.keys[inputIndex],
        outputKeysAttribute: this.keys[outputIndex],
        inputValuesAttribute: this.values[inputIndex],
        outputValuesAttribute: this.values[outputIndex],
        prefixAttribute: this.blockSums,
        elementCount: counts.element(0),
        workgroupCount: counts.element(1),
        bitOffset: pass * RADIX_BITS,
        firstPass,
        lastPass: pass === RADIX_PASSES - 1,
        valueGenerator: options.valueGenerator,
        storeOrder: pass === RADIX_PASSES - 1 ? options.storeOrder : undefined,
      });
      histogram.dispatchSize = this.sortDispatch;
      reorder.dispatchSize = this.sortDispatch;
      this.nodes.push(histogram, reorder);
      for (let level = 0; level < PREFIX_LEVELS; level++) {
        this.dispatchNodes[level].push(
          histogram,
          ...prefixNodes[level],
          reorder,
        );
      }
    }
  }

  get ordering() {
    // An even pass count leaves the final values in the first ping-pong buffer.
    return this.values[RADIX_PASSES & 1].value;
  }

  private validateCapacity(capacity: number) {
    const required = Math.max(1, capacity);
    if (!Number.isSafeInteger(required) || required > this.maxCapacity) {
      throw new RangeError(
        `GPU radix sort capacity ${capacity} exceeds the device's scalar storage buffer capacity (${this.maxCapacity} splats)`,
      );
    }
    return required;
  }

  private paddedWorkgroups(count: number, itemsPerWorkgroup: number) {
    const groups = Math.ceil(count / itemsPerWorkgroup);
    const width = Math.min(groups, this.maxWorkgroups);
    return Math.max(1, width * Math.ceil(groups / this.maxWorkgroups));
  }

  private makeSetupTask(gpuCount?: TSLNode) {
    const counts = storage(this.counts, "uint", "gslRadixCounts");
    const dispatchBuffers = [
      this.sortDispatch,
      ...this.prefixLevels.map((level) => level.dispatch),
    ].map((value, index) =>
      storage({ value }, "uint", `gslRadixDispatch${index}`),
    );
    const maxWorkgroups = N.uint(this.maxWorkgroups);

    return N.Fn(() => {
      const count = N.min(
        gpuCount ?? this.elementCount.node,
        this.elementCount.node,
      ).toVar();
      counts.element(0).assign(count);
      let itemCount = count;
      for (let index = 0; index < dispatchBuffers.length; index++) {
        const itemsPerWorkgroup =
          index === 0 ? ELEMENTS_PER_WORKGROUP : PREFIX_ITEMS_PER_WORKGROUP;
        const groups = itemCount
          .add(itemsPerWorkgroup - 1)
          .div(N.uint(itemsPerWorkgroup))
          .toVar();
        const width = N.min(groups, maxWorkgroups).toVar();
        const height = N.max(
          groups.add(this.maxWorkgroups - 1).div(maxWorkgroups),
          N.uint(1),
        ).toVar();
        const dispatch = dispatchBuffers[index];
        dispatch.element(0).assign(width);
        dispatch.element(1).assign(height);
        dispatch.element(2).assign(1);
        // Include the empty tail of a 2D dispatch in the histogram/prefix
        // layout. Every workgroup can then execute barriers unconditionally.
        const paddedGroups = width.mul(height).toVar();
        if (index === 0) {
          counts.element(1).assign(paddedGroups);
          itemCount = paddedGroups.mul(RADIX_BUCKETS).toVar();
        } else {
          itemCount = paddedGroups;
        }
        if (index < PREFIX_LEVELS) counts.element(index + 2).assign(itemCount);
      }
    })()
      .compute(1, [1])
      .setName("Splat radix indirect setup");
  }

  private replaceBuffer(buffer: BufferRef, count: number) {
    const nextCount = Math.max(1, count);
    if (buffer.value.count === nextCount) return;

    const previous = buffer.value;
    buffer.value = makeBuffer(nextCount);
    previous.dispose();
  }

  private createPrefixLevels(itemCount: number, counts: TSLNode) {
    let items = this.blockSums;
    let currentCount = itemCount;

    for (let levelIndex = 0; levelIndex < PREFIX_LEVELS; levelIndex++) {
      const blockCount = this.paddedWorkgroups(
        currentCount,
        PREFIX_ITEMS_PER_WORKGROUP,
      );
      const blockSums = makeBufferRef(blockCount);
      const dispatch = new IndirectStorageBufferAttribute(
        new Uint32Array(3),
        1,
      );
      const elementCount = counts.element(levelIndex + 2);
      const scan = makePrefixScanTask(items, blockSums, elementCount);
      const add =
        levelIndex < PREFIX_LEVELS - 1
          ? makePrefixAddTask(items, blockSums, elementCount)
          : null;
      scan.dispatchSize = dispatch;
      if (add) add.dispatchSize = dispatch;
      this.prefixLevels.push({ scan, add, dispatch, blockSums });
      items = blockSums;
      currentCount = blockCount;
    }
  }

  resize(capacity: number, shrinkResources = false) {
    const requiredCapacity = this.validateCapacity(capacity);
    if (!shrinkResources && requiredCapacity <= this.capacity) return;
    if (requiredCapacity === this.capacity) return;

    this.replaceBuffer(this.keys[1], requiredCapacity);
    for (const buffer of this.values)
      this.replaceBuffer(buffer, requiredCapacity);

    let itemCount =
      RADIX_BUCKETS *
      this.paddedWorkgroups(requiredCapacity, ELEMENTS_PER_WORKGROUP);
    this.replaceBuffer(this.blockSums, itemCount);
    for (const level of this.prefixLevels) {
      itemCount = this.paddedWorkgroups(itemCount, PREFIX_ITEMS_PER_WORKGROUP);
      this.replaceBuffer(level.blockSums, itemCount);
    }
    this.capacity = requiredCapacity;
  }

  /** Prepare the persistent graph; GPU count is clamped to this input bound. */
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
    // The CPU knows an upper bound, while the live count stays on the GPU.
    // Include 2D dispatch padding just as the GPU setup does, so every possible
    // live count fits the selected hierarchy without a count readback.
    let items =
      RADIX_BUCKETS *
      this.paddedWorkgroups(elementCount, ELEMENTS_PER_WORKGROUP);
    let lastLevel = 0;
    while (lastLevel < PREFIX_LEVELS - 1) {
      items = this.paddedWorkgroups(items, PREFIX_ITEMS_PER_WORKGROUP);
      if (items === 1) break;
      lastLevel++;
    }
    return this.dispatchNodes[lastLevel];
  }

  dispose() {
    for (const node of this.nodes) node.dispose();
    for (const level of this.prefixLevels) {
      level.blockSums.value.dispose();
      level.dispatch.dispose();
    }
    this.sortDispatch.dispose();
    this.counts.value.dispose();
    this.blockSums.value.dispose();
    this.keys[1].value.dispose();
    for (const buffer of this.values) buffer.value.dispose();
    this.capacity = 0;
  }
}
