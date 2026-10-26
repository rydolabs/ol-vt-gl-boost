const PASS = { polygon: 0, line: 1, point: 2 };

export class RenderCompiler {
  constructor({ policy = 'three-pass' } = {}) { this.policy = policy; }

  // Kernel render ordering needs the validated, sorted references, not the
  // contiguous physical draw-batch plan. Skipping that plan avoids allocating
  // one batch object/key/reference array for every noncontiguous geometry.
  order(references, geometryStore, styleStore) {
    return this.compile(references, geometryStore, styleStore, { orderedOnly: true }).ordered;
  }

  compile(references, geometryStore, styleStore, { orderedOnly = false } = {}) {
    const refs = references.filter(r => r.visible);
    const ordered = this.policy === 'three-pass'
      ? [...refs].sort((a,b) => PASS[a.geometryType] - PASS[b.geometryType] || a.order - b.order)
      : [...refs].sort((a,b) => a.order - b.order);

    const batches = [];
    for (const ref of ordered) {
      const g = geometryStore.get(ref.geometryId);
      const s = styleStore.get(ref.styleId);
      if (!g || !s) throw new Error('RenderReference points to missing geometry/style');
      if (orderedOnly) continue;
      const key = `${ref.geometryType}|${ref.styleId}|${s.textureKey ?? ''}`;
      const p = g.physical;
      const prev = batches[batches.length - 1];
      const contiguous = !!(prev && p && prev.lastPhysical && prev.lastPhysical.bufferId === p.bufferId && prev.lastPhysical.end === p.start);
      if (prev && prev.key === key && contiguous) {
        prev.references.push(ref);
        prev.lastPhysical = p;
        prev.count += p.count ?? 1;
      } else {
        batches.push({ key, geometryType: ref.geometryType, styleId: ref.styleId, references: [ref], firstPhysical: p, lastPhysical: p, count: p?.count ?? 1 });
      }
    }
    return { policy: this.policy, ordered, batches };
  }
}
