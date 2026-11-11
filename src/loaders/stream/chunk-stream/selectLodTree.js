/** Walk only the refinements reached by the shared distance/budget scale. */
export function selectLodTree(inputs, request) {
  const heap = [];
  const push = (item) => {
    let i = heap.length;
    heap.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].key <= item.key) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].key < heap[child].key)
          child++;
        if (last.key <= heap[child].key) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  const selected = new Map();
  let total = 0;
  const states = inputs.map((input, source) => {
    const settings = request.sources[source];
    return {
      ...input,
      source,
      settings,
      cameras: input.visibility.prepareCameras(
        request.view,
        settings.transform,
      ),
    };
  });
  const visit = (state, node, parentKey = Number.NEGATIVE_INFINITY) => {
    const { index, visibility, cameras, settings } = state;
    const distance = visibility.measure(
      node,
      cameras,
      request.lodBehindPenalty,
      request.lodDistanceShrink,
    );
    const level = index.ranges[node * 4];
    const key = Math.max(
      parentKey,
      Math.log(distance / settings.lodBaseDistance) -
        (level - 1) * Math.log(settings.lodMultiplier),
    );
    const item = { state, node, key, distance };
    if (
      index.childOffsets[node] !== index.childOffsets[node + 1] &&
      (request.splatBudgetMode !== "limit" || key < 0)
    )
      push(item);
    return item;
  };
  for (const state of states) {
    const { index, nodeBase } = state;
    for (const n of index.roots) {
      selected.set(nodeBase + n, visit(state, n));
      total += index.ranges[n * 4 + 3];
    }
  }
  while (heap.length) {
    const key = heap[0].key;
    const changes = [];
    let delta = 0;
    // Equal thresholds, including multiplier=1, change as one group.
    do {
      const item = pop();
      const { state, node } = item;
      const { index } = state;
      const children = [];
      delta -= index.ranges[node * 4 + 3];
      for (
        let i = index.childOffsets[node];
        i < index.childOffsets[node + 1];
        i++
      ) {
        const child = index.children[i];
        children.push(visit(state, child, key));
        delta += index.ranges[child * 4 + 3];
      }
      changes.push({ item, children });
    } while (heap.length && heap[0].key === key);
    if (total + delta > request.budget) break;
    total += delta;
    for (const { item, children } of changes) {
      const base = item.state.nodeBase;
      selected.delete(base + item.node);
      for (const child of children) selected.set(base + child.node, child);
    }
  }
  const ordered = [...selected.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      a.state.source - b.state.source ||
      a.node - b.node,
  );
  const result = new Uint32Array(ordered.length * 2);
  ordered.forEach(({ state, node }, i) =>
    result.set([state.settings.id, state.nodeBase + node], i * 2),
  );
  return result;
}
