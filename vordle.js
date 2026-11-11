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
  function albumIdentity(album) { return `${normalize(album.artist)}\u0000${normalize(album.title)}`; }
  function candidateFromItem(item) {
    const title = text(item.title).slice(0,240), artist = text(item.artist).slice(0,240);
    if (!normalize(title) || !normalize(artist)) return null;
    const yearValue = Number(item.year), priceValue = Number(item.discogsLowestPrice);
    const genreValues = Array.isArray(item.genre) ? item.genre : String(item.genre || '').split(',');
    const genres = [...new Map(genreValues.map(value => [normalize(value),text(value).slice(0,64)]).filter(([key])=>key)).values()].slice(0,12);
    return {title,artist,year:Number.isInteger(yearValue) && yearValue>=1000 && yearValue<=3000?yearValue:null,genres,
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
      if(!previous || quality(candidate)>quality(previous) || quality(candidate)===quality(previous) && JSON.stringify(candidate)<JSON.stringify(previous))map.set(key,candidate);
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
    for(const album of albums){const bytes=new TextEncoder().encode(JSON.stringify(album)).length+40;
      if(size+bytes>maxBytes && items.length){parts.push(items);items=[];size=0;}items.push(album);size+=bytes;}
    if(items.length)parts.push(items);
    return parts.map((items,index)=>({id:`p${String(index).padStart(4,'0')}`,items,albumIds:items.map(album=>album.id)}));
  }
  function feedback(guess, answer) {
    const won=guess.id===answer.id;
    const numeric=(value,target)=>value==null || target==null?{state:'unknown',hint:'Keine Vergleichsdaten'}:value===target?{state:'correct',hint:'Stimmt'}:{state:'wrong',arrow:target>value?'↑':'↓',hint:target>value?'Gesucht ist ein höherer Wert':'Gesucht ist ein niedrigerer Wert'};
    return {
      title:{state:won?'correct':normalize(guess.title)===normalize(answer.title)?'partial':'wrong',hint:won?'Richtiges Album':normalize(guess.title)===normalize(answer.title)?'Gleicher Titel, anderer Artist':'Anderer Titel'},
      artist:{state:won?'correct':normalize(guess.artist)===normalize(answer.artist)?'partial':'wrong',hint:won?'Richtiger Artist':normalize(guess.artist)===normalize(answer.artist)?'Richtiger Artist, anderes Album':'Anderer Artist'},
      year:numeric(guess.year,answer.year),
      genres:{state:!guess.genres.length || !answer.genres.length?'unknown':guess.genres.some(genre=>answer.genres.some(other=>normalize(other)===normalize(genre)))?'correct':'wrong',hint:'Mindestens ein gemeinsames Genre ergibt grün'},
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
    const state={day:null,catalogue:[],parts:new Map(),score:null,scores:[],loading:false,busy:false,selected:null,open:false,epoch:0,timer:null,dayPromise:null,cataloguePromise:null,rankingPromise:null};
    const el=(tag,className,content)=>{const node=document.createElement(tag);if(className)node.className=className;if(content!=null)node.textContent=content;return node;};
    const dialog=el('dialog','vordle-dialog');dialog.setAttribute('aria-labelledby','vordleTitle');
    const hero=el('header','vordle-hero'),wordmark=el('div','vordle-wordmark');
    wordmark.append(el('span','vordle-record','◉'));
    const title=el('h2',null,'Vordle');title.id='vordleTitle';wordmark.append(title,el('span','vordle-daily-label','DAILY VINYL'));
    const close=el('button','vordle-close','×');close.type='button';close.setAttribute('aria-label','Vordle schließen');close.onclick=()=>dialog.close();hero.append(wordmark,close);
    const sub=el('p','vordle-subtitle','Eine Platte. Alle Sammlungen. Zehn Versuche.');
    const dayLabel=el('p','vordle-day');const status=el('p','vordle-status');status.setAttribute('role','status');
    const attempts=el('div','vordle-attempts');attempts.setAttribute('aria-label','Zehn Versuche');
    const help=el('details','vordle-help');help.append(el('summary',null,'So funktioniert’s'));
    help.append(el('p',null,'Errate ein Album aus den Sammlungen aller Nutzer. Titel und Artist werden gelb, wenn sie passen, aber das Album noch falsch ist. Genre ist grün, sobald mindestens eines übereinstimmt; Format bei gleicher Veröffentlichungsart. ↑ bedeutet: neueres Jahr oder höherer Preis gesucht. ↓ bedeutet: älter oder günstiger. Fehlende Daten bleiben grau. Preise sind eingefrorene Discogs-Ab-Preise, keine Kaufpreise. Jeden Tag um 00:00 Uhr in Berlin beginnt ein neues Spiel.'));
    const form=el('form','vordle-form'),label=el('label',null,'Dein Album-Tipp');label.htmlFor='vordleSearch';
    const input=el('input');input.id='vordleSearch';input.type='search';input.placeholder='Artist oder Album suchen …';input.autocomplete='off';input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','vordleSuggestions');input.setAttribute('aria-expanded','false');
    const suggestions=el('ul','vordle-suggestions');suggestions.id='vordleSuggestions';suggestions.setAttribute('role','listbox');suggestions.hidden=true;
    const submit=el('button','vordle-submit','Tipp abgeben');submit.type='submit';submit.disabled=true;
    const searchWrap=el('div','vordle-search-wrap');searchWrap.append(input,suggestions);form.append(label,searchWrap,submit);
    const legend=el('p','vordle-legend','✓ passt · ≈ Titel/Artist passt · ↑ / ↓ Richtung zum gesuchten Album · – unbekannt');
    const gridWrap=el('div','vordle-grid-wrap'),grid=el('table','vordle-grid'),thead=el('thead'),head=el('tr');
    for(const label of ['Album','Artist','Jahr','Genre','Format','Preis'])head.append(el('th',null,label));thead.append(head);
    const tbody=el('tbody');grid.append(thead,tbody);gridWrap.append(grid);
    const reveal=el('div','vordle-reveal');reveal.hidden=true;
    const ranking=el('section','vordle-ranking'),rankingHead=el('div','vordle-ranking-head'),rankingTitle=el('h3',null,'Heute auf dem Plattenteller');
    const refresh=el('button','vordle-ranking-refresh','Ergebnisse aktualisieren');refresh.type='button';
    const rankingStatus=el('p','vordle-ranking-status');rankingStatus.setAttribute('role','status');
    const rankingList=el('ol','vordle-ranking-list');rankingHead.append(rankingTitle,refresh);ranking.append(rankingHead,rankingStatus,rankingList);
    const retry=el('button','vordle-retry','Erneut laden');retry.type='button';retry.hidden=true;retry.onclick=()=>open();
    dialog.append(hero,sub,dayLabel,attempts,status,retry,help,form,legend,gridWrap,reveal,ranking);document.body.append(dialog);
    let matches=[],active=-1;
    const dayRef=key=>db.collection('vordleDays').doc(key);
    const liveUser=()=>{const user=getUser();if(!user?.uid)throw new Error('Bitte melde dich an, um Vordle zu spielen.');return user;};
    const sameUser=(uid,epoch)=>getUser()?.uid===uid && epoch===state.epoch;
    const errorMessage=error=>error?.code==='permission-denied'?'Firebase hat den Vordle-Zugriff abgelehnt. Bitte prüfen, ob die aktuellen Vordle-Regeln veröffentlicht sind und die Gerätezeit stimmt.':error?.message || 'Vordle konnte nicht geladen werden. Bitte erneut versuchen.';
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
    async function ensureDay() {
      const user=liveUser(),key=dayKey(),epoch=state.epoch;
      if(state.day?.day===key)return state.day;
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
          const answer=catalogue[Math.floor(random[0]/4294967296*catalogue.length)];
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
        if(!sameUser(user.uid,epoch))throw new Error('Die Sitzung hat sich geändert.');
        if(day.version!==VERSION || day.day!==key || !day.answer?.id || !Array.isArray(day.partIds))throw new Error('Das Tagesrätsel hat ein unbekanntes Format.');
        if(dayKey()!==key)throw new Error('Ein neuer Vordle-Tag hat begonnen. Bitte erneut laden.');
        if(state.catalogueDay && state.catalogueDay!==key){state.catalogue=[];state.score=null;state.scores=[];state.selected=null;}
        state.day=day;scheduleMidnight();return day;
      })();
      state.dayPromise={key,promise};
      try{return await promise;}finally{if(state.dayPromise?.promise===promise)state.dayPromise=null;}
    }
    async function loadCatalogue(day) {
      if(state.catalogueDay===day.day && state.catalogue.length)return;
      if(state.cataloguePromise?.key===day.day)return state.cataloguePromise.promise;
      const promise=(async()=>{
        let parts=null;
        try {const saved=JSON.parse(localStorage.getItem('vordleCatalogueV1') || 'null');if(saved?.day===day.day && JSON.stringify(saved.partIds)===JSON.stringify(day.partIds))parts=saved.parts;}catch{}
        if(!Array.isArray(parts))parts=await Promise.all(day.partIds.map(async id=>{const snap=await track(dayRef(day.day).collection('catalogue').doc(id).get({source:'server'}));if(!snap.exists)throw new Error('Der Vordle-Katalog ist unvollständig.');return {id,...snap.data()};}));
        const catalogue=parts.flatMap(part=>part.items || []);
        if(catalogue.length!==day.albumCount || !catalogue.some(album=>album.id===day.answer.id))throw new Error('Der Vordle-Katalog ist unvollständig. Bitte erneut laden.');
        if(state.day?.day!==day.day)return;
        state.catalogue=catalogue;state.catalogueDay=day.day;state.parts=new Map(parts.flatMap(part=>part.items.map(album=>[album.id,part.id])));
        try{localStorage.setItem('vordleCatalogueV1',JSON.stringify({day:day.day,partIds:day.partIds,parts}));}catch{}
      })();
      state.cataloguePromise={key:day.day,promise};try{await promise;}finally{if(state.cataloguePromise?.promise===promise)state.cataloguePromise=null;}
    }
    async function loadScores(force=false) {
      if(!state.day || !state.open)return;
      const day=state.day.day,uid=getUser()?.uid,epoch=state.epoch;
      if(state.rankingPromise){await state.rankingPromise;if(force && state.open)return loadScores();return;}
      refresh.disabled=true;rankingStatus.textContent='Ergebnisse werden geladen …';
      const promise=(async()=>{
        try{const snap=await track(dayRef(day).collection('scores').get({source:'server'}));if(!sameUser(uid,epoch) || state.day?.day!==day)return;state.scores=snap.docs.map(doc=>doc.data()).filter(score=>score.uid!==uid);if(state.score)state.scores.push(state.score);rankingStatus.textContent='';renderRanking();}
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
        row.append(el('span','vordle-rank',score.solved?String(rank).padStart(2,'0'):'—'),el('span','vordle-player-name',score.username+(score.uid===getUser()?.uid?' · du':'')),el('strong',score.solved?'vordle-score-won':'',score.solved?`${score.attempts}/${MAX_GUESSES}`:score.attempts>=MAX_GUESSES?`X/${MAX_GUESSES}`:`${score.attempts} Versuche`));rankingList.append(row);
      }
    }
    function clearSelection(){state.selected=null;active=-1;submit.disabled=true;input.removeAttribute('aria-activedescendant');}
    function select(album){state.selected=album;input.value=`${album.artist} – ${album.title}`;suggestions.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');submit.disabled=state.loading || state.busy;submit.focus();}
    function search(){clearSelection();suggestions.replaceChildren();const query=normalize(input.value),guessed=state.score?.guesses || [];
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
      const guesses=state.score?.guesses || [],done=state.score?.solved || guesses.length>=MAX_GUESSES;
      dayLabel.textContent=state.day?`${state.day.day.split('-').reverse().join('.')} · ${state.day.albumCount.toLocaleString('de')} Alben · für alle gleich`:'';
      attempts.replaceChildren();for(let index=0;index<MAX_GUESSES;index++){const dot=el('span',index<guesses.length?'is-used':'',String(index+1));if(state.score?.solved && index===guesses.length-1)dot.classList.add('is-solved');attempts.append(dot);}
      input.disabled=state.loading || state.busy || done || !state.catalogue.length;submit.disabled=input.disabled || !state.selected;
      tbody.replaceChildren();const byId=new Map(state.catalogue.map(album=>[album.id,album]));
      for(const id of guesses){const album=byId.get(id);if(!album)continue;const hints=feedback(album,state.day.answer),row=el('tr');
        const values={title:album.title,artist:album.artist,year:album.year || '—',genres:album.genres.join(', ') || '—',format:album.format || '—',price:album.price==null?'—':`${album.price.toLocaleString('de',{minimumFractionDigits:2,maximumFractionDigits:2})} ${album.currency}`};
        for(const field of ['title','artist','year','genres','format','price']){const hint=hints[field],cell=el('td',`vordle-cell is-${hint.state}`);cell.setAttribute('aria-label',`${values[field]}: ${{correct:'Passt',partial:'Teilweise passend',wrong:'Passt nicht',unknown:'Unbekannt'}[hint.state]}. ${hint.hint}`);cell.title=hint.hint;cell.append(el('span','vordle-cell-value',values[field]),el('span','vordle-cell-mark',hint.arrow || {correct:'✓',partial:'≈',wrong:'×',unknown:'–'}[hint.state]));row.append(cell);}tbody.append(row);
      }
      reveal.hidden=!done;reveal.replaceChildren();
      if(done){reveal.append(el('strong',null,state.score.solved?`Gefunden in ${guesses.length} von ${MAX_GUESSES} Versuchen!`:'Heute blieb die Platte im Sleeve.'),el('p',null,`Gesucht: ${state.day.answer.artist} – ${state.day.answer.title}`));setStatus('Dein Ergebnis ist gespeichert. Morgen liegt die nächste Platte bereit.');}
      else if(!state.loading && state.day)setStatus(`${guesses.length} von ${MAX_GUESSES} Versuchen · Welches Album ist es?`);
      renderRanking();
    }
    async function submitGuess(event){event.preventDefault();if(state.busy || state.loading || !state.selected)return;
      if(dayKey()!==state.day?.day){await open();setStatus('Ein neuer Tag hat begonnen. Hier ist das neue Vordle.');return;}
      const user=liveUser(),epoch=state.epoch,day=state.day,album=state.selected,partId=state.parts.get(album.id);if(!partId)return;
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
      }finally{if(sameUser(user.uid,epoch)){state.busy=false;input.disabled=state.loading || state.score?.solved || (state.score?.guesses?.length || 0)>=MAX_GUESSES;submit.disabled=input.disabled || !state.selected;}}
    }
    form.addEventListener('submit',submitGuess);refresh.onclick=()=>loadScores();
    async function prewarm(){try{await ensureDay();}catch(error){if(state.open)throw error;console.warn('Vordle:',error.code || error.message);} }
    async function open(){
      if(state.loading || state.busy)return;state.open=true;if(!dialog.open)dialog.showModal();state.loading=true;retry.hidden=true;setStatus('Vordle wird geladen …');render();
      const uid=getUser()?.uid,epoch=state.epoch;
      try{
        const day=await ensureDay();await loadCatalogue(day);if(!sameUser(uid,epoch))return;
        const snapshot=await track(dayRef(day.day).collection('scores').doc(uid).get({source:'server'}));if(!sameUser(uid,epoch))return;
        state.score=snapshot.exists?snapshot.data():null;clearSelection();input.value='';state.loading=false;render();void loadScores();if(!state.score?.solved && (state.score?.attempts || 0)<MAX_GUESSES)input.focus();
      }catch(error){if(sameUser(uid,epoch)){setStatus(errorMessage(error),true);retry.hidden=false;}}
      finally{if(sameUser(uid,epoch)){state.loading=false;input.disabled=retry.hidden===false || state.score?.solved || (state.score?.attempts || 0)>=MAX_GUESSES;}}
    }
    function reset(){state.epoch++;clearTimeout(state.timer);state.day=null;state.dayPromise=null;state.cataloguePromise=null;state.rankingPromise=null;state.score=null;state.scores=[];state.selected=null;state.catalogue=[];state.catalogueDay=null;state.parts.clear();state.loading=false;state.busy=false;state.open=false;if(dialog.open)dialog.close();}
    dialog.addEventListener('close',()=>{state.open=false;suggestions.hidden=true;});
    document.getElementById('vordleLaunch')?.addEventListener('click',()=>void open());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden && getUser()?.uid && state.day?.day!==dayKey())void (state.open?open():prewarm());});
    return {open,prewarm,reset,state};
  }
  global.Vordle={create,dayKey,dayBounds,albumIdentity,candidateFromItem,deduplicateCandidates,catalogueFromItems,catalogueParts,feedback,nextScore,MAX_GUESSES};
})(globalThis);
