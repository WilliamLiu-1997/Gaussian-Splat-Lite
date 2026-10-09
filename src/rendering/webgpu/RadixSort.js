import * as N from "three/tsl";
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
} from "three/webgpu";
/** Values of the GPU mode uniform. */
export const RADIX_SORT_MODE_IDS = {
  full: 0,
  fast: 1,
  front: 2,
};
/**
 * Input key of an absent record. The first pass drops these records and
 * compacts the rest in input order, so the output order is deterministic.
 */
export const INVALID_SORT_KEY = 0xffffffff;
const RADIX_BITS = 8;
const RADIX_BUCKETS = 1 << RADIX_BITS;
const RADIX_PASSES = 32 / RADIX_BITS;
// Full 32-bit/fast 24-bit keys sort back-to-front;
// 16-bit keys sort stochastic draws front-to-back.
const MODE_PASSES = {
  full: RADIX_PASSES,
  fast: 24 / RADIX_BITS,
  front: 16 / RADIX_BITS,
};
const MODES = Object.keys(MODE_PASSES);
const WORKGROUP_SIZE = 256;
const ELEMENTS_PER_THREAD = 8;
const ELEMENTS_PER_WORKGROUP = WORKGROUP_SIZE * ELEMENTS_PER_THREAD;
const PREFIX_ITEMS_PER_WORKGROUP = WORKGROUP_SIZE * 2;
const PREFIX_LEVELS = 3;
function storage(buffer, name) {
  return N.storage(buffer.value, "uint")
    .setName(name)
    .onObjectUpdate(() => buffer.value);
}
function makeBuffer(count) {
  return new StorageBufferAttribute(new Uint32Array(count), 1);
}
function makeBufferRef(count) {
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
}) {
  const inputKeys = storage(input, "gslRadixInputKeys").toReadOnly();
  const sums = storage(blockSums, "gslRadixBlockSums");
  const bit = N.uint(bitOffset);
  const histogram = N.workgroupArray("uint", RADIX_BUCKETS)
    .toAtomic()
    .setName("gslRadixHistogram");
  return N.Fn(() => {
    const tid = N.invocationLocalIndex;
    const workgroup = workgroupIndex();
    N.atomicStore(histogram.element(tid), N.uint(0));
    N.workgroupBarrier();
    N.Loop(
      {
        start: N.uint(0),
        end: N.uint(ELEMENTS_PER_THREAD),
        type: "uint",
        condition: "<",
      },
      ({ i: round }) => {
        const index = workgroup
          .mul(ELEMENTS_PER_WORKGROUP)
          .add(round.mul(WORKGROUP_SIZE))
          .add(tid);
        N.If(index.lessThan(elementCount), () => {
          const key = inputKeys.element(index).toVar();
          const tally = () => {
            const digit = key.shiftRight(bit).bitAnd(RADIX_BUCKETS - 1);
            N.atomicAdd(histogram.element(digit), N.uint(1));
          };
          // The first pass drops absent records.
          if (bitOffset === 0)
            N.If(key.notEqual(N.uint(INVALID_SORT_KEY)), tally);
          else tally();
        });
      },
    );
    N.workgroupBarrier();
    sums
      .element(tid.mul(workgroupCount).add(workgroup))
      .assign(N.atomicLoad(histogram.element(tid)));
  })()
    .computeKernel([WORKGROUP_SIZE])
    .setName("Splat radix histogram");
}
function makePrefixScanTask(itemsBuffer, blockSumsBuffer, elementCount) {
  const items = storage(itemsBuffer, "gslPrefixItems");
  const blockSums = storage(blockSumsBuffer, "gslPrefixBlockSums");
  const temp = N.workgroupArray("uint", PREFIX_ITEMS_PER_WORKGROUP).setName(
    "gslPrefixTemp",
  );
  return N.Fn(() => {
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
    // Expand the fixed scan levels while building the shader.
    for (
      let distance = PREFIX_ITEMS_PER_WORKGROUP >> 1, offset = 1;
      distance > 0;
      distance >>= 1, offset <<= 1
    ) {
      N.workgroupBarrier();
      N.If(tid.lessThan(distance), () => {
        const a = tid.mul(2).add(1).mul(offset).sub(1);
        const b = tid.mul(2).add(2).mul(offset).sub(1);
        temp.element(b).addAssign(temp.element(a));
      });
    }
    N.workgroupBarrier();
    N.If(tid.equal(0), () => {
      blockSums
        .element(workgroup)
        .assign(temp.element(N.uint(PREFIX_ITEMS_PER_WORKGROUP - 1)));
      temp.element(N.uint(PREFIX_ITEMS_PER_WORKGROUP - 1)).assign(0);
    });
    for (
      let distance = 1, offset = PREFIX_ITEMS_PER_WORKGROUP >> 1;
      distance < PREFIX_ITEMS_PER_WORKGROUP;
      distance <<= 1, offset >>= 1
    ) {
      N.workgroupBarrier();
      N.If(tid.lessThan(distance), () => {
        const a = tid.mul(2).add(1).mul(offset).sub(1);
        const b = tid.mul(2).add(2).mul(offset).sub(1);
        const value = temp.element(a).toVar();
        temp.element(a).assign(temp.element(b));
        temp.element(b).addAssign(value);
      });
    }
    N.workgroupBarrier();
    N.If(first.lessThan(elementCount), () => {
      items.element(first).assign(temp.element(tid.mul(2)));
    });
    N.If(second.lessThan(elementCount), () => {
      items.element(second).assign(temp.element(tid.mul(2).add(1)));
    });
  })()
    .computeKernel([WORKGROUP_SIZE])
    .setName("Splat radix prefix scan");
}
function makePrefixAddTask(itemsBuffer, blockSumsBuffer, elementCount) {
  const items = storage(itemsBuffer, "gslPrefixItems");
  const blockSums = storage(blockSumsBuffer, "gslPrefixBlockSums").toReadOnly();
  return N.Fn(() => {
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
    .computeKernel([WORKGROUP_SIZE])
    .setName("Splat radix prefix add");
}
function makeReorderTask({
  inputKeysAttribute,
  outputKeysAttribute,
  inputValuesAttribute,
  outputValuesAttribute,
  prefixAttribute,
  elementCount,
  bitOffset,
  lastPass,
  workgroupCount,
}) {
  const inputKeys = storage(
    inputKeysAttribute,
    "gslRadixInputKeys",
  ).toReadOnly();
  const outputKeys = storage(outputKeysAttribute, "gslRadixOutputKeys");
  const inputValues = storage(
    inputValuesAttribute,
    "gslRadixInputValues",
  ).toReadOnly();
  const outputValues = storage(outputValuesAttribute, "gslRadixOutputValues");
  const prefix = storage(prefixAttribute, "gslRadixPrefix").toReadOnly();
  const bitOffsetNode = N.uint(bitOffset);
  // Shared masks use [word][bucket] for the parallel bucket scan.
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
    digitOffsets
      .element(tid)
      .assign(prefix.element(tid.mul(workgroupCount).add(workgroup)));
    // Each thread clears one mask word per group of WORKGROUP_SIZE words.
    for (let offset = 0; offset < RADIX_BUCKETS * 8; offset += WORKGROUP_SIZE)
      N.atomicStore(digitMasks.element(tid.add(offset)), N.uint(0));
    N.workgroupBarrier();
    N.Loop(
      {
        start: N.uint(0),
        end: N.uint(ELEMENTS_PER_THREAD),
        type: "uint",
        condition: "<",
      },
      ({ i: round }) => {
        const index = workgroup
          .mul(ELEMENTS_PER_WORKGROUP)
          .add(round.mul(WORKGROUP_SIZE))
          .add(tid);
        const valid = index.lessThan(elementCount).toVar();
        const key = N.uint(0).toVar();
        const digit = N.uint(0).toVar();
        const value = N.uint(0).toVar();
        N.If(valid, () => {
          key.assign(inputKeys.element(index));
          // Absent records take no rank or output slot.
          if (bitOffset === 0)
            valid.assign(key.notEqual(N.uint(INVALID_SORT_KEY)));
        });
        N.If(valid, () => {
          digit.assign(key.shiftRight(bitOffsetNode).bitAnd(RADIX_BUCKETS - 1));
          value.assign(inputValues.element(index));
          N.atomicOr(
            digitMasks.element(word.mul(RADIX_BUCKETS).add(digit)),
            N.uint(1).shiftLeft(bit),
          );
        });
        N.workgroupBarrier();
        N.If(valid, () => {
          const sortedIndex = digitOffsets.element(digit).toVar();
          N.Loop(
            {
              start: N.uint(0),
              end: word,
              type: "uint",
              condition: "<",
            },
            ({ i: precedingWord }) => {
              sortedIndex.addAssign(
                N.countOneBits(
                  N.atomicLoad(
                    digitMasks.element(
                      precedingWord.mul(RADIX_BUCKETS).add(digit),
                    ),
                  ),
                ),
              );
            },
          );
          const lowerBits = N.uint(1).shiftLeft(bit).sub(1);
          sortedIndex.addAssign(
            N.countOneBits(
              N.atomicLoad(
                digitMasks.element(word.mul(RADIX_BUCKETS).add(digit)),
              ).bitAnd(lowerBits),
            ),
          );
          // Boolean cases are resolved while building the shader.
          if (lastPass === false) {
            outputKeys.element(sortedIndex).assign(key);
          } else if (lastPass !== true) {
            N.If(lastPass.not(), () => {
              outputKeys.element(sortedIndex).assign(key);
            });
          }
          outputValues.element(sortedIndex).assign(value);
        });
        N.If(round.lessThan(ELEMENTS_PER_THREAD - 1), () => {
          // Finish all rank reads before updating offsets and clearing masks.
          N.workgroupBarrier();
          const count = N.uint(0).toVar();
          N.Loop(
            {
              start: N.uint(0),
              end: N.uint(8),
              type: "uint",
              condition: "<",
            },
            ({ i: maskWord }) => {
              const maskIndex = maskWord.mul(RADIX_BUCKETS).add(tid);
              count.addAssign(
                N.countOneBits(
                  N.atomicAnd(digitMasks.element(maskIndex), N.uint(0)),
                ),
              );
            },
          );
          digitOffsets.element(tid).addAssign(count);
          N.workgroupBarrier();
        });
      },
    );
  })()
    .computeKernel([WORKGROUP_SIZE])
    .setName("Splat radix reorder");
}
/**
 * Stable 16-, 24- or 32-bit radix sort. The first pass compacts records whose
 * key is not INVALID_SORT_KEY, with the values the caller wrote to
 * `inputValues`. Borrows and overwrites input keys; their owner manages storage.
 */
