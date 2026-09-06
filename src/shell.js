// The Shell's half of the Bridge and the annotation layer, inlined into the Shell page after its
// constants: ART (the Artifact origin), CANVAS, READY, VERSION (the Version on screen), WHO (the
// name in the header), API (this view's annotations URL), MOUNT (this caller's door), VERSION_URL
// (where this view goes when a Version lands, minus the number; null and it reloads in place),
// WRITER (whether this view could mint the next Version when it loaded) and T (every string this
// script shows, in the page's language — the interpolating ones are functions). The
// Shell sees the Artifact's rectangle and the rectangles the runtime reports — nothing inside the
// page (ADR-0011). Mirrors Claude Code Artifacts' viewer (ticket 04).
const DB=MOUNT+'/db',VERSIONS=MOUNT+'/versions';
// An Annotation always comes from a Reader (CONTEXT.md). The Publisher's Version view (spec §12)
// reads them all — pins, drawer, cards — and makes none: no button, no mode, no card action.
const READONLY=READY.me.isOwner;
const f=document.getElementById('f'),stage=document.getElementById('stage'),overlay=document.getElementById('overlay');
const $=id=>document.getElementById(id);
let h=0,s=1,hello=false;
// One geometry for everyone: the page is laid out at its declared Canvas width and scaled to the
// viewport, up or down — phone and desktop see the same picture, which is what lets an Annotation's
// rectangle be scaled by one factor. The iframe never scrolls; its height is what the beacon reports.
function fit(){s=stage.clientWidth/CANVAS;f.style.width=CANVAS+'px';f.style.height=h+'px';f.style.transform='scale('+s+')';stage.style.height=Math.round(h*s)+'px';bubbles();}
const send=m=>f.contentWindow.postMessage(m,ART);

