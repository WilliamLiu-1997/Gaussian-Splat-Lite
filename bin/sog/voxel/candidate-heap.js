class GroupCandidateHeap {
  // Neighbors can change the best candidate of a group anywhere in the heap.
  constructor(capacity) {
    this.groups = new Int32Array(capacity);
    this.indices = new Int32Array(capacity).fill(-1);
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

  set(group, row, distance, weight, priority, radius) {
    this.rows[group] = row;
    this.distances[group] = distance;
    this.weights[group] = weight;
    this.priorities[group] = priority;
    this.radii[group] = radius;

    const index = this.indices[group];
    this.place(group, index < 0 ? this.length++ : index);
  }

  remove(group) {
    const index = this.indices[group];
    if (index < 0) return;
    this.indices[group] = -1;
    const last = --this.length;
    if (index !== last) this.place(this.groups[last], index);
  }

  place(group, start) {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const other = this.groups[parent];
      if (!this.before(group, other)) break;
      this.groups[index] = other;
      this.indices[other] = index;
      index = parent;
    }
    while (index * 2 + 1 < this.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.length &&
        this.before(this.groups[child + 1], this.groups[child])
      )
        child++;
      if (!this.before(this.groups[child], group)) break;
      this.groups[index] = this.groups[child];
      this.indices[this.groups[child]] = index;
      index = child;
    }
    this.groups[index] = group;
    this.indices[group] = index;
  }
}

export { GroupCandidateHeap };
