'use strict';
const CHANNEL='vinyl-eq-extension-v1';
let session=null, generation=0;
function send(payload){void chrome.runtime.sendMessage({channel:CHANNEL,...payload}).catch(()=>{});}
async function stop(error='') {
  generation++;
  const old=session;session=null;
  if(!old)return;
  clearInterval(old.timer);
  old.stream.getTracks().forEach(track=>{track.onended=null;track.stop();});
  old.source.disconnect();old.analyser.disconnect();
  await old.context.close().catch(()=>{});
  send({type:'stopped',tabId:old.tabId,error});
}
function setResponsiveness(value) {
  if(session)session.analyser.smoothingTimeConstant=.96*(1-value/100)**.7;
}
async function start(message) {
  await stop();
  const version=generation;
  let stream,context;
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},video:false});
    if(version!==generation){stream.getTracks().forEach(track=>track.stop());throw new Error('Start abgebrochen.');}
    context=new AudioContext();
    const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();
    analyser.fftSize=2048;analyser.minDecibels=-90;analyser.maxDecibels=-15;
    source.connect(analyser);
    // tabCapture replaces local playback: exactly one direct route preserves audible sound.
    source.connect(context.destination);
    await context.resume();
    session={stream,context,source,analyser,tabId:message.tabId,sessionId:message.sessionId,data:new Uint8Array(analyser.frequencyBinCount),timer:null};
    setResponsiveness(40);
    session.timer=setInterval(()=>{
      const current=session;if(!current)return;
      analyser.getByteFrequencyData(current.data);
      const levels=[];
      for(let band=0;band<32;band++) {
        const low=45*(Math.min(16000,context.sampleRate/2)/45)**(band/32);
        const high=45*(Math.min(16000,context.sampleRate/2)/45)**((band+1)/32);
        const from=Math.min(current.data.length-1,Math.floor(low*analyser.fftSize/context.sampleRate));
        const to=Math.min(current.data.length,Math.max(from+1,Math.ceil(high*analyser.fftSize/context.sampleRate)));
        let sum=0;for(let i=from;i<to;i++)sum+=current.data[i];
        levels.push(Math.max(.018,Math.min(1,(sum/Math.max(1,to-from)/255)**1.15)));
      }
      send({type:'bands',tabId:current.tabId,sessionId:current.sessionId,levels});
    },50);
    stream.getTracks().forEach(track=>{track.onended=()=>void stop('Tab-Audio wurde beendet.');});
    return {ok:true};
  } catch(error) {
    if(session)await stop();
    else {stream?.getTracks().forEach(track=>track.stop());await context?.close().catch(()=>{});}
    return {ok:false,error:error.message||'Audioanalyse konnte nicht gestartet werden.'};
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.channel!==CHANNEL || message.target!=='offscreen' || sender.id!==chrome.runtime.id || sender.tab)return false;
  if(message.command==='STATUS'){respond({active:!!session,tabId:session?.tabId,sessionId:session?.sessionId});return false;}
  if(message.command==='RESPONSIVENESS'){setResponsiveness(Math.max(0,Math.min(100,Number(message.value)||0)));respond({ok:true});return false;}
  if(message.command==='STOP'){stop().then(()=>respond({ok:true}));return true;}
  if(message.command==='START'){start(message).then(respond);return true;}
  return false;
});