// --- the bridge's shell half (ADR-0010) ------------------------------------------
// Every capability call the framed page makes is answered from here, over our origin and with
// our credential. `db` has a door; anything else is a method this Shell does not serve — which
// is a rejection code on the call, never a missing namespace, so a page shows "read-only"
// rather than "unsupported".
async function onCall(m){
  let out;
  // One question, one answer, always: a throw in here would otherwise leave the page's promise
  // pending forever, and the contract has every call resolve or reject. An unknown code reads
  // as `unavailable` on the page anyway, which is what a Shell that just broke amounts to.
  try{
    out=m.cap==='db'?await rpc({method:m.method,...m.args})
      :m.cap==='artifact'&&m.method==='publish'?await publish(m.args.html)
      :m.cap==='downloads'&&m.method==='save'?await save(m.args)
      :{error:{code:'capability_removed',message:m.cap+'.'+m.method+' is not served here'}};
  }catch(e){out={error:{code:'unavailable',message:String(e&&e.message||e)}};}
  send(out.error?{type:'result',id:m.id,error:out.error}:{type:'result',id:m.id,ok:out});
}
// Every open view follows the Version that lands (spec §9). The Reader's link re-serves whatever
// is live — or the frozen one, which is why a reload can also be a no-op — and the Publisher's
// preview names a Version, so it is sent to the new one. Never in this task: a `result` still owed
// to the frame is sent on the microtask that resolves it, and this navigation waits behind that.
const goto=n=>setTimeout(()=>{if(VERSION_URL)location.assign(VERSION_URL+n);else location.reload();});
// `artifact.publish`: the page's own bytes, posted with this view's credential against the Version
// it is running. Win or lose, the view ends up on whatever is live — the winner's, if someone got
// there first. The Canvas is the base Version's and is not ours to declare.
async function publish(html){
  // The Publisher's view of an older Version, or of a frozen Artifact, is a look back, not a place
  // to write from (spec §12): refused here as the contract's `not_writer`, without a request. What
  // changed after this view loaded — a race, a freeze — is still the server's answer below.
  if(!WRITER)return{error:{code:'not_writer',message:'this view cannot publish a Version'}};
  let r,b;
  try{r=await fetch(VERSIONS+'?base='+VERSION,{method:'POST',headers:{'content-type':'text/html'},body:html});b=await r.json();}
  catch(e){return{error:{code:'upstream_error',message:String(e&&e.message||e)}};}
  // The contract's `PublishResult` is the version and nothing else; the reload is the Shell's own.
  if(r.status===201){goto(b.version);return{version:String(b.version)};}
  // A conflict names the winner twice over: `live` on the rejection, as the contract's
  // `ArtifactError` carries it, and the reload this view is already being sent on. Anything else —
  // a dead link, a 500 — has no version to go to, and an unknown code reads as `upstream_error`.
  if(r.status===409){goto(b.live);return{error:{...b.error,live:b.live}};}
  return{error:b.error||{code:'upstream_error',message:'HTTP '+r.status}};
}
// `downloads.save`: the page hands over bytes, we ask, and the anchor that saves the file is
// ours on our origin. The frame cannot do this itself — its sandbox is granted no downloads, so
// a page's own `<a download>` is inert — which is the whole point: nothing leaves the frame
// without whoever is holding the page saying yes to a name and a size they can read (spec §9).
//
// Every rule is enforced here and not in the runtime: that script lives in the Artifact, where a
// page is free to post a `call` of its own making, so nothing arriving over the Bridge is trusted.
// The extension decides the MIME type; a Blob's own type is ignored, as the contract has it.
const MIME={gif:'image/gif',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',
 webm:'video/webm',txt:'text/plain',json:'application/json',md:'text/markdown',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',epub:'application/epub+zip',csv:'text/csv',ttf:'font/ttf',
 html:'text/html',svg:'image/svg+xml',pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
// The same 16 MiB the publish door counts, on the other side of the same rule; the two never meet.
const MAX_SAVE=16*1024*1024;
const sizeText=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(1)+' MiB';
const isData=d=>typeof d==='string'||d instanceof Blob||d instanceof ArrayBuffer||ArrayBuffer.isView(d);
// One undecided prompt at a time, first-wins.
// ponytail: no bucket over recent prompts — the contract's other reason for `rate_limited`. A page
// that asks in a loop gets one modal at a time and one refusal each; count them if that stops being enough.
let asking=false;
async function save(req){
  const bad=message=>({error:{code:'bad_request',message}});
  // 0.2.39's export hook: an opaque token claude.ai hands a page when it asks for a file. We ask
  // for none, so every token is one that was never issued — nothing was stored, and it is not retried.
  if(req.request!==undefined)return{error:{code:'request_unknown',message:'nothing was requested of this page'}};
  if(typeof req.filename!=='string'||req.filename.length>512)return bad('filename must be a string of at most 512 characters');
  if(!isData(req.data))return bad('data must be a string, Blob, ArrayBuffer or view');
  // The final name, which is the one on screen: one segment — a path the page wrote is not ours
  // to honour — with the characters no file system wants taken out.
  const name=req.filename.split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g,'').trim();
  const ext=/^(.+)\.([A-Za-z0-9]+)$/.exec(name);
  const type=ext&&MIME[ext[2].toLowerCase()];
  if(!type)return{error:{code:'rejected_extension',message:'not an extension that can be saved: '+name}};
  const blob=new Blob([req.data],{type});
  // Empty, or a buffer whose bytes were transferred away before they got here.
  if(!blob.size)return bad('data is empty');
  if(blob.size>MAX_SAVE)return{error:{code:'too_large',message:'at most 16 MiB'}};
  if(asking)return{error:{code:'rate_limited',message:'a save is already waiting to be confirmed'}};
  asking=true;
  let yes;
  try{yes=await ask(name,blob.size);}finally{asking=false;}
  if(!yes)return{error:{code:'declined',message:'the save was refused'}};
  const url=URL.createObjectURL(blob);
  // In the document before the click and out after it: a detached anchor downloads nothing in
  // WebKit, which is what most first opens are (CLAUDE.md).
  // ponytail: an in-app WebView may still swallow the download where nothing can see it — which the
  // contract allows, `saved` meaning handed to the host's save surface, not landed on a disk.
  const link=document.createElement('a');
  link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();
  // The blob outlives the click by long enough for the browser to have read it, and no longer.
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return{status:'saved'};
}
// Native dialog, native backdrop: Esc counts as a no, which is the contract's "let it expire".
// The name came from the page, so it is written as text and never as markup.
function ask(name,size){
  return new Promise(done=>{
    const d=document.createElement('dialog');
    d.className='ask';
    d.innerHTML=`<b>${T.saveAsk}</b><div class="fn"></div><div class="hint"></div>`+
      `<div class="row"><span class="sp"></span><button class="btn" value="no">${T.cancel}</button><button class="btn pri" value="yes" autofocus>${T.save}</button></div>`;
    d.querySelector('.fn').textContent=name;
    d.querySelector('.hint').textContent=sizeText(size);
    d.onclick=e=>{if(e.target.value)d.close(e.target.value);};
    d.onclose=()=>{d.remove();done(d.returnValue==='yes');};
    document.body.append(d);
    d.showModal();
  });
}

