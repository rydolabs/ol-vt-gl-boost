export class GeometryAllocator {
  constructor({ initialCapacity = 64 * 1024, alignment = 16, growthFactor = 2 } = {}) {
    this.alignment = Math.max(1, alignment | 0);
    this.growthFactor = Math.max(1.25, Number(growthFactor) || 2);
    this.initialCapacity = this._align(Math.max(this.alignment, initialCapacity | 0));
    this.capacity = this.initialCapacity;
    this.allocations = new Map();
    this.freeList = [{ offset: 0, size: this.capacity }];
    this.growthCount = 0;
    this.freeListReuseCount = 0;
    this.compactionCount = 0;
    this.compactionMovedBytes = 0;
    this.shrinkCount = 0;
    this.topologyVersion = 0;
  }

  _align(size) { return Math.ceil(Math.max(0, size) / this.alignment) * this.alignment; }

  _insertFree(block) {
    if (!block || block.size <= 0) return;
    this.freeList.push(block);
    this.freeList.sort((a, b) => a.offset - b.offset);
    const merged = [];
    for (const cur of this.freeList) {
      const last = merged[merged.length - 1];
      if (last && last.offset + last.size >= cur.offset) {
        const end = Math.max(last.offset + last.size, cur.offset + cur.size);
        last.size = end - last.offset;
      } else merged.push({ ...cur });
    }
    this.freeList = merged;
  }

  _grow(minAdditional) {
    const needed = this._align(minAdditional);
    const oldCapacity = this.capacity;
    let next = this._align(Math.ceil(oldCapacity * this.growthFactor));
    if (next - oldCapacity < needed) next = this._align(oldCapacity + needed);
    this.capacity = next;
    this.growthCount++;
    this._insertFree({ offset: oldCapacity, size: next - oldCapacity });
  }

  allocate(id, requestedSize) {
    if (this.allocations.has(id)) throw new Error(`allocation already exists: ${id}`);
    const size = this._align(Math.max(1, requestedSize | 0));
    let idx = this.freeList.findIndex(b => b.size >= size);
    if (idx < 0) {
      this._grow(size);
      idx = this.freeList.findIndex(b => b.size >= size);
    } else if (this.freeList[idx].offset !== 0 || this.allocations.size > 0) {
      this.freeListReuseCount++;
    }
    const block = this.freeList[idx];
    const allocation = { id, offset: block.offset, size, requestedSize: Math.max(1, requestedSize | 0) };
    if (block.size === size) this.freeList.splice(idx, 1);
    else { block.offset += size; block.size -= size; }
    this.allocations.set(id, allocation);
    this.topologyVersion++;
    return { ...allocation };
  }

  free(id) {
    const allocation = this.allocations.get(id);
    if (!allocation) throw new Error(`free of unknown allocation: ${id}`);
    this.allocations.delete(id);
    this._insertFree({ offset: allocation.offset, size: allocation.size });
    this.topologyVersion++;
    return { ...allocation };
  }

  resize(id, requestedSize) {
    const current = this.allocations.get(id);
    if (!current) return { allocation: this.allocate(id, requestedSize), moved: false, movedBytes: 0 };
    const size = this._align(Math.max(1, requestedSize | 0));
    if (size <= current.size) {
      const tail = current.size - size;
      current.requestedSize = Math.max(1, requestedSize | 0);
      if (tail >= this.alignment) {
        current.size = size;
        this._insertFree({ offset: current.offset + size, size: tail });
        this.topologyVersion++;
      }
      return { allocation: { ...current }, moved: false, movedBytes: 0 };
    }
    const old = { ...current };
    this.free(id);
    const next = this.allocate(id, requestedSize);
    return { allocation: next, moved: next.offset !== old.offset, movedBytes: Math.min(old.requestedSize, next.requestedSize) };
  }

  get(id) { const a = this.allocations.get(id); return a ? { ...a } : null; }


  _rebuildFreeListFromAllocations() {
    const live = [...this.allocations.values()].sort((a, b) => a.offset - b.offset);
    const free = [];
    let cursor = 0;
    for (const a of live) {
      if (a.offset > cursor) free.push({ offset: cursor, size: a.offset - cursor });
      cursor = Math.max(cursor, a.offset + a.size);
    }
    if (cursor < this.capacity) free.push({ offset: cursor, size: this.capacity - cursor });
    this.freeList = free;
  }

  createCompactionPlan() {
    const live = [...this.allocations.values()].sort((a, b) => a.offset - b.offset);
    let cursor = 0, movedBytes = 0;
    const moves = [];
    for (const allocation of live) {
      const nextOffset = this._align(cursor);
      if (allocation.offset !== nextOffset) {
        moves.push({ id: allocation.id, from: allocation.offset, to: nextOffset, size: allocation.requestedSize, allocatedSize: allocation.size });
        movedBytes += allocation.requestedSize;
      }
      cursor = nextOffset + allocation.size;
    }
    return { topologyVersion: this.topologyVersion, moves, movedBytes };
  }

  applyCompactionMoves(moves) {
    let movedBytes = 0;
    for (const move of moves || []) {
      const allocation = this.allocations.get(move.id);
      if (!allocation) throw new Error(`compaction move missing allocation: ${move.id}`);
      if (allocation.offset !== move.from) throw new Error(`stale compaction move: ${move.id} expected ${move.from} got ${allocation.offset}`);
      if (move.to > move.from) throw new Error(`incremental compaction must move left: ${move.id}`);
      allocation.offset = move.to;
      movedBytes += allocation.requestedSize;
    }
    this._rebuildFreeListFromAllocations();
    return { movedBytes };
  }

  finishIncrementalCompaction(movedBytes = 0) {
    this.compactionCount++;
    this.compactionMovedBytes += movedBytes;
    return { movedBytes };
  }

  compact() {
    const live = [...this.allocations.values()].sort((a, b) => a.offset - b.offset);
    let cursor = 0, movedBytes = 0;
    const moves = [];
    for (const allocation of live) {
      const nextOffset = this._align(cursor);
      if (allocation.offset !== nextOffset) {
        moves.push({ id: allocation.id, from: allocation.offset, to: nextOffset, size: allocation.requestedSize });
        movedBytes += allocation.requestedSize;
        allocation.offset = nextOffset;
      }
      cursor = allocation.offset + allocation.size;
    }
    this.freeList = cursor < this.capacity ? [{ offset: cursor, size: this.capacity - cursor }] : [];
    this.compactionCount++;
    this.compactionMovedBytes += movedBytes;
    return { moves, movedBytes };
  }


  trim({ minCapacity = this.initialCapacity, headroomBytes = 0 } = {}) {
    const liveEnd = [...this.allocations.values()].reduce((m, a) => Math.max(m, a.offset + a.size), 0);
    const target = this._align(Math.max(this.alignment, minCapacity | 0, liveEnd + Math.max(0, headroomBytes | 0)));
    if (target >= this.capacity) return { trimmed: false, oldCapacity: this.capacity, capacity: this.capacity, freedBytes: 0 };
    const oldCapacity = this.capacity;
    this.capacity = target;
    this.freeList = this.freeList
      .filter(b => b.offset < target)
      .map(b => ({ offset: b.offset, size: Math.min(b.size, target - b.offset) }))
      .filter(b => b.size > 0);
    this.shrinkCount++;
    return { trimmed: true, oldCapacity, capacity: target, freedBytes: oldCapacity - target };
  }

  stats() {
    const allocatedBytes = [...this.allocations.values()].reduce((s, a) => s + a.size, 0);
    const liveBytes = [...this.allocations.values()].reduce((s, a) => s + a.requestedSize, 0);
    const freeBytes = this.freeList.reduce((s, b) => s + b.size, 0);
    const largestFreeBlock = this.freeList.reduce((m, b) => Math.max(m, b.size), 0);
    const fragmentationRatio = freeBytes ? 1 - largestFreeBlock / freeBytes : 0;
    return {
      capacity: this.capacity,
      allocationCount: this.allocations.size,
      allocatedBytes,
      liveBytes,
      freeBytes,
      largestFreeBlock,
      fragmentationRatio,
      allocatorGrowthCount: this.growthCount,
      allocatorShrinkCount: this.shrinkCount,
      freeListReuseCount: this.freeListReuseCount,
      compactionCount: this.compactionCount,
      compactionMovedBytes: this.compactionMovedBytes,
      topologyVersion: this.topologyVersion,
    };
  }
}