export class WebGPURadixSort {
  constructor(capacity, inputKeys, options) {
    this.elementCount = N.uniform(0, "uint");
    // Count, padded histogram workgroups, and item count for each prefix level.
    this.counts = makeBufferRef(PREFIX_LEVELS + 2);
    this.sortDispatch = new IndirectStorageBufferAttribute(
      new Uint32Array(3),
      1,
    );
    this.prefixLevels = [];
    // Mode of the last prepared sort; its pass count selects the output buffer.
    this.mode = "full";
    this.maxWorkgroups = options.maxComputeWorkgroupsPerDimension;
    this.maxCapacity = Math.min(
      0xffffffff - ELEMENTS_PER_WORKGROUP + 1,
      Math.floor(options.maxStorageBufferBindingSize / 4),
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
    const counts = storage(this.counts, "gslRadixCounts").toReadOnly();
    this.createPrefixLevels(histogramCount, counts);
    // The first pass reads every input record; later passes read only the
    // valid records it compacted.
    const inputSetup = this.makeSetupTask(
      this.elementCount,
      "Splat radix input setup",
    );
    const compactSetup = this.makeSetupTask(
      options.count.min(this.elementCount),
      "Splat radix compact setup",
    );
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
    this.nodes = [inputSetup, compactSetup, ...prefixNodes[PREFIX_LEVELS - 1]];
    // Per mode, the dispatch list for each prefix depth.
    this.dispatchNodes = {
      full: prefixNodes.map(() => [inputSetup]),
      fast: prefixNodes.map(() => [inputSetup]),
      front: prefixNodes.map(() => [inputSetup]),
    };
    for (let pass = 0; pass < RADIX_PASSES; pass++) {
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
        lastPass:
          pass === RADIX_PASSES - 1
            ? true
            : pass === MODE_PASSES.front - 1
              ? options.mode.equal(N.uint(RADIX_SORT_MODE_IDS.front))
              : pass === MODE_PASSES.fast - 1
                ? options.mode.equal(N.uint(RADIX_SORT_MODE_IDS.fast))
                : false,
      });
      histogram.dispatchSize = this.sortDispatch;
      reorder.dispatchSize = this.sortDispatch;
      this.nodes.push(histogram, reorder);
      for (let level = 0; level < PREFIX_LEVELS; level++) {
        const nodes = [histogram, ...prefixNodes[level], reorder];
        if (pass === 0) nodes.push(compactSetup);
        for (const mode of MODES)
          if (pass < MODE_PASSES[mode])
            this.dispatchNodes[mode][level].push(...nodes);
      }
    }
  }
  /** Values the caller writes for valid input records; sorting overwrites them. */
  get inputValues() {
    return this.values[0].value;
  }
  get ordering() {
    // Each pass writes the other value buffer.
    return this.values[MODE_PASSES[this.mode] & 1].value;
  }
  validateCapacity(capacity) {
    const required = Math.max(1, capacity);
    if (!Number.isSafeInteger(required) || required > this.maxCapacity) {
      throw new RangeError(
        `GPU radix sort capacity ${capacity} exceeds the device's scalar storage buffer capacity (${this.maxCapacity} splats)`,
      );
    }
    return required;
  }
  paddedWorkgroups(count, itemsPerWorkgroup) {
    const groups = Math.ceil(count / itemsPerWorkgroup);
    const width = Math.min(groups, this.maxWorkgroups);
    return width * Math.ceil(groups / this.maxWorkgroups);
  }
  makeSetupTask(inputCount, name) {
    const counts = storage(this.counts, "gslRadixCounts");
    const dispatchBuffers = [
      this.sortDispatch,
      ...this.prefixLevels.map((level) => level.dispatch),
    ].map((value, index) => storage({ value }, `gslRadixDispatch${index}`));
    const maxWorkgroups = N.uint(this.maxWorkgroups);
    return N.Fn(() => {
      const count = inputCount.toVar();
      counts.element(0).assign(count);
      let itemCount = count;
      for (let index = 0; index < dispatchBuffers.length; index++) {
        const itemsPerWorkgroup =
          index === 0 ? ELEMENTS_PER_WORKGROUP : PREFIX_ITEMS_PER_WORKGROUP;
        const groups = itemCount
          .add(itemsPerWorkgroup - 1)
          .div(N.uint(itemsPerWorkgroup))
          .toVar();
        const width = groups.min(maxWorkgroups).toVar();
        const height = groups
          .add(this.maxWorkgroups - 1)
          .div(maxWorkgroups)
          .max(N.uint(1))
          .toVar();
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
      .setName(name);
  }
  replaceBuffer(buffer, count) {
    if (buffer.value.count === count) return;
    const previous = buffer.value;
    buffer.value = makeBuffer(count);
    previous.dispose();
  }
  createPrefixLevels(itemCount, counts) {
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
  resize(capacity, shrinkResources = false) {
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
  /**
   * Prepare the persistent graph for this many input records. The GPU count
   * of valid records is clamped to it.
   */
  prepare(elementCount, mode) {
    if (
      !Number.isSafeInteger(elementCount) ||
      elementCount < 0 ||
      elementCount > this.capacity
    ) {
      throw new RangeError(
        "Sort count must be an integer within buffer capacity",
      );
    }
    this.mode = mode;
    if (elementCount === 0) return [];
    this.elementCount.value = elementCount;
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
    return this.dispatchNodes[mode][lastLevel];
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