const REVOKED={code:'revoked',message:'this view is no longer live'};
async function rpc(body){
  try{
    const r=await fetch(DB,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    // A revoked link or a deleted Artifact answers `not_found`, which is no `DbErrorCode` at all —
    // and an unknown code reads as `unavailable`, telling the page to retry a store that is gone.
    // The contract's word for a grant that went away under a running page is `revoked`, and it is
    // terminal. Everything else is already a contract code and travels as it is.
    return r.status===404||r.status===401?{error:REVOKED}:await r.json();
  }catch(e){return{error:{code:'unavailable',message:String(e&&e.message||e)}};}
}

// --- subscriptions (spec §10) ------------------------------------------------------
// The Shell holds the table: which `sub` wants which document or query. A document subscription
// is forwarded straight off the stream by path; a query subscription is re-run through the door
// whenever its collection moves, once per animation frame; a reconnect re-runs everything live.
// Every view holds one from the moment it loads, subscriptions or not: a Version landing has to
// reach a page that never listens to a document — the poll page publishing itself is exactly that.
const subs=new Map();
let es=null,opened=false;
const meIn=p=>p.replace(/^data\/users\/me(?=\/|$)/,'data/users/'+READY.me.id);
const collOf=p=>p.slice(0,p.lastIndexOf('/'));
function end(sub,error){if(subs.delete(sub))send({type:'end',sub,error});}
// A refusal that is about *now* rather than about this subscription: the identity's bucket is
// empty (spec §10) or the network blinked. Ending the subscription for one of those would be
// permanent — `end` is at most once — and the door meters this view's own re-runs, so a busy
// collection empties the bucket on its own. Wait, and run it again.
const TRANSIENT={resource_exhausted:1,unavailable:1};
// ponytail: a query re-run reads its whole collection through the door, per event, per subscriber —
// fine for a checklist; a page that streams a busy collection to many Readers would want a diff.
function rerun(sub,s){
  s.pending||=requestAnimationFrame(async()=>{
    s.pending=0;
    const n=s.seq=(s.seq||0)+1;
    const r=await rpc({method:s.method,...s.args});
    // Gone, a reload's namesake, or overtaken by a later re-run while the call was in flight.
    if(subs.get(sub)!==s||n!==s.seq)return;
    if(r.error){
      if(!TRANSIENT[r.error.code])return end(sub,r.error);
      // Doubling, and jittered: a reconnect re-runs every live subscription at once, and sixty
      // listeners retrying in step are what emptied the bucket in the first place.
      s.back=Math.min(5000,(s.back||125)*2);
      return void setTimeout(()=>{if(subs.get(sub)===s)rerun(sub,s);},s.back*(0.5+Math.random()));
    }
    s.back=0;
    send({type:'event',sub,docs:s.method==='get'?[{path:meIn(s.args.path),exists:r.exists,data:r.data,version:r.version}]:r.docs});
  });
}
function stream(){
  es=new EventSource(DB+'/stream');
  es.onopen=()=>{if(opened)for(const [sub,s] of subs)rerun(sub,s);opened=true;};
  es.onmessage=ev=>{
    const e=JSON.parse(ev.data);
    // The one push that is not a document write: somebody published, and this view follows.
    if(e.type==='version')return goto(e.n);
    for(const [sub,s] of subs){
      if(s.method==='get'){if(meIn(s.args.path)===e.path)send({type:'event',sub,docs:[{path:e.path,exists:!!e.doc,data:e.doc??undefined,version:e.version}]});}
      else if(meIn(s.args.collection)===collOf(e.path))rerun(sub,s);
    }
  };
  // A dropped connection comes back on its own; a dead link does not, and neither do its listeners.
  // The next `sub`, if any, opens a fresh stream and meets the same answer.
  es.onerror=()=>{if(es.readyState===EventSource.CLOSED){es=null;for(const sub of [...subs.keys()])end(sub,REVOKED);}};
}
function onSub(m){
  const s={method:m.method,args:m.args,pending:0};
  subs.set(m.sub,s);
  if(!es)stream();
  rerun(m.sub,s);
}

// --- annotation layer ----------------------------------------------------------
let anns=[],rects={},mode=false,draft=null,sel=null,showDone=false,dead=false;
const el=(t,c,html)=>{const e=document.createElement(t);if(c)e.className=c;if(html!=null)e.innerHTML=html;return e;};
const esc=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const initial=n=>[...n][0]||'?';
// The page's own `lang` is the one the server resolved, so the clock and the copy agree.
const RTF=new Intl.RelativeTimeFormat(document.documentElement.lang,{numeric:'always'});
const ago=iso=>{const d=(Date.now()-Date.parse(iso))/6e4;return d<1?T.justNow:d<60?RTF.format(-(d|0),'minute'):d<1440?RTF.format(-((d/60)|0),'hour'):RTF.format(-((d/1440)|0),'day');};
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
// The runtime clamps nothing; every rectangle is boxed to the Canvas here (ADR-0011).
const box=r=>{if(!r||typeof r.x!=='number')return null;const x=clamp(r.x,0,CANVAS),y=clamp(r.y,0,h);return{x,y,w:clamp(r.x+r.w,x,CANVAS)-x,h:clamp(r.y+r.h,y,h)-y};};
const point=(r,pin)=>({x:(r.x+pin.x*r.w)*s,y:(r.y+pin.y*r.h)*s});
const open=()=>anns.filter(a=>a.status==='open');
const onPage=()=>open().filter(a=>rects[a.annotation]);
const detached=()=>open().filter(a=>!rects[a.annotation]);
const done=()=>anns.filter(a=>a.status==='addressed');
const newest=l=>[...l].sort((a,b)=>b.created_at<a.created_at?-1:1);

// A 404 on any call means the link died under us — revoked, or the Artifact was deleted — and
// the page to show is the server's dead-link page, not a toast.
// ponytail: a reload also drops an unsent draft; the link is gone, so there is nowhere to send it.
async function api(path,init){
  const r=await fetch(API+path,{headers:{'content-type':'application/json'},...init});
  if(r.status===404){location.reload();throw new Error('gone');}
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error((e.error&&e.error.message)||('HTTP '+r.status));}
  return r.status===204?null:r.json();
}
// A hello after the ten-second deadline is a bridge for `claude.use`, not a page to pin on.
function onHello(){if(dead)return;if(!READONLY){$('cbtn').disabled=false;$('cbtn').title=T.modeHint;}locate();}
// The whole list, every time it changes: the runtime holds one table and re-resolves it on every render.
function locate(){if(!hello)return;send({type:'locate',anchors:anns.map(a=>({id:a.annotation,path:a.anchor.path,sig:a.anchor.sig,strict:a.version!==VERSION}))});}
function onLocated(r){rects={};for(const id in r)rects[id]=box(r[id]);render();reveal();}
// The webhook's link ends in `#<annotation>` (spec §11): once its bubble has a place, open its
// card there. Until the list has arrived there is nothing to find, so this tries again next time.
let revealed=false;
// A `located` can predate the list — the runtime answering the empty table sent on hello — and says
// nothing about this pin yet. Only one that names it, a rectangle or a null, or the deadline, places the card.
function reveal(){if(revealed)return;const a=anns.find(x=>x.annotation===location.hash.slice(1));if(!a||!(dead||a.annotation in rects))return;revealed=true;show(a);}
function onClick(m){
  if(!mode)return;
  if(draft){flash(T.draftPending);return;}
  const rect=box(m.rect);if(!rect)return;
  draft={path:String(m.path),sig:String(m.sig),pin:{x:clamp(+m.pin.x||0,0,1),y:clamp(+m.pin.y||0,0,1)},rect};
  closeCard();render();compose();
}
function discard(){draft=null;closeCard();render();
}

