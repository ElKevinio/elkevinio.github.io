(() => {
  'use strict';
  if(!['https://vinyl.elkevinio.de','http://localhost:8000','http://127.0.0.1:8000'].includes(location.origin))return;
  const CHANNEL='vinyl-eq-extension-v1',PAGE='vinyl-eq-page-v1';
  const post=data=>window.postMessage({channel:CHANNEL,version:1,...data},location.origin);
  async function command(message){
    try {return await chrome.runtime.sendMessage({channel:CHANNEL,...message});}
    catch {return {active:false,error:'Erweiterung wurde neu geladen. Bitte Webseite neu laden.'};}
  }
  window.addEventListener('message',event=>{
    if(event.source!==window || event.origin!==location.origin || event.data?.channel!==PAGE)return;
    const {command:type,sessionId,value}=event.data;
    if(!['STATUS','STOP','RESPONSIVENESS'].includes(type))return;
    void command({command:type,sessionId,value}).then(status=>{if(status)post({type:'status',...status});});
  });
  chrome.runtime.onMessage.addListener(message=>{
    if(message?.channel!==CHANNEL)return;
    if(message.type==='bands'||message.type==='status')post(message);
  });
  void command({command:'STATUS'}).then(status=>post({type:'status',...status}));
})();
