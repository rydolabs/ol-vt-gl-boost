export class TileResourceStore {
  constructor(resourceManager, geometryStore) { this.resourceManager = resourceManager; this.geometryStore = geometryStore; }
  enter(tileId, geometryIds) { this.resourceManager.setTile(String(tileId), geometryIds, this.geometryStore); }
  leave(tileId) { this.resourceManager.removeTile(String(tileId)); }
  replace(tileId, geometryIds) { this.enter(tileId, geometryIds); }
}