function render(){
  document.body.classList.toggle('mode',mode);
  if(!READONLY){
    const n=open().length,b=$('cbtn');
    b.setAttribute('aria-pressed',mode);
    b.innerHTML=mode?T.exitMode:T.annotate+(n?` <span class="cnt">${n}</span>`:'');
  }
  $('pill').textContent=T.allAnnotationsN(anns.length);
  bubbles();drawer();
}
// Bubble = the Reader's initial at rect.x + pin.x × rect.w, scaled by the one factor the iframe got.
function bubbles(){
  overlay.querySelectorAll('.bub').forEach(x=>x.remove());
  const shown=[...onPage(),...(showDone?done().filter(a=>rects[a.annotation]):[])];
  for(const a of shown){
    const p=el('button','bub '+a.status+(sel===a.annotation?' sel':''));
    p.setAttribute('aria-label',T.byReader(a.reader));p.dataset.id=a.annotation;
    p.innerHTML=`<span class="av">${esc(initial(a.reader))}</span>`;
    const {x,y}=point(rects[a.annotation],a.anchor.pin);
    p.style.left=x+'px';p.style.top=y+'px';
    p.onclick=e=>{e.stopPropagation();detail(a);};
    overlay.append(p);
  }
  if(draft){
    const p=el('button','bub draft','<span class="av">+</span>');
    const {x,y}=point(draft.rect,draft.pin);
    p.style.left=x+'px';p.style.top=y+'px';p.setAttribute('aria-label',T.draftLabel);
    overlay.append(p);
  }
  piles();
}
// Off-screen bubbles pile into one hint at each edge.
function piles(){
  const bubs=[...overlay.querySelectorAll('.bub:not(.draft)')];
  const top=document.querySelector('header').offsetHeight;
  const above=b=>b.getBoundingClientRect().bottom<top,below=b=>b.getBoundingClientRect().top>innerHeight;
  const set=(id,test,say)=>{const l=bubs.filter(test),e=$(id);e.hidden=!l.length;e.textContent=say(l.length);e.onclick=()=>l[0].scrollIntoView({block:'center',behavior:'smooth'});};
  set('pile-up',above,T.above);set('pile-down',below,T.below);
}
addEventListener('scroll',piles,{passive:true});

