import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const root=new URL('../audio-extension/vinyl-equalizer/',import.meta.url);
const source=async name=>readFile(new URL(name,root),'utf8');
for(const file of ['background.js','offscreen.js','bridge.js'])new vm.Script(await source(file),{filename:file});
const manifest=JSON.parse(await source('manifest.json'));
assert.deepEqual(manifest.permissions,['activeTab','tabCapture','offscreen']);
assert.equal(manifest.action.default_popup,undefined);
assert.equal(manifest.minimum_chrome_version,'116');
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
// Background: only an extension action on an allowed page may start capture.
{
  const clicks=event(),messages=event();let captureCalls=0,current={active:false};const relayed=[];
  const chrome={runtime:{getURL:p=>'chrome-extension://test/'+p,getContexts:async()=>[{contextType:'OFFSCREEN_DOCUMENT'}],onMessage:messages,sendMessage:async m=>{
    if(m.command==='STATUS')return current;
    if(m.command==='START'){current={active:true,tabId:m.tabId,sessionId:m.sessionId};return {ok:true};}
    if(m.command==='STOP'){current={active:false};return {ok:true};}
  }},offscreen:{createDocument:async()=>{}},action:{onClicked:clicks,setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},tabCapture:{getMediaStreamId:async()=>{captureCalls++;return 'stream';}},tabs:{sendMessage:async(id,m)=>relayed.push([id,m]),onRemoved:event(),onUpdated:event()}};
  vm.runInNewContext(await source('background.js'),{chrome,URL,crypto:{randomUUID:()=> 'session'},console});
  clicks.listeners[0]({id:2,url:'https://untrusted.example/'});await tick();assert.equal(captureCalls,0);
  clicks.listeners[0]({id:3,url:'https://vinyl.elkevinio.de/'});await tick();await tick();assert.equal(captureCalls,1);assert.equal(current.tabId,3);
  const listener=messages.listeners[0];
  assert.equal(listener({channel:'vinyl-eq-extension-v1',command:'STOP'},{tab:{id:3},frameId:0,url:'https://untrusted.example/'},()=>{}),false);
  assert.equal(listener({channel:'vinyl-eq-extension-v1',command:'START'},{tab:{id:3},frameId:0,url:'https://vinyl.elkevinio.de/'},()=>{}),false);
  let otherStatus;
  listener({channel:'vinyl-eq-extension-v1',command:'STATUS'},{tab:{id:9},frameId:0,url:'https://vinyl.elkevinio.de/'},r=>otherStatus=r);
  await tick();assert.equal(otherStatus.active,false);
  listener({channel:'vinyl-eq-extension-v1',type:'bands',tabId:3,levels:Array(32).fill(.5),sessionId:'session'},{url:'chrome-extension://evil/offscreen.html'},()=>{});
  const before=relayed.length;
  listener({channel:'vinyl-eq-extension-v1',type:'bands',tabId:3,levels:Array(32).fill(.5),sessionId:'session'},{url:'chrome-extension://test/offscreen.html'},()=>{});
  await tick();assert.equal(relayed.length,before+1);assert.equal(relayed.at(-1)[0],3);
  clicks.listeners[0]({id:3,url:'https://vinyl.elkevinio.de/'});await tick();await tick();assert.equal(current.active,false);assert.equal(captureCalls,1);
}
// Offscreen: no video, exactly one audible output, bounded bands and clean stop.
{
  const messages=event(),sent=[];let meter,stopped=0,closed=0,destinationConnections=0,audioOptions;
  const track={stop(){stopped++;},onended:null};
  const analyser={fftSize:0,frequencyBinCount:1024,disconnect(){},getByteFrequencyData(data){data.fill(128);}};
  class AudioContext {constructor(){this.sampleRate=48000;this.destination={};}createMediaStreamSource(){return {connect:node=>{if(node===this.destination)destinationConnections++;},disconnect(){}};}createAnalyser(){return analyser;}async resume(){}async close(){closed++;}}
  const chrome={runtime:{id:'test',onMessage:messages,sendMessage:async m=>sent.push(m)}};
  vm.runInNewContext(await source('offscreen.js'),{chrome,AudioContext,navigator:{mediaDevices:{getUserMedia:async options=>{audioOptions=options;return {getTracks:()=>[track]};}}},Uint8Array,Math,Number,setInterval:fn=>{meter=fn;return 1;},clearInterval(){}});
  const request=message=>new Promise(resolve=>messages.listeners[0]({channel:'vinyl-eq-extension-v1',target:'offscreen',...message},{id:'test'},resolve));
  assert.equal((await request({command:'START',streamId:'stream',tabId:3,sessionId:'session'})).ok,true);
  assert.equal(audioOptions.video,false);assert.equal(destinationConnections,1);
  meter();assert.equal(sent.at(-1).levels.length,32);assert(sent.at(-1).levels.every(n=>n>=0&&n<=1));
  await request({command:'RESPONSIVENESS',value:100});assert.equal(analyser.smoothingTimeConstant,0);
  await request({command:'STOP'});assert.equal(stopped,1);assert.equal(closed,1);assert.equal((await request({command:'STATUS'})).active,false);
}
// Bridge: only same-page messages and the restricted command set are forwarded.
{
  const handlers={},posted=[],requests=[];const origin='https://vinyl.elkevinio.de';
  const window={addEventListener:(n,fn)=>handlers[n]=fn,postMessage:(m,to)=>posted.push([m,to])};
  const chrome={runtime:{sendMessage:async m=>{requests.push(m);return {active:false};},onMessage:event()}};
  vm.runInNewContext(await source('bridge.js'),{window,location:{origin},chrome});await tick();
  assert.equal(posted[0][0].version,1);assert.equal(posted[0][1],origin);
  const before=requests.length;
  handlers.message({source:window,origin:'https://evil.example',data:{channel:'vinyl-eq-page-v1',command:'STOP'}});
  handlers.message({source:window,origin,data:{channel:'vinyl-eq-page-v1',command:'START'}});
  assert.equal(requests.length,before);
  handlers.message({source:window,origin,data:{channel:'vinyl-eq-page-v1',command:'STATUS'}});await tick();assert.equal(requests.length,before+1);
}
console.log('Audio-Erweiterung: Syntax, Berechtigungen, Start/Stop, Absenderprüfung, Tab-Zuordnung, Audioausgabe, Frequenzwerte und Bridge geprüft.');
