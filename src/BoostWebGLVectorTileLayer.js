/**
 * Experimental R76 public layer name for migration from OpenLayers 10.10.0.
 *
 * Preserve the exact stock OL WebGLVectorTileLayer behavior and API: source,
 * style, variables, visibility, layer order, hit detection and lifecycle are
 * owned by OpenLayers. No per-layer GPU context is allocated here.
 *
 * BoostMap discovers this (and unmodified stock WebGLVectorTileLayer)
 * and uses a single shared OLVectorTileBoost engine for eligible scenes.
 *
 * With a plain ol/Map.js this class intentionally uses the normal OpenLayers
 * renderer. It does NOT silently activate a second GPU renderer.
 */
import WebGLVectorTileLayer from 'ol/layer/WebGLVectorTile.js';

/** @template T */
export class BoostWebGLVectorTileLayer extends WebGLVectorTileLayer {}

export default BoostWebGLVectorTileLayer;
