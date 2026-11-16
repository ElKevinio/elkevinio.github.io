import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {networkInterfaces} from 'node:os';
const directory=dirname(fileURLToPath(import.meta.url));
export function createObsRelay({root=directory,token=randomBytes(24).toString('hex')}={}) {
  const clients=new Set(),sources=new Map();let active=null;
  const valid=value=>typeof value==='string' && Buffer.byteLength(value)===Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const emit=message=>{const wire='data: '+JSON.stringify(message)+'\n\n';for(const response of clients)response.write(wire);};
  function accept(message) {
    if(!message || !['vinyl-obs-state','vinyl-obs-style'].includes(message.type) || typeof message.sourceId!=='string' || message.sourceId.length>100)return false;
    const source=sources.get(message.sourceId)||{};
    if(message.type==='vinyl-obs-style') {
      if(typeof message.css!=='string' || message.css.length>1500000)return false;
      source.style={type:message.type,sourceId:message.sourceId,css:message.css};sources.set(message.sourceId,source);
      if(active===message.sourceId)emit(source.style);return true;
    }
    if(typeof message.title!=='string' || typeof message.turntable!=='string' || message.turntable.length>1000000)return false;
    source.state={type:message.type,sourceId:message.sourceId,title:message.title.slice(0,1000),artist:String(message.artist || '').slice(0,1000),cover:String(message.cover || '').slice(0,300000),turntable:message.turntable,position:Number(message.position)||0,duration:Number(message.duration)||0,playing:!!message.playing,sentAt:Date.now()};
    source.seen=Date.now();sources.set(message.sourceId,source);
    const previous=sources.get(active);
    if(active && active!==message.sourceId && previous && Date.now()-previous.seen<15000 && (previous.state?.playing || !source.state.playing))return true;
    const changed=active!==message.sourceId;active=message.sourceId;
    if(changed && source.style)emit(source.style);emit(source.state);
    for(const [id,entry]of sources)if(Date.now()-(entry.seen || 0)>60000 && id!==active)sources.delete(id);
    return true;
  }
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const error=(code,text)=>{res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(text);};
    try {
      if(url.pathname.startsWith('/api/obs/')) {
        if(!valid(req.headers['x-obs-token'] || url.searchParams.get('room')))return error(403,'Ungültiger OBS-Zugriffsschlüssel');
        if(req.method==='GET' && url.pathname==='/api/obs/events') {
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');clients.add(res);
          const source=sources.get(active);
          if(source?.style)res.write('data: '+JSON.stringify(source.style)+'\n\n');
          if(source?.state && Date.now()-source.seen<15000)res.write('data: '+JSON.stringify(source.state)+'\n\n');
          const timer=setInterval(()=>res.write(': heartbeat\n\n'),10000);
          req.on('close',()=>{clearInterval(timer);clients.delete(res);});return;
        }
        if(req.method==='POST' && url.pathname==='/api/obs/state') {
          if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)return error(403,'Andere Herkunft nicht erlaubt');
          let bytes=0;const chunks=[];
          for await(const chunk of req){bytes+=chunk.length;if(bytes>2000000)return error(413,'Nachricht zu groß');chunks.push(chunk);}
          let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{return error(400,'Ungültige Nachricht');}
          if(!accept(data))return error(400,'Ungültige OBS-Daten');res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;
        }
        return error(404,'Nicht gefunden');
      }
      if(!['GET','HEAD'].includes(req.method))return error(405,'Nicht erlaubt');
      const name=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
      if(!(/^\/(index\.html|obs\.html|vordle\.(js|css)|layout-diagnostics\.js|image-link-health\.js|apple-touch-icon\.(png|svg))$/.test(name) || /^\/assets\/[a-zA-Z0-9_./-]+$/.test(name)))return error(404,'Nicht gefunden');
      const path=await realpath(resolve(root,'.'+name)),base=await realpath(root);
      if(!path.startsWith(base+sep))return error(403,'Nicht erlaubt');
      const info=await stat(path);if(!info.isFile())return error(404,'Nicht gefunden');
      const mime=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':'application/octet-stream';
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      if(req.method==='HEAD'){res.end();return;}
      if(name.endsWith('.html')) {
        let page=await readFile(path,'utf8');
        const room=valid(url.searchParams.get('room'))?url.searchParams.get('room'):'';
        const config='<script>window.VINYL_OBS_RELAY='+JSON.stringify({token:room}).replaceAll('<','\\u003c')+';</script>';
        page=page.replace('<script',config+'<script');res.end(page);
      } else createReadStream(path).pipe(res);
    }catch(cause){if(!res.headersSent)error(cause.code==='ENOENT'?404:500,'Datei nicht verfügbar');else res.end();}
  });
  return {server,token,accept,clients};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const port=Number(process.env.OBS_PORT || 8787),host=process.env.OBS_HOST || '0.0.0.0';
  const {server,token}=createObsRelay();
  server.listen(port,host,()=>{
    console.log(`Musikseite: http://localhost:${port}/?room=${token}`);
    console.log(`OBS auf diesem Rechner: http://localhost:${port}/obs.html?room=${token}`);
    for(const list of Object.values(networkInterfaces()))for(const net of list || [])if(net.family==='IPv4' && !net.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address))console.log(`OBS im Heimnetz: http://${net.address}:${port}/obs.html?room=${token}`);
  });
  server.on('error',error=>{console.error('OBS-Server:',error.message);process.exitCode=1;});
}
