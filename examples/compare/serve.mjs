/** Minimal local-only static server for examples, no npm server dependency. */
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';

const root=resolve(import.meta.dirname,'../..');
const port=Number(process.env.OLVT_EXAMPLE_PORT||4173);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid OLVT_EXAMPLE_PORT');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8',
  '.pbf':'application/octet-stream','.css':'text/css; charset=utf-8'};
const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.writeHead(302,{Location:'/examples/compare/'});res.end();return;}
    const normalized=pathname==='/examples/compare/'?'/examples/compare/index.html':pathname;
    const decoded=decodeURIComponent(normalized);
    const file=resolve(root,'.'+decoded);
    if(!file.startsWith(root+sep))throw Error('Outside example root');
    const meta=await stat(file);
    if(!meta.isFile())throw Error('Not a regular file');
    const contents=await readFile(file);
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:contents);
  }catch(error){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(
  'Open http://127.0.0.1:'+port+'/examples/compare/ (Ctrl+C to stop)'));
