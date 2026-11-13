class GroupCandidateHeap {
  // At most one candidate per group; pop it before pushing its replacement.
  constructor(capacity) {
    this.groups = new Int32Array(capacity);
    this.rows = new Int32Array(capacity);
    this.distances = new Float64Array(capacity);
    this.weights = new Float64Array(capacity);
    this.priorities = new Float64Array(capacity);
    this.radii = new Float64Array(capacity);
    this.length = 0;
  }

  // Candidate data stays at its group index; only groups move in the heap.
  before(lhs, rhs) {
    if (this.priorities[lhs] !== this.priorities[rhs])
      return this.priorities[lhs] > this.priorities[rhs];
    if (this.weights[lhs] !== this.weights[rhs])
      return this.weights[lhs] > this.weights[rhs];
    if (this.distances[lhs] !== this.distances[rhs])
      return this.distances[lhs] > this.distances[rhs];
    if (this.radii[lhs] !== this.radii[rhs])
      return this.radii[lhs] > this.radii[rhs];
    if (this.rows[lhs] !== this.rows[rhs])
      return this.rows[lhs] > this.rows[rhs];
    return lhs < rhs;
  }

  push(group, row, distance, weight, priority, radius) {
    this.rows[group] = row;
    this.distances[group] = distance;
    this.weights[group] = weight;
    this.priorities[group] = priority;
    this.radii[group] = radius;

    let index = this.length++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(group, this.groups[parent])) break;
      this.groups[index] = this.groups[parent];
      index = parent;
    }
    this.groups[index] = group;
  }

  pop(out) {
    out.group = this.groups[0];
    out.row = this.rows[out.group];

    const last = --this.length;
    if (last === 0) return;

    const group = this.groups[last];
    let index = 0;
    while (index * 2 + 1 < this.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.length &&
        this.before(this.groups[child + 1], this.groups[child])
      )
        child++;
      if (!this.before(this.groups[child], group)) break;
      this.groups[index] = this.groups[child];
      index = child;
    }
    this.groups[index] = group;
  }
}

export { GroupCandidateHeap };