// --- cards: fixed beside the bubble, flipped to fit ---------------------------------
function place(card,anchor){
  document.body.append(card);
  const cw=card.offsetWidth,ch=card.offsetHeight;
  if(!anchor){card.style.left='8px';card.style.top=Math.max(8,innerHeight-ch-8)+'px';return;}
  const r=anchor.getBoundingClientRect();
  let x=r.right+8,y=r.top;
  if(x+cw>innerWidth-8)x=Math.max(8,r.left-cw-8);
  if(x+cw>innerWidth-8)x=Math.max(8,innerWidth-cw-8);
  if(y+ch>innerHeight-8)y=r.top-ch-8;
  y=Math.max(8,y);
  card.style.left=x+'px';card.style.top=y+'px';
}
function closeCard(){const c=document.querySelector('.card');if(c)c.remove();sel=null;}
document.addEventListener('click',e=>{if(!e.target.closest('.card,.bub,.drawer,.pill,#cbtn')&&document.querySelector('.card'))discard();});

// One Annotation, in full. Not a thread: nobody replies to it (CONTEXT.md).
function detail(a){
  closeCard();sel=a.annotation;bubbles();
  // Redrawn just now, so the bubble is looked up fresh rather than taken from the caller.
  const anchor=overlay.querySelector(`.bub[data-id="${a.annotation}"]`);
  const lost=!rects[a.annotation];
  const card=el('div','card');
  card.innerHTML=`<div class="author"><span class="av">${esc(initial(a.reader))}</span><b>${esc(a.reader)}</b><span class="time">${ago(a.created_at)}</span></div>
    ${lost?`<div class="hint"><span class="badge detached">${T.detached}</span> ${T.pinnedOn(a.version,a.version===VERSION)}</div>`:''}
    <div class="txt">${esc(a.text)}</div>
    <div class="row"><span class="badge ${a.status}">${a.status==='open'?T.open:T.addressed}</span><span class="sp"></span>
      ${a.mine&&a.status==='open'?`<button class="btn ghost" data-act="del">${T.del}</button>`:''}
      ${a.mine?`<button class="btn" data-act="flip">${a.status==='open'?T.markAddressed:T.reopen}</button>`:''}
      <button class="btn ghost" data-act="close">${T.close}</button></div>`;
  card.onclick=async e=>{
    const act=e.target.dataset&&e.target.dataset.act;if(!act)return;
    try{
      if(act==='flip'){const u=await api('/'+a.annotation,{method:'PATCH',body:JSON.stringify({status:a.status==='open'?'addressed':'open'})});Object.assign(a,u);}
      else if(act==='del'){if(!confirm(T.deleteAnnotationAsk))return;await api('/'+a.annotation,{method:'DELETE'});anns=anns.filter(x=>x!==a);locate();}
    }catch(err){flash(err.message);return;}
    closeCard();render();
  };
  place(card,anchor);
}
function compose(){
  const card=el('div','card');
  card.innerHTML=`<div class="author"><span class="av">${esc(initial(WHO))}</span><b>${esc(WHO)}</b><span class="hint" style="margin-left:auto">${T.nameSetByPublisher}</span></div>
    <textarea placeholder="${T.writeSomething}" maxlength="4096"></textarea>
    <div class="row"><button class="btn ghost" data-act="drop">${T.discard}</button><span class="sp"></span><span class="hint">⌘↵</span><button class="btn pri" data-act="post">${T.send}</button></div>`;
  const ta=card.querySelector('textarea');
  const post=async()=>{
    const text=ta.value.trim();if(!text||!draft)return;
    const {path,pin,sig}=draft;
    try{const a=await api('',{method:'POST',body:JSON.stringify({version:VERSION,anchor:{path,pin,sig},text})});anns.push(a);}
    catch(err){flash(err.message);return;}
    draft=null;closeCard();locate();render();flash(T.sent);
  };
  card.onclick=e=>{const act=e.target.dataset&&e.target.dataset.act;if(act==='post')post();else if(act==='drop')discard();};
  ta.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')post();if(e.key==='Escape')discard();});
  place(card,overlay.querySelector('.bub.draft'));ta.focus();
}

