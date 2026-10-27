import { RendererKernel } from './core/RendererKernel.js';
import { GeometryStore } from './core/stores.js';
import { StyleStore } from './core/stores.js';
import { RenderCompiler } from './core/RenderCompiler.js';
import { DirtyTracker } from './core/stores.js';
import { RenderReferenceStore } from './core/schedule.js';
import { PolygonRenderer } from './renderers.js';
import { LineRenderer } from '../gl/LineRenderer.js';
import { PointRenderer } from './renderers.js';
import { ResourceManager } from '../gl/ResourceManager.js';
import { RenderSchedule } from './core/schedule.js';

/**
 * Default composition root.
 *
 * OpenLayers or another host engine should depend on this public facade (or
 * RendererKernel via its own composition root), never on allocator/backend
 * internals. Every concrete dependency can be replaced through `components`.
 */
export class WebGLVectorRenderer extends RendererKernel {
  constructor({ backend, policy = 'three-pass', lineBounds = null, shareIdenticalStyleBuffers = false, bulkLineStreamThreshold = 64, lineGpuHeadroomFactor = 1, resourceManager = null, components = {} }) {
    const geometryStore = components.geometryStore || new GeometryStore();
    const styleStore = components.styleStore || new StyleStore();
    const compiler = components.compiler || new RenderCompiler({ policy });
    const dirtyTracker = components.dirtyTracker || new DirtyTracker();
    const referenceStore = components.referenceStore || new RenderReferenceStore([]);
    const resources = resourceManager || components.resourceManager || new ResourceManager();
    const renderSchedule = components.renderSchedule || new RenderSchedule();
    const renderers = components.renderers || {
      polygon: new PolygonRenderer(),
      line: new LineRenderer({ bounds: lineBounds, shareIdenticalStyleBuffers, bulkLineStreamThreshold, gpuCapacityHeadroomFactor:lineGpuHeadroomFactor }),
      point: new PointRenderer(),
    };
    super({ backend, geometryStore, styleStore, compiler, dirtyTracker, referenceStore, resourceManager: resources, renderers, renderSchedule });
  }
}
