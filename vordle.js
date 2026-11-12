/* Vordle: daily shared catalogue, local hints, transactional ten-guess game. */
(function (global) {
  'use strict';
  const VERSION = 1, MAX_GUESSES = 10, PART_BYTES = 550 * 1024;
  const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const text = value => String(value || '').trim();
  function dayKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(date);
    return ['year','month','day'].map(type => parts.find(part => part.type === type).value).join('-');
  }
  function dayBounds(key) {
    const [year,month,day] = key.split('-').map(Number);
    // Berlin is UTC+1 or UTC+2. Determine each midnight separately for DST days.
    const midnight = utc => {
      const probe = new Date(utc);
      const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(probe));
      return utc - hour * 3600000;
    };
    return {start:midnight(Date.UTC(year,month-1,day)),end:midnight(Date.UTC(year,month-1,day+1))};
  }
  function puzzleStamp(day) {return String(day?.createdAt?.toMillis?.() || (typeof day?.createdAt==='number'?day.createdAt:'') || day?.answer?.id || '');}
  function albumIdentity(album) { return `${normalize(album.artist)}\u0000${normalize(album.title)}`; }
  function validCoverUrl(value) {
    const source=text(value);
    if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source))return source.length<=250000?source:'';
    try {const url=new URL(source);return url.protocol==='https:' && !url.username && !url.password && source.length<=4096?url.href:'';}catch{return '';}
  }
  function coverBlur(guesses, uncovered=false) {return uncovered?0:Math.round(28-Math.min(9,Math.max(0,guesses))*25/9);}
  function gameProgress(score, practice, answerId) {
    const official=score?.guesses || [],extra=practice?.guesses || [];
    const lost=!score?.solved && official.length>=MAX_GUESSES;
    const practiceSolved=lost && extra.includes(answerId);
    const uncovered=!!score?.solved || practiceSolved || lost && !!practice?.revealed;
    const practicing=lost && !!practice?.active && !uncovered;
    return {official,guesses:official.concat(lost?extra:[]),lost,practiceSolved,uncovered,practicing,canGuess:!score?.solved && (!lost || practicing)};
  }
  function candidateFromItem(item) {
    const title = text(item.title).slice(0,240), artist = text(item.artist).slice(0,240);
    if (!normalize(title) || !normalize(artist)) return null;
    const yearValue = Number(item.year), priceValue = Number(item.discogsLowestPrice);
    const genreValues = Array.isArray(item.genre) ? item.genre : String(item.genre || '').split(',');
    const genres = [...new Map(genreValues.map(value => [normalize(value),text(value).slice(0,64)]).filter(([key])=>key)).values()].slice(0,12);
    return {title,artist,coverUrl:validCoverUrl(item.coverUrl),year:Number.isInteger(yearValue) && yearValue>=1000 && yearValue<=3000?yearValue:null,genres,
      format:text(item.releaseType || 'Album').slice(0,64),
      price:!item.priceManual && Number.isFinite(priceValue) && priceValue>0?Math.round(priceValue*100)/100:null,
      currency:text(item.discogsCurrency || '€').replace(/^EUR$/i,'€').slice(0,8)};
  }
  function deduplicateCandidates(items) {
    const map = new Map();
    const quality = album => [album.year,album.genres.length,album.format,album.price].filter(Boolean).length;
    for (const item of items) {
      const candidate = candidateFromItem(item); if(!candidate)continue;
      const key = albumIdentity(candidate), previous=map.get(key);
      // Stable representative of duplicate album pressings, with the fullest metadata.
      if(!previous)map.set(key,candidate);
      else {
        const covers=[previous.coverUrl,candidate.coverUrl].filter(Boolean).sort();
        const best=quality(candidate)>quality(previous) || quality(candidate)===quality(previous) && JSON.stringify(candidate)<JSON.stringify(previous)?candidate:previous;
        map.set(key,{...best,coverUrl:covers[0] || ''});
      }
    }
    return [...map.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,album])=>album);
  }
  async function catalogueFromItems(items, digest = async value => {
    const bytes=await global.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,32);
  }) {
    const unique=deduplicateCandidates(items), output=[];
    for(const album of unique)output.push({id:await digest(albumIdentity(album)),...album});
    return output;
  }
  function catalogueParts(albums, maxBytes=PART_BYTES) {
    const parts=[];let items=[],size=0;
    for(const source of albums){const {coverUrl,...album}=source;const bytes=new TextEncoder().encode(JSON.stringify(album)).length+40;
      if(size+bytes>maxBytes && items.length){parts.push(items);items=[];size=0;}items.push(album);size+=bytes;}
    if(items.length)parts.push(items);
    return parts.map((items,index)=>({id:`p${String(index).padStart(4,'0')}`,items,albumIds:items.map(album=>album.id)}));
  }
  function initialHint(value) {return Array.from(text(value)).find(char=>/[\p{L}\p{N}]/u.test(char))?.toLocaleUpperCase('de') || '—';}
  function feedback(guess, answer) {
    const won=guess.id===answer.id;
    const numeric=(value,target)=>{
      if(value==null || target==null)return {state:'unknown',hint:'Keine Vergleichsdaten'};
      if(value===target)return {state:'correct',hint:'Stimmt'};
      const distance=Math.round(Math.abs(target-value)*100)/100,tone=distance<3?'near':distance<10?'medium':'far';
      return {state:'wrong',tone,arrow:target>value?'↑':'↓',hint:(target>value?'Höherer Wert gesucht':'Niedrigerer Wert gesucht')+' · '+(tone==='near'?'unter 3 Abstand':tone==='medium'?'3 bis unter 10 Abstand':'mindestens 10 Abstand')};
    };
    const matchingGenres=guess.genres.filter(genre=>answer.genres.some(other=>normalize(other)===normalize(genre)));
    return {
      title:{state:won?'correct':normalize(guess.title)===normalize(answer.title)?'partial':'wrong',hint:won?'Richtiges Album':normalize(guess.title)===normalize(answer.title)?'Gleicher Titel, anderer Artist':'Anderer Titel'},
      artist:{state:won?'correct':normalize(guess.artist)===normalize(answer.artist)?'partial':'wrong',hint:won?'Richtiger Artist':normalize(guess.artist)===normalize(answer.artist)?'Richtiger Artist, anderes Album':'Anderer Artist'},
      year:numeric(guess.year,answer.year),
      genres:{state:matchingGenres.length?'correct':'unknown',matches:matchingGenres,hint:matchingGenres.length?'Übereinstimmende Genres':'Kein gemeinsames Genre oder keine Genre-Daten'},
      format:{state:!guess.format || !answer.format?'unknown':normalize(guess.format)===normalize(answer.format)?'correct':'wrong',hint:'Veröffentlichungsformat'},
      price:guess.currency===answer.currency?numeric(guess.price,answer.price):{state:'unknown',hint:'Unterschiedliche Währungen'}
    };
  }
  function nextScore(previous, guessId, answerId, user, key, partId) {
    const guesses=previous?.guesses || [];
    if(previous?.solved || guesses.length>=MAX_GUESSES)throw new Error('Dein Vordle für heute ist bereits beendet.');
    if(guesses.includes(guessId))throw new Error('Dieses Album hast du bereits versucht.');
    return {version:VERSION,day:key,uid:user.uid,username:text(user.username || 'Spieler').slice(0,80),guesses:[...guesses,guessId],solved:guessId===answerId,attempts:guesses.length+1,partId};
  }
  function create(options) {
    const {db,getUser,timestamp,serverTimestamp,track=promise=>promise}=options;
    const state={day:null,catalogue:[],parts:new Map(),score:null,scores:[],loading:false,busy:false,selected:null,open:false,epoch:0,timer:null,dayPromise:null,cataloguePromise:null,rankingPromise:null,activeTab:'game',practiceResults:new Map(),practice:{guesses:[],active:false,revealed:false}};
    const el=(tag,className,content)=>{const node=document.createElement(tag);if(className)node.className=className;if(content!=null)node.textContent=content;return node;};
    const dialog=el('dialog','vordle-dialog');dialog.setAttribute('aria-labelledby','vordleTitle');
    const hero=el('header','vordle-hero'),wordmark=el('div','vordle-wordmark');
    wordmark.append(el('span','vordle-record','◉'));
    const title=el('h2',null,'Vordle');title.id='vordleTitle';wordmark.append(title,el('span','vordle-daily-label','DAILY VINYL'));
    const close=el('button','vordle-close','×');close.type='button';close.setAttribute('aria-label','Vordle schließen');close.onclick=()=>dialog.close();hero.append(wordmark,close);
    const sub=el('p','vordle-subtitle','0 von 10 Versuchen');
    const dayLabel=el('p','vordle-day');const status=el('p','vordle-status');status.setAttribute('role','status');
    const coverFigure=el('figure','vordle-cover-hint'),coverFrame=el('div','vordle-cover-frame');
    const coverImage=el('img','vordle-cover-image');coverImage.alt='Verschwommenes Cover des gesuchten Albums';coverImage.draggable=false;coverImage.referrerPolicy='no-referrer';
    const coverPlaceholder=el('span','vordle-cover-placeholder','◉');coverPlaceholder.setAttribute('aria-hidden','true');
    const coverCaption=el('figcaption','vordle-cover-caption'),hints=el('div','vordle-letter-hints'),coverInfo=el('div','vordle-cover-info');let failedCoverUrl='';
    coverFrame.append(coverImage,coverPlaceholder);coverInfo.append(hints,coverCaption);coverFigure.append(coverFrame,coverInfo);
    coverImage.addEventListener('error',()=>{failedCoverUrl=coverImage.getAttribute('src') || '';coverImage.hidden=true;coverPlaceholder.hidden=false;coverCaption.textContent='Cover konnte nicht geladen werden. Du kannst mit den Tabellenhinweisen weiterraten.';});
    const help=el('details','vordle-help');help.append(el('summary',null,'So funktioniert’s'));
    help.append(el('p',null,'Errate ein Album aus den Sammlungen aller Nutzer. Titel und Artist werden gelb, wenn sie passen, aber das Album noch falsch ist. Falsche Felder bleiben grau. Jahr- und Preis-Pfeile: unter 3 Abstand grün, 3 bis unter 10 gelb, ab 10 rot. Genres zeigen nur gemeinsame Treffer. Nach 5 Tipps erscheint der erste Buchstabe des Artists, nach 8 der des Titels. Genre ist grün, sobald mindestens eines übereinstimmt; Format bei gleicher Veröffentlichungsart. ↑ bedeutet: neueres Jahr oder höherer Preis gesucht. ↓ bedeutet: älter oder günstiger. Fehlende Daten bleiben grau. Preise sind eingefrorene Discogs-Ab-Preise, keine Kaufpreise. Das Cover wird nach jedem Fehlversuch schärfer. Nach zehn Fehlversuchen kannst du ohne Wertung weiterspielen oder die Lösung aufdecken. Zusätzliche Tipps bleiben auf diesem Gerät; die Gesamtzahl wird in der Rangliste geteilt. Jeden Tag um 00:00 Uhr in Berlin beginnt ein neues Spiel.'));
    const form=el('form','vordle-form'),label=el('label',null,'Dein Album-Tipp');label.htmlFor='vordleSearch';
    const input=el('input');input.id='vordleSearch';input.type='search';input.placeholder='Artist oder Album suchen …';input.autocomplete='off';input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','vordleSuggestions');input.setAttribute('aria-expanded','false');
    const suggestions=el('ul','vordle-suggestions');suggestions.id='vordleSuggestions';suggestions.setAttribute('role','listbox');suggestions.hidden=true;
    const submit=el('button','vordle-submit','Raten');submit.type='submit';submit.disabled=true;
    const searchWrap=el('div','vordle-search-wrap');searchWrap.append(input,suggestions);form.append(label,searchWrap,submit);
    const legend=el('p','vordle-legend','✓ passt · ≈ teilweise · Pfeile: grün <3 · gelb <10 · rot ≥10 (Jahre / €)');
    const gridWrap=el('div','vordle-grid-wrap'),grid=el('table','vordle-grid'),thead=el('thead'),head=el('tr');
    for(const label of ['Album','Artist','Jahr','Genre','Format','Preis'])head.append(el('th',null,label));thead.append(head);
    const tbody=el('tbody');grid.append(thead,tbody);gridWrap.append(grid);
    const reveal=el('div','vordle-reveal');reveal.hidden=true;
    const ranking=el('section','vordle-ranking'),rankingHead=el('div','vordle-ranking-head'),rankingTitle=el('h3',null,'Heute auf dem Plattenteller');
    const refresh=el('button','vordle-ranking-refresh','Ergebnisse aktualisieren');refresh.type='button';
    const rankingStatus=el('p','vordle-ranking-status');rankingStatus.setAttribute('role','status');
    const rankingList=el('ol','vordle-ranking-list');rankingHead.append(rankingTitle,refresh);ranking.append(rankingHead,rankingStatus,rankingList);
    const retry=el('button','vordle-retry','Erneut laden');retry.type='button';retry.hidden=true;retry.onclick=()=>open();
    const tabs=el('div','vordle-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Vordle-Ansichten');
    const gameTab=el('button','vordle-tab','Rätsel'),rankTab=el('button','vordle-tab','Rangliste');
    const gamePanel=el('section','vordle-game-panel'),solution=el('section','vordle-solution');solution.hidden=true;
    gamePanel.id='vordleGamePanel';ranking.id='vordleRankingPanel';
    gamePanel.setAttribute('role','tabpanel');ranking.setAttribute('role','tabpanel');
    gamePanel.setAttribute('aria-labelledby','vordleGameTab');ranking.setAttribute('aria-labelledby','vordleRankTab');
    for(const [button,id,panel] of [[gameTab,'vordleGameTab',gamePanel],[rankTab,'vordleRankTab',ranking]]){button.type='button';button.id=id;button.setAttribute('role','tab');button.setAttribute('aria-controls',panel.id);tabs.append(button);}
    function showTab(tab){state.activeTab=tab;const playing=tab==='game';gamePanel.hidden=!playing;ranking.hidden=playing;gameTab.setAttribute('aria-selected',String(playing));rankTab.setAttribute('aria-selected',String(!playing));gameTab.tabIndex=playing?0:-1;rankTab.tabIndex=playing?-1:0;if(!playing)void loadScores(true);}
    gameTab.onclick=()=>showTab('game');rankTab.onclick=()=>showTab('ranking');
    for(const button of [gameTab,rankTab])button.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();showTab(state.activeTab==='game'?'ranking':'game');(state.activeTab==='game'?gameTab:rankTab).focus();}};
    gamePanel.append(solution,coverFigure,form,status,retry,legend,gridWrap,reveal,help);
    dialog.append(hero,sub,dayLabel,tabs,gamePanel,ranking);document.body.append(dialog);showTab('game');
    let matches=[],active=-1;
    const dayRef=key=>db.collection('vordleDays').doc(key);
    const liveUser=()=>{const user=getUser();if(!user?.uid)throw new Error('Bitte melde dich an, um Vordle zu spielen.');return user;};
    const sameUser=(uid,epoch)=>getUser()?.uid===uid && epoch===state.epoch;
    const errorMessage=error=>error?.code==='permission-denied'?'Firebase hat den Vordle-Zugriff abgelehnt. Bitte prüfen, ob die aktuellen Vordle-Regeln veröffentlicht sind und die Gerätezeit stimmt.':error?.message || 'Vordle konnte nicht geladen werden. Bitte erneut versuchen.';
    const progress=()=>gameProgress(state.score,state.practice,state.day?.answer.id);
    const practiceKey=()=>`vordlePracticeV1:${getUser()?.uid || ''}`;
    function loadPractice(){
      state.practice={guesses:[],active:false,revealed:false};
      if(!state.day)return;
      try {const saved=JSON.parse(localStorage.getItem(practiceKey()) || 'null');
        if(saved?.day===state.day.day && saved.stamp===puzzleStamp(state.day) && saved.answerId===state.day.answer.id){
          const known=new Set(state.catalogue.map(album=>album.id)),official=new Set(state.score?.guesses || []);
          state.practice={guesses:[...new Set(Array.isArray(saved.guesses)?saved.guesses:[])].filter(id=>known.has(id) && !official.has(id)),active:saved.active===true,revealed:saved.revealed===true};
        }
      }catch{}
    }
    function savePractice(){try {localStorage.setItem(practiceKey(),JSON.stringify({...state.practice,day:state.day.day,stamp:puzzleStamp(state.day),answerId:state.day.answer.id}));}catch{}}
    function clearPractice(){state.practice={guesses:[],active:false,revealed:false};}
    function canGuess(){return progress().canGuess;}
    function setStatus(message,error=false){status.textContent=message;status.classList.toggle('is-error',error);}
    function scheduleMidnight(){
      clearTimeout(state.timer);const end=dayBounds(dayKey()).end;
      const rollover=()=>{
        if(state.busy || state.loading){state.timer=setTimeout(rollover,1000);return;}
        state.day=null;state.dayPromise=null;
        if(getUser()?.uid)void (state.open?open():prewarm()).catch(()=>{});
      };
      state.timer=setTimeout(rollover,Math.max(1000,end-Date.now()+200));
    }
    async function readCollectionCatalogue(onProgress) {
      const roots=await track(db.collection('users').get({source:'server'}));const items=[];
      const jobs=[];
      for(const root of roots.docs){const data=root.data(),uid=root.id;
        if(data.collectionStorageVersion===2){for(const id of data.collectionChunkIds || [])jobs.push({ref:db.collection('users').doc(uid).collection('collectionChunks').doc(id),json:true});}
        else if(data.collectionStorageVersion===1){for(const id of data.collectionItemIds || [])jobs.push({ref:db.collection('users').doc(uid).collection('collectionItems').doc(id)});}
        else items.push(...(Array.isArray(data.collection)?data.collection:[]));
      }
      for(let offset=0;offset<jobs.length;offset+=12){
        if(!getUser()?.uid)throw new Error('Du wurdest abgemeldet.');
        const slice=jobs.slice(offset,offset+12),snapshots=await Promise.all(slice.map(job=>track(job.ref.get({source:'server'}))));
        snapshots.forEach((snap,index)=>{if(!snap.exists)throw new Error('Eine Sammlung wird gerade geändert. Bitte Vordle erneut laden.');if(slice[index].json){const parsed=JSON.parse(snap.data().json);if(!Array.isArray(parsed))throw new Error('Ein Sammlungsblock ist beschädigt.');items.push(...parsed);}else items.push(snap.data());});
        onProgress(Math.min(offset+12,jobs.length),jobs.length);
      }
      return catalogueFromItems(items);
    }
    async function ensureDay(force=false) {
      const user=liveUser(),key=dayKey(),epoch=state.epoch;
      if(state.day?.day===key && !force)return state.day;
      if(state.dayPromise?.key===key)return state.dayPromise.promise;
      const promise=(async()=>{
        const ref=dayRef(key),existing=await track(ref.get({source:'server'}));
        let day;
        if(existing.exists)day=existing.data();
        else {
          if(state.open)setStatus('Das erste Vordle des Tages wird aus allen Sammlungen zusammengestellt …');
          const catalogue=await readCollectionCatalogue((done,total)=>{if(state.open)setStatus(`Sammlungen werden geladen … ${done} von ${total} Blöcken`);});
          if(!sameUser(user.uid,epoch))throw new Error('Die Sitzung hat sich geändert.');
          if(dayKey()!==key)throw new Error('Ein neuer Vordle-Tag hat begonnen. Bitte erneut laden.');
          if(!catalogue.length)throw new Error('In den Sammlungen wurden noch keine Alben mit Artist und Titel gefunden.');
          const parts=catalogueParts(catalogue);
          const bytes=new TextEncoder().encode(JSON.stringify(parts)).length;
          if(parts.length>200 || bytes>8*1024*1024)throw new Error('Der gemeinsame Albumkatalog ist zu groß. Bitte den Vordle-Katalog serverseitig vorbereiten.');
          const random=new Uint32Array(1);global.crypto.getRandomValues(random);
          const eligible=catalogue.filter(album=>album.coverUrl);
          if(!eligible.length)throw new Error('Für das Cover-Vordle fehlt noch ein Album mit nutzbarem Cover in den Sammlungen.');
          const answer=eligible[Math.floor(random[0]/4294967296*eligible.length)];
          const answerPart=parts.find(part=>part.albumIds.includes(answer.id)).id;
          const bounds=dayBounds(key);
          day=await track(db.runTransaction(async transaction=>{
            const current=await transaction.get(ref);if(current.exists)return current.data();
            const challenge={version:VERSION,day:key,timezone:'Europe/Berlin',answer,answerPart,partIds:parts.map(part=>part.id),albumCount:catalogue.length,createdBy:user.uid,createdAt:serverTimestamp(),startsAt:timestamp(bounds.start),endsAt:timestamp(bounds.end)};
            for(const part of parts)transaction.set(ref.collection('catalogue').doc(part.id),{version:VERSION,items:part.items,albumIds:part.albumIds});
            transaction.set(ref,challenge);return challenge;
          })).catch(async error=>{
            // Immutable create rules can reject the losing client before the SDK
            // retries its transaction. Read the winner instead of creating a new day.
            const winner=await track(ref.get({source:'server'}));
            if(winner.exists)return winner.data();
            throw error;
          });
        }
        if(typeof day.createdAt!=='number' && typeof day.createdAt?.toMillis!=='function' && day.createdAt){const confirmed=await track(ref.get({source:'server'}));if(!confirmed.exists)throw new Error('Das Tagesrätsel wird gerade zurückgesetzt. Bitte erneut laden.');day=confirmed.data();}
        if(!sameUser(user.uid,epoch))throw new Error('Die Sitzung hat sich geändert.');
        if(day.version!==VERSION || day.day!==key || !day.answer?.id || !Array.isArray(day.partIds))throw new Error('Das Tagesrätsel hat ein unbekanntes Format.');
        if(dayKey()!==key)throw new Error('Ein neuer Vordle-Tag hat begonnen. Bitte erneut laden.');
        if(state.catalogueDay && (state.catalogueDay!==key || state.catalogueStamp!==puzzleStamp(day))){state.catalogue=[];state.score=null;state.scores=[];state.practiceResults.clear();state.selected=null;clearPractice();}
        state.day=day;scheduleMidnight();return day;
      })();
      state.dayPromise={key,promise};
      try{return await promise;}finally{if(state.dayPromise?.promise===promise)state.dayPromise=null;}
    }
    async function loadCatalogue(day) {
      if(state.catalogueDay===day.day && state.catalogueStamp===puzzleStamp(day) && state.catalogue.length)return;
      if(state.cataloguePromise?.key===day.day)return state.cataloguePromise.promise;
      const promise=(async()=>{
        let parts=null;
        try {const saved=JSON.parse(localStorage.getItem('vordleCatalogueV1') || 'null');if(saved?.day===day.day && saved.stamp===puzzleStamp(day) && saved.answerId===day.answer.id && saved.albumCount===day.albumCount && JSON.stringify(saved.partIds)===JSON.stringify(day.partIds))parts=saved.parts;}catch{}
        if(!Array.isArray(parts))parts=await Promise.all(day.partIds.map(async id=>{const snap=await track(dayRef(day.day).collection('catalogue').doc(id).get({source:'server'}));if(!snap.exists)throw new Error('Der Vordle-Katalog ist unvollständig.');return {id,...snap.data()};}));
        const catalogue=parts.flatMap(part=>part.items || []);
        if(catalogue.length!==day.albumCount || !catalogue.some(album=>album.id===day.answer.id))throw new Error('Der Vordle-Katalog ist unvollständig. Bitte erneut laden.');
        if(state.day?.day!==day.day)return;
        state.catalogue=catalogue;state.catalogueDay=day.day;state.catalogueStamp=puzzleStamp(day);state.parts=new Map(parts.flatMap(part=>part.items.map(album=>[album.id,part.id])));
        try{localStorage.setItem('vordleCatalogueV1',JSON.stringify({day:day.day,stamp:puzzleStamp(day),answerId:day.answer.id,albumCount:day.albumCount,partIds:day.partIds,parts}));}catch{}
      })();
      state.cataloguePromise={key:day.day,promise};try{await promise;}finally{if(state.cataloguePromise?.promise===promise)state.cataloguePromise=null;}
    }
    async function syncPracticeResult(){
      if(!progress().lost || !state.practice.guesses.length)return;
      const user=liveUser(),day=state.day.day,epoch=state.epoch,totalAttempts=progress().guesses.length,finished=progress().practiceSolved || state.practice.revealed;
      try {
        const ref=dayRef(day).collection('practiceResults').doc(user.uid);
        const result=await track(db.runTransaction(async transaction=>{
          const existing=await transaction.get(ref);if(existing.exists && (existing.data().finished!==false || existing.data().totalAttempts>totalAttempts || existing.data().totalAttempts===totalAttempts && (existing.data().finished || !finished)))return existing.data();
          const value={uid:user.uid,day,totalAttempts,finished,updatedAt:serverTimestamp()};transaction.set(ref,value);return value;
        }));
        if(sameUser(user.uid,epoch) && state.day?.day===day){state.practiceResults.set(user.uid,result);renderRanking();}
      }catch(error){if(sameUser(user.uid,epoch))rankingStatus.textContent='Weiterspiel-Ergebnis noch nicht synchronisiert. Mit „Ergebnisse aktualisieren“ erneut versuchen.';}
    }
    async function loadScores(force=false) {
      if(!state.day || !state.open)return;
      const day=state.day.day,uid=getUser()?.uid,epoch=state.epoch;
      if(state.rankingPromise){await state.rankingPromise;if(force && state.open)return loadScores();return;}
      refresh.disabled=true;rankingStatus.textContent='Ergebnisse werden geladen …';
      const promise=(async()=>{
        try{const [snap,extras]=await Promise.all([track(dayRef(day).collection('scores').get({source:'server'})),track(dayRef(day).collection('practiceResults').get({source:'server'}))]);if(!sameUser(uid,epoch) || state.day?.day!==day)return;state.practiceResults=new Map([...state.practiceResults,...extras.docs.map(doc=>[doc.id,doc.data()])]);state.scores=snap.docs.map(doc=>doc.data()).filter(score=>score.uid!==uid);if(state.score)state.scores.push(state.score);rankingStatus.textContent='';renderRanking();}
        catch(error){rankingStatus.textContent=errorMessage(error);}
        finally{refresh.disabled=false;}
      })();state.rankingPromise=promise;try{await promise;}finally{if(state.rankingPromise===promise)state.rankingPromise=null;}
    }
    function renderRanking(){rankingList.replaceChildren();
      const scores=state.scores.slice().sort((a,b)=>Number(b.solved)-Number(a.solved) || (a.solved?a.attempts-b.attempts:0) || a.username.localeCompare(b.username,'de'));
      if(!scores.length){rankingList.append(el('li','vordle-ranking-empty','Noch keine Tipps. Leg die erste Platte auf!'));return;}
      let lastAttempts=-1,rank=0;
      for(const [index,score] of scores.entries()){
        const row=el('li',score.uid===getUser()?.uid?'is-you':'');
        if(score.solved && score.attempts!==lastAttempts){rank=index+1;lastAttempts=score.attempts;}
        let extra=state.practiceResults.get(score.uid);
        if(score.uid===getUser()?.uid && progress().lost && state.practice.guesses.length && (!extra || progress().guesses.length>extra.totalAttempts))extra={totalAttempts:progress().guesses.length};
        row.append(el('span','vordle-rank',score.solved?String(rank).padStart(2,'0'):'—'),el('span','vordle-player-name',score.username+(score.uid===getUser()?.uid?' · du':'')),el('strong',score.solved?'vordle-score-won':'',score.solved?`${score.attempts}/${MAX_GUESSES}`:score.attempts>=MAX_GUESSES?`${extra?`(${extra.totalAttempts} Versuche) `:''}X/${MAX_GUESSES}`:`${score.attempts} Versuche`));rankingList.append(row);
      }
    }
    function clearSelection(){state.selected=null;active=-1;submit.disabled=true;input.removeAttribute('aria-activedescendant');}
    function select(album){state.selected=album;input.value=`${album.artist} – ${album.title}`;suggestions.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');submit.disabled=state.loading || state.busy;submit.focus();}
    function search(){clearSelection();suggestions.replaceChildren();const query=normalize(input.value),guessed=progress().guesses;
      matches=query?state.catalogue.filter(album=>!guessed.includes(album.id) && query.split(/\s+/).every(term=>normalize(`${album.artist} ${album.title}`).includes(term))).sort((a,b)=>Number(normalize(b.artist).startsWith(query))-Number(normalize(a.artist).startsWith(query)) || a.artist.localeCompare(b.artist,'de') || a.title.localeCompare(b.title,'de')).slice(0,12):[];
      if(!query){suggestions.hidden=true;input.setAttribute('aria-expanded','false');return;}
      if(!matches.length){const row=el('li','vordle-no-results','Kein passendes Album im heutigen Katalog.');row.setAttribute('role','option');row.setAttribute('aria-disabled','true');suggestions.append(row);}
      for(const [index,album] of matches.entries()){
        const row=el('li');row.id=`vordleOption${index}`;row.setAttribute('role','option');row.setAttribute('aria-selected','false');
        const button=el('button');button.type='button';button.tabIndex=-1;button.append(el('strong',null,album.title),el('span',null,`${album.artist}${album.year?' · '+album.year:''}`));button.onclick=()=>select(album);row.append(button);suggestions.append(row);
      }
      suggestions.hidden=false;input.setAttribute('aria-expanded','true');
    }
    input.addEventListener('input',search);
    input.addEventListener('keydown',event=>{
      if(event.key==='Escape' && !suggestions.hidden){event.preventDefault();event.stopPropagation();suggestions.hidden=true;input.setAttribute('aria-expanded','false');return;}
      if((event.key==='ArrowDown' || event.key==='ArrowUp') && matches.length){event.preventDefault();active=active<0?(event.key==='ArrowDown'?0:matches.length-1):(active+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;for(const [index,row] of [...suggestions.children].entries())row.setAttribute('aria-selected',String(index===active));input.setAttribute('aria-activedescendant',`vordleOption${active}`);suggestions.children[active]?.scrollIntoView({block:'nearest'});}
      if(event.key==='Enter' && !suggestions.hidden){event.preventDefault();if(active>=0)select(matches[active]);else if(matches.length===1)select(matches[0]);}
    });
    dialog.addEventListener('click',event=>{if(!searchWrap.contains(event.target)){suggestions.hidden=true;input.setAttribute('aria-expanded','false');}});
    function render(){
      const current=progress(),guesses=current.guesses,done=!current.canGuess;
      dayLabel.textContent=state.day?`${state.day.day.split('-').reverse().join('.')} · ${state.day.albumCount.toLocaleString('de')} Alben · für alle gleich`:'';
      sub.textContent=current.lost?`${guesses.length} Versuche · X/${MAX_GUESSES}${current.practicing?' · Endlosmodus':''}`:`${guesses.length} von ${MAX_GUESSES} Versuchen`;
      hints.replaceChildren();
      if(!current.uncovered){hints.append(el('span',guesses.length>=5?'is-unlocked':'',guesses.length>=5?`Artist beginnt mit: ${initialHint(state.day?.answer.artist)}`:'Artist-Hinweis ab Tipp 5'),el('span',guesses.length>=8?'is-unlocked':'',guesses.length>=8?`Titel beginnt mit: ${initialHint(state.day?.answer.title)}`:'Titel-Hinweis ab Tipp 8'));}
      coverFigure.hidden=!state.day;
      const coverUrl=validCoverUrl(state.day?.answer.coverUrl);
      if(coverUrl && coverImage.getAttribute('src')!==coverUrl){failedCoverUrl='';coverImage.src=coverUrl;coverImage.hidden=false;}
      if(!coverUrl){coverImage.removeAttribute('src');coverImage.hidden=true;}
      coverPlaceholder.hidden=!coverImage.hidden;
      coverImage.style.filter=`blur(${coverBlur(guesses.length,current.uncovered)}px)`;
      coverImage.style.transform=current.uncovered?'scale(1)':'scale(1.15)';
      coverImage.alt=current.uncovered?`Cover: ${state.day?.answer.artist} – ${state.day?.answer.title}`:'Verschwommenes Cover des gesuchten Albums';
      coverCaption.textContent=failedCoverUrl===coverUrl && coverUrl?'Cover konnte nicht geladen werden. Du kannst mit den Tabellenhinweisen weiterraten.':coverUrl?(current.uncovered?'Das gesuchte Cover':current.practicing?'Weiterspielen · Cover bleibt fast sichtbar':`Cover-Hinweis · wird mit jedem Fehlversuch schärfer`):'Dieses bereits angelegte Tagesrätsel hat noch keinen Cover-Hinweis.';
      input.disabled=state.loading || state.busy || done || !state.catalogue.length;submit.disabled=input.disabled || !state.selected;
      tbody.replaceChildren();const byId=new Map(state.catalogue.map(album=>[album.id,album]));
      for(const [guessIndex,id] of Array.from(guesses.entries()).reverse()){const album=byId.get(id);if(!album)continue;const hints=feedback(album,state.day.answer),row=el('tr');
        const values={title:album.title,artist:album.artist,year:album.year || '—',genres:hints.genres.matches.join(', '),format:album.format || '—',price:album.price==null?'—':`${album.price.toLocaleString('de',{minimumFractionDigits:2,maximumFractionDigits:2})} ${album.currency}`};
        for(const field of ['title','artist','year','genres','format','price']){const hint=hints[field],cell=el('td',`vordle-cell is-${hint.state}`);cell.setAttribute('data-label',({title:'Album',artist:'Artist',year:'Jahr',genres:'Genre',format:'Format',price:'Preis'})[field]+(field==='title'?` · ${guessIndex+1}`:''));cell.setAttribute('aria-label',`${values[field]}: ${{correct:'Passt',partial:'Teilweise passend',wrong:'Passt nicht',unknown:'Unbekannt'}[hint.state]}. ${hint.hint}`);cell.title=`${values[field]} · ${hint.hint}`;cell.append(el('span','vordle-cell-value',values[field]),el('span',`vordle-cell-mark${hint.tone?' is-'+hint.tone:''}`,hint.arrow || {correct:'✓',partial:'≈',wrong:'×',unknown:'–'}[hint.state]));if(field==='title' && guessIndex>=current.official.length)cell.append(el('small','vordle-practice-tag','Weiterspielen'));row.append(cell);}tbody.append(row);
      }
      gridWrap.scrollTop=0;
      solution.hidden=!current.uncovered;solution.replaceChildren();
      if(current.uncovered){const album=state.day.answer;solution.append(el('strong',null,album.title),el('span','vordle-solution-artist',album.artist),el('p',null,[album.year,album.format,album.price==null?'':`${album.price.toLocaleString('de')} ${album.currency}`,album.genres.join(', ')].filter(Boolean).join(' · ')));}
      reveal.hidden=current.uncovered || !current.lost;reveal.classList.toggle('is-practicing',current.practicing);reveal.replaceChildren();
      if(current.uncovered){
        sub.textContent=state.score?.solved?`Gefunden in ${current.official.length}/${MAX_GUESSES} Versuchen`:current.practiceSolved?`Gefunden nach ${guesses.length} Versuchen · X/${MAX_GUESSES}`:`Aufgedeckt nach ${guesses.length} Versuchen · X/${MAX_GUESSES}`;
        setStatus(state.score?.solved?'Dein Ergebnis ist gespeichert. Vergleiche dich mit den anderen Spielern.':`Dein gewertetes Ergebnis bleibt X/${MAX_GUESSES}.`);
      } else if(current.lost){
        reveal.append(el('strong',null,current.practicing?'Weiterspielen ohne Wertung':'Zehn Versuche gespielt – die Lösung bleibt verborgen.'),el('p',null,`Gewertetes Ergebnis: X/${MAX_GUESSES}. Zusätzliche Tipps verändern die Rangliste nicht.`));
        if(!current.practicing){const keepPlaying=el('button','vordle-continue','Weiterspielen');keepPlaying.type='button';keepPlaying.onclick=()=>{state.practice.active=true;savePractice();clearSelection();render();input.focus();};reveal.append(keepPlaying);}
        if(current.practicing){const uncover=el('button','vordle-uncover','Lösung aufdecken');uncover.type='button';uncover.onclick=()=>{state.practice.revealed=true;state.practice.active=false;savePractice();clearSelection();render();void syncPracticeResult();};reveal.append(uncover);}
        setStatus(current.practicing?`${guesses.length} Versuche insgesamt · Endlosmodus`:'10 Versuche erreicht · Weiterspielen möglich.');
      } else if(!state.loading && state.day)setStatus(`${guesses.length} von ${MAX_GUESSES} Versuchen · Welches Album ist es?`);
      renderRanking();
    }
    async function submitGuess(event){event.preventDefault();if(state.busy || state.loading || !state.selected || !canGuess())return;
      if(dayKey()!==state.day?.day){await open();setStatus('Ein neuer Tag hat begonnen. Hier ist das neue Vordle.');return;}
      const user=liveUser(),epoch=state.epoch,day=state.day,album=state.selected,partId=state.parts.get(album.id);if(!partId)return;
      if(progress().practicing){
        if(progress().guesses.includes(album.id)){setStatus('Dieses Album hast du bereits versucht.',true);return;}
        state.practice.guesses.push(album.id);savePractice();clearSelection();input.value='';suggestions.hidden=true;render();await syncPracticeResult();if(canGuess())input.focus();return;
      }
      state.busy=true;render();setStatus('Dein Tipp wird gespeichert …');
      try{
        const ref=dayRef(day.day).collection('scores').doc(user.uid);
        const saved=await track(db.runTransaction(async transaction=>{const existing=await transaction.get(ref);const result=nextScore(existing.exists?existing.data():null,album.id,day.answer.id,user,day.day,partId);transaction.set(ref,{...result,updatedAt:serverTimestamp()});return result;}));
        if(!sameUser(user.uid,epoch) || state.day?.day!==day.day)return;
        state.score=saved;state.scores=state.scores.filter(score=>score.uid!==user.uid).concat(saved);clearSelection();input.value='';suggestions.hidden=true;render();
        if(saved.solved)void loadScores(true);
        if(!saved.solved && saved.attempts<MAX_GUESSES)input.focus();
      }catch(error){
        if(!sameUser(user.uid,epoch))return;
        try{const snapshot=await track(dayRef(day.day).collection('scores').doc(user.uid).get({source:'server'}));if(snapshot.exists)state.score=snapshot.data();if(state.score?.guesses?.includes(state.selected?.id))clearSelection();}catch{}
        render();setStatus(errorMessage(error),true);
      }finally{if(sameUser(user.uid,epoch)){state.busy=false;input.disabled=state.loading || !canGuess();submit.disabled=input.disabled || !state.selected;}}
    }
    form.addEventListener('submit',submitGuess);refresh.onclick=async()=>{await syncPracticeResult();await loadScores();};
    async function prewarm(){try{await ensureDay();}catch(error){if(state.open)throw error;console.warn('Vordle:',error.code || error.message);} }
    async function open(){
      if(state.loading || state.busy)return;state.open=true;showTab('game');if(!dialog.open)dialog.showModal();state.loading=true;retry.hidden=true;setStatus('Vordle wird geladen …');render();
      const uid=getUser()?.uid,epoch=state.epoch;
      try{
        const day=await ensureDay(true);await loadCatalogue(day);if(!sameUser(uid,epoch))return;
        const snapshot=await track(dayRef(day.day).collection('scores').doc(uid).get({source:'server'}));if(!sameUser(uid,epoch))return;
        state.score=snapshot.exists?snapshot.data():null;loadPractice();clearSelection();input.value='';state.loading=false;render();await syncPracticeResult();void loadScores();if(canGuess())input.focus();
      }catch(error){if(sameUser(uid,epoch)){setStatus(errorMessage(error),true);retry.hidden=false;}}
      finally{if(sameUser(uid,epoch)){state.loading=false;input.disabled=retry.hidden===false || !canGuess();}}
    }
    function reset(){state.epoch++;clearTimeout(state.timer);state.day=null;state.dayPromise=null;state.cataloguePromise=null;state.rankingPromise=null;state.score=null;state.scores=[];state.practiceResults.clear();state.selected=null;state.catalogue=[];state.catalogueDay=null;state.catalogueStamp=null;state.parts.clear();state.loading=false;state.busy=false;state.open=false;clearPractice();if(dialog.open)dialog.close();}
    dialog.addEventListener('close',()=>{state.open=false;suggestions.hidden=true;});
    document.getElementById('vordleLaunch')?.addEventListener('click',()=>void open());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden && getUser()?.uid && state.day?.day!==dayKey())void (state.open?open():prewarm());});
    return {open,prewarm,reset,state};
  }
  global.Vordle={initialHint,validCoverUrl,coverBlur,gameProgress,create,dayKey,dayBounds,albumIdentity,candidateFromItem,deduplicateCandidates,catalogueFromItems,catalogueParts,feedback,nextScore,MAX_GUESSES};
})(globalThis);