// --- drawer: on the page / not shown on page / addressed ------------------------------------
function row(a){
  const lost=!rects[a.annotation];
  const d=el('div','rowi '+a.status);
  d.innerHTML=`<span class="av">${esc(initial(a.reader))}</span><div class="m"><div class="top"><b>${esc(a.reader)}</b><span class="time">${ago(a.created_at)}</span>
    <span class="bg">${lost?`<span class="badge detached">${T.detached}</span>`:''}${a.status==='addressed'?`<span class="badge addressed">${T.addressed}</span>`:''}</span></div>
    <div class="line">${esc(a.text)}</div></div>`;
  d.onclick=()=>show(a);
  return d;
}
// Go to one: its bubble scrolled into view and its card beside it, or the card alone if it is Detached.
function show(a){
  if(a.status==='addressed'&&!showDone){showDone=true;render();}
  const b=overlay.querySelector(`.bub[data-id="${a.annotation}"]`);
  if(b){b.scrollIntoView({block:'center'});setTimeout(()=>detail(a),250);}else detail(a);
}
function drawer(){
  const body=$('dbody');body.innerHTML='';
  $('dcnt').textContent=open().length?T.openCount(open().length):T.allAddressed;
  if(!anns.length){body.append(el('div','empty',READONLY?T.noAnnotations:T.noAnnotationsYet));return;}
  const grp=(label,list)=>{if(!list.length)return;body.append(el('div','grp',label));newest(list).forEach(a=>body.append(row(a)));};
  grp(T.onPage,onPage());
  grp(T.notShown,detached());
  const dn=done();
  if(dn.length){
    const t=el('button','tog',showDone?T.hideAddressed:T.showAddressed(dn.length));
    t.onclick=()=>{showDone=!showDone;render();};
    body.append(t);
    if(showDone)grp(T.addressed,dn);
  }
}

