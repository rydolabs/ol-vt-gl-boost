import {parentPort} from 'node:worker_threads';
import {encodeTileWorkerTask,encodeTileLayerGroupTask} from './DirectTileEncodeTask.js';
parentPort.on('message',({id,task}={})=>{
  try{
    const {transfer,...answer}=(Array.isArray(task?.layers)?encodeTileLayerGroupTask(task):encodeTileWorkerTask(task));
    parentPort.postMessage({type:'result',id,ok:true,answer},transfer);
  }catch(error){parentPort.postMessage({type:'result',id,ok:false,error:String(error?.stack||error)});}
});
parentPort.postMessage({type:'ready'});
