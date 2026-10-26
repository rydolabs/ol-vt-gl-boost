import {encodeTileWorkerTask,encodeTileLayerGroupTask} from './DirectTileEncodeTask.js';
self.onmessage=(event)=>{
  const {id,task}=event.data||{};
  try{
    const {transfer,...answer}=(Array.isArray(task?.layers)?encodeTileLayerGroupTask(task):encodeTileWorkerTask(task));
    self.postMessage({type:'result',id,ok:true,answer},transfer);
  }catch(error){
    self.postMessage({type:'result',id,ok:false,error:String(error?.stack||error)});
  }
};
self.postMessage({type:'ready'});