// --- mode: the button, `c`, Esc ------------------------------------------------------
function setMode(on){
  if(READONLY||(!hello&&on))return;
  mode=on;send({type:'mode',on});
  if(!on){draft=null;closeCard();}
  render();
}
function flash(msg){const t=el('div','pile up');t.textContent=msg;t.style.top='calc(var(--bar) + 44px)';document.body.append(t);setTimeout(()=>t.remove(),1800);}
if(!READONLY)$('cbtn').onclick=()=>setMode(!mode);
$('pill').onclick=()=>$('drawer').classList.toggle('open');
$('dclose').onclick=()=>$('drawer').classList.remove('open');
addEventListener('keydown',e=>{
  if(/INPUT|TEXTAREA/.test(document.activeElement.tagName))return;
  if(e.key==='c'&&!e.metaKey&&!e.ctrlKey&&!e.altKey)setMode(!mode);
  if(e.key==='Escape'){if(mode)setMode(false);else{closeCard();render();}}
});
// The runtime has ten seconds to say hello; until it does there is nothing to pin to — and a card
// the webhook pointed at still opens, unanchored.
setTimeout(()=>{if(!hello){dead=true;if(!READONLY){$('cbtn').disabled=true;$('cbtn').title=T.notReady;}render();reveal();}},10000);
// A list that lands after the deadline gets no `located`, so the reveal it would have had comes here.
api('').then(l=>{anns=l;render();locate();if(dead)reveal();}).catch(err=>flash(err.message));

// Last, once everything above exists: the frame's first message can arrive before the body is parsed.
addEventListener('resize',fit);fit();stream();
addEventListener('message',e=>{
  if(e.source!==f.contentWindow||e.origin!==ART)return;
  const m=e.data||{};
  // A hello is a fresh page: whatever the last one was listening to went with it.
  if(m.type==='hello'){hello=true;subs.clear();send({type:'ready',...READY});onHello();}
  else if(m.type==='height'){h=m.h;fit();}
  else if(m.type==='call')onCall(m);
  else if(m.type==='sub')onSub(m);
  else if(m.type==='unsub')subs.delete(m.sub);
  else if(m.type==='click')onClick(m);
  else if(m.type==='located')onLocated(m.rects||{});
});
