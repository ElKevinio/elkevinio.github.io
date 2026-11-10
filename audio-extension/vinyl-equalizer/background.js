'use strict';
const CHANNEL = 'vinyl-eq-extension-v1';
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
let setupPromise = null;
let actionQueue = Promise.resolve();

function allowedUrl(value) {
  try { return ['https://vinyl.elkevinio.de', 'http://localhost:8000', 'http://127.0.0.1:8000'].includes(new URL(value).origin); }
  catch { return false; }
}
async function hasOffscreen() {
  return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[OFFSCREEN_URL]})).length > 0;
}
async function ensureOffscreen() {
  if (!setupPromise) setupPromise = (async () => {
    if (!await hasOffscreen()) await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'Lokale Audio-Frequenzanalyse des vom Nutzer ausgewählten Vinyl-Tabs.'});
  })().finally(() => { setupPromise = null; });
  await setupPromise;
}
async function offscreenCommand(command, data = {}) {
  if (!await hasOffscreen()) return {active:false};
  return chrome.runtime.sendMessage({channel:CHANNEL,target:'offscreen',command,...data});
}
async function notify(tabId, payload) {
  if (!Number.isInteger(tabId)) return;
  try { await chrome.tabs.sendMessage(tabId,{channel:CHANNEL,...payload}); } catch {}
}
async function badge(active, tabId) {
  await chrome.action.setBadgeText({text:active?'EQ':'',tabId}).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({color:'#8754cf',tabId}).catch(() => {});
}
chrome.action.onClicked.addListener(tab => {
  // Only an explicit extension invocation can obtain a tabCapture stream ID.
  if (!Number.isInteger(tab.id) || !allowedUrl(tab.url)) {
    if (Number.isInteger(tab.id)) void chrome.action.setTitle({tabId:tab.id,title:'Öffne vinyl.elkevinio.de und klicke dort auf dieses Symbol.'});
    return;
  }
  actionQueue = actionQueue.catch(() => {}).then(async () => {
    const previous = await offscreenCommand('STATUS');
    if (previous.active) {
      await offscreenCommand('STOP');
      await badge(false,previous.tabId);
      await notify(previous.tabId,{type:'status',active:false});
      if (previous.tabId === tab.id) return;
    }
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
    const sessionId = crypto.randomUUID();
    const result = await offscreenCommand('START',{streamId,tabId:tab.id,sessionId});
    if (!result?.ok) throw new Error(result?.error || 'Tab-Audio konnte nicht gestartet werden.');
    await badge(true,tab.id);
    await notify(tab.id,{type:'status',active:true,sessionId});
  }).catch(async error => {
    await badge(false,tab.id);
    await notify(tab.id,{type:'status',active:false,error:error.message || 'Audio-Verbindung fehlgeschlagen.'});
  });
});
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (message?.channel !== CHANNEL || message.target === 'offscreen') return false;
  if (sender.url === OFFSCREEN_URL && !sender.tab) {
    if (message.type === 'bands') {
      if (Array.isArray(message.levels) && message.levels.length === 32 && message.levels.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
        void notify(message.tabId,{type:'bands',sessionId:message.sessionId,levels:message.levels});
      }
    } else if (message.type === 'stopped') {
      void badge(false,message.tabId);
      void notify(message.tabId,{type:'status',active:false,error:message.error || ''});
    }
    return false;
  }
  if (!sender.tab || !allowedUrl(sender.url) || sender.frameId !== 0) return false;
  const tabId = sender.tab.id;
  if (!['STATUS','STOP','RESPONSIVENESS'].includes(message.command)) return false;
  (async () => {
    const current = await offscreenCommand('STATUS');
    const ownsCapture = current.active && current.tabId === tabId;
    if (message.command === 'STOP' && ownsCapture && (!message.sessionId || message.sessionId === current.sessionId)) {
      await offscreenCommand('STOP'); await badge(false,tabId);
      await notify(tabId,{type:'status',active:false});
      return {active:false};
    }
    if (message.command === 'RESPONSIVENESS' && ownsCapture) {
      await offscreenCommand('RESPONSIVENESS',{value:Math.max(0,Math.min(100,Number(message.value)||0))});
    }
    return {active:!!ownsCapture,sessionId:ownsCapture?current.sessionId:null};
  })().then(respond,error => respond({active:false,error:error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void (async()=>{const current=await offscreenCommand('STATUS');if(current.active&&current.tabId===tabId)await offscreenCommand('STOP');})().catch(()=>{});
});
chrome.tabs.onUpdated.addListener((tabId,change) => {
  // Stop on any navigation, even if Chrome no longer exposes the destination URL
  // after revoking activeTab. Reloading requires a fresh extension click.
  if (change.status !== 'loading' && (!change.url || allowedUrl(change.url))) return;
  void (async()=>{const current=await offscreenCommand('STATUS');if(current.active&&current.tabId===tabId){await offscreenCommand('STOP');await badge(false,tabId);}})().catch(()=>{});
});
