import {EVENT_NAME, rosterFromCSV, mergeRoster, retainReviews, selectGroup, deriveKey, seal, unseal, validateVault, toCSV} from './core.mjs';
import {validateEncryptedRoster,decryptRosterCSV} from './transfer.mjs';

const $ = id => document.getElementById(id);
let db, vault = null, state = null, key = null, salt = null, busy = false, session = 0;
let currentGroupId = null, pendingRestore = null, pendingRoster = null, stream = null, scanFrame = null, scanning = false;
let lastActivity = Date.now(), hiddenAt = null, failedAttempts = 0, retryAfter = 0;
let flaggedGroups = new Set();
const blankState = () => ({version:1,eventName:EVENT_NAME,people:[],importedAt:null,reviews:{}});
const needsReview = groupId => flaggedGroups.has(groupId);
const clock = s => new Date(s).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});

function notify(message, type = '') {
  $('notice').textContent = message; $('notice').className = 'notice ' + type; $('notice').hidden = false;
  if($('group-dialog').open){$('dialog-notice').textContent=message;$('dialog-notice').className='notice '+type;$('dialog-notice').hidden=false;}
  if($('import-dialog').open){$('import-error').textContent=message;$('import-error').hidden=false;}
}
function report(error) { notify(error?.message || '処理に失敗しました。もう一度お試しください。','error'); }
function openDB() {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open('kasado-reception-v1:'+new URL('./',import.meta.url).pathname,1);
    request.onupgradeneeded = () => request.result.createObjectStore('vault');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('端末内の保存領域を開けません。通常のSafariで開いてください。'));
  });
}
function readVault() {
  return new Promise((resolve,reject) => {
    const tx = db.transaction('vault','readonly'), req = tx.objectStore('vault').get('current');
    req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error);
  });
}
function writeVault(next, expected) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction('vault','readwrite'), store = tx.objectStore('vault');
    let conflict = false;
    const request = store.get('current');
    request.onsuccess = () => {
      if ((request.result?.revision ?? null) !== expected) { conflict = true; tx.abort(); return; }
      try{if (next) store.put(next,'current'); else store.delete('current');}catch{tx.abort();}
    };
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(new Error(conflict ? '別の画面で名簿が更新されました。この画面をロックして開き直してください。' : '保存できませんでした。受付は確定していません。端末の空き容量を確認してください。'));
  });
}
async function run(task) {
  if (busy) return;
  busy = true; document.querySelectorAll('button[type="submit"]').forEach(b=>b.disabled=true);
  try { await task(); } catch(e) { report(e); }
  finally { busy = false; document.querySelectorAll('button[type="submit"]').forEach(b=>b.disabled=false);if($('group-dialog').open)updateSelection();lastActivity=Date.now(); }
}
async function commit(next) {
  if (!key || !state) throw new Error('ロックを解除してください。');
  const generation=session, nextVault=await seal(next,key,salt,vault.revision+1);
  await writeVault(nextVault,vault.revision);
  if (generation !== session) return false;
  vault=nextVault; state=next; render(); return true;
}
function gate() {
  $('gate').hidden=false; $('workspace').hidden=true; $('navigation').hidden=true; $('lock').hidden=true;
  const creating=!vault && !pendingRestore;
  $('gate-title').textContent=pendingRestore ? 'バックアップを開く' : creating ? '受付データを保護する' : 'ロックを解除';
  $('gate-help').textContent=pendingRestore ? 'バックアップ保存時のパスフレーズを入力してください。' : creating ? '12文字以上のパスフレーズを設定します。推測されにくい複数の言葉を使い、大切に保管してください。' : 'この端末に保存したデータを復号します。';
  $('confirm-wrap').hidden=!creating;
  $('passphrase-confirm').required=creating;
  $('passphrase').autocomplete=creating ? 'new-password' : 'current-password';
  $('unlock').textContent=pendingRestore ? '復元して開く' : creating ? '設定して始める' : 'ロックを解除';
  $('unlock').disabled=false;
}
function lock(showMessage=true) {
  session++; stopCamera();
  if ($('group-dialog').open) $('group-dialog').close();
  if ($('import-dialog').open) $('import-dialog').close();
  pendingRoster=null;$('import-passphrase').value='';$('import-error').textContent='';
  state=null;key=null;salt=null;currentGroupId=null;flaggedGroups=new Set();
  $('people-list').replaceChildren();$('group-members').replaceChildren();$('manual-id').value='';$('search').value='';
  $('group-title').textContent='来場した方を選択';$('group-status').textContent='';
  $('group-warning').textContent='';$('review-note').value='';$('review-status').textContent='';
  $('dialog-notice').textContent='';$('dialog-notice').hidden=true;
  $('passphrase').value='';$('passphrase-confirm').value='';
  $('notice').hidden=true; gate();
  if (showMessage) notify('ロックしました。受付記録は暗号化して保存されています。');
}
function showWorkspace() {
  $('gate').hidden=true; $('workspace').hidden=false; $('navigation').hidden=false; $('lock').hidden=false;
  $('passphrase').value=''; $('passphrase-confirm').value=''; $('notice').hidden=true;lastActivity=Date.now();render();
}
function render() {
  if (!state) return;
  flaggedGroups=new Set(state.people.filter(p=>p.note.includes('【当日確認】')).map(p=>p.groupId));
  const done=state.people.filter(p=>p.checkedAt).length;
  $('event-name').textContent=state.eventName;
  $('checked-count').replaceChildren(document.createTextNode(String(done)),Object.assign(document.createElement('small'),{textContent:'名'}));
  $('remaining-count').replaceChildren(document.createTextNode(String(state.people.length-done)),Object.assign(document.createElement('small'),{textContent:'枠'}));
  $('group-count').replaceChildren(document.createTextNode(String(new Set(state.people.map(p=>p.groupId)).size)),Object.assign(document.createElement('small'),{textContent:'件'}));
  $('no-roster').hidden=state.people.length>0;$('start-camera').disabled=state.people.length===0;
  $('provisional-note').hidden=!state.people.some(p=>p.note.includes('【当日確認】'));
  $('import-info').textContent=state.importedAt ? `${state.people.length}名 / 最終取り込み ${clock(state.importedAt)}` : 'まだ取り込まれていません。';
  renderList();
}
function switchTab(tab) {
  if (!state) return;
  if (tab!=='scan') stopCamera();
  document.querySelectorAll('.tab-panel').forEach(el=>el.hidden=el.id!=='tab-'+tab);
  document.querySelectorAll('#navigation button').forEach(el=>{el.classList.toggle('active',el.dataset.tab===tab); if(el.dataset.tab===tab)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  $('notice').hidden=true; window.scrollTo({top:0,behavior:'instant'});
}
function renderList() {
  if (!state) return;
  const q=$('search').value.trim().toLocaleLowerCase('ja-JP'), filter=$('filter').value;
  const found=state.people.filter(p=>(!q || [p.name,p.representative,p.groupId].some(s=>s.toLocaleLowerCase('ja-JP').includes(q))) && (filter==='all' || (filter==='review' ? needsReview(p.groupId)&&!state.reviews?.[p.groupId]?.confirmedAt : filter==='checked' ? !!p.checkedAt : !p.checkedAt)));
  $('people-list').replaceChildren(); $('list-count').textContent=`${found.length}名`;
  for(const p of found.slice(0,100)) {
    const button=document.createElement('button'); button.className='person-row';button.type='button';
    const text=document.createElement('span'),name=document.createElement('span'),detail=document.createElement('span'),badge=document.createElement('span');
    name.className='person-name';name.textContent=p.name; detail.className='person-detail';detail.textContent=p.role+' · 代表者 '+p.representative;
    text.append(name,detail);badge.className='badge'+(p.checkedAt?' done':'');badge.textContent=p.checkedAt?'受付済み':'未受付';
    if(needsReview(p.groupId)&&!state.reviews?.[p.groupId]?.confirmedAt){const warning=document.createElement('span');warning.className='review-badge';warning.textContent='当日確認';text.append(warning);}
    button.append(text,badge);
    button.addEventListener('click',()=>showGroup(p.groupId));$('people-list').append(button);
  }
  $('list-limit').textContent=found.length>100 ? '最初の100名を表示しています。氏名で絞り込んでください。' : found.length===0 ? '該当する参加者はいません。' : '';
}
function showGroup(raw) {
  if (!state || busy) return;
  try {
    const members=selectGroup(state.people,raw);currentGroupId=members[0].groupId;
    $('dialog-notice').textContent='';$('dialog-notice').hidden=true;
    $('group-title').textContent=members[0].representative+' さんの申込';renderGroup();
    if(!$('group-dialog').open) $('group-dialog').showModal();
  } catch(e){report(e);}
}
function renderGroup() {
  const selectedIds=new Set(Array.from($('group-members').querySelectorAll('input:checked:not(:disabled)'),el=>el.value));
  const members=state.people.filter(p=>p.groupId===currentGroupId), count=members.filter(p=>p.checkedAt).length;
  $('group-status').textContent=count===members.length ? `全${members.length}枠が受付済みです。二重受付は行いません。` : `${members.length}枠中 ${count}名が受付済み。来場した方を選んでください。`;
  const warnings=[...new Set(members.map(p=>p.note.includes('【当日確認】')?p.note.split('撮影：')[0].trim():'').filter(Boolean))];
  $('group-warning').hidden=!warnings.length;$('group-warning').textContent=warnings.join('\n');
  $('review-section').hidden=!warnings.length;
  const review=state.reviews?.[currentGroupId];
  $('review-note').value=review?.note||'';
  $('review-status').textContent=review?.confirmedAt?'確認済み '+clock(review.confirmedAt):'まだ当日確認を記録していません。';
  $('group-members').replaceChildren();
  for(const p of members) {
    const div=document.createElement('div');div.className='member';
    const label=document.createElement('label'),checkbox=document.createElement('input'),body=document.createElement('span');
    checkbox.type='checkbox';checkbox.name='person';checkbox.value=p.id;checkbox.disabled=!!p.checkedAt;
    checkbox.checked=!p.checkedAt&&selectedIds.has(p.id);
    checkbox.addEventListener('change',updateSelection);
    const name=document.createElement('span');name.textContent=p.name+' / '+p.role;body.append(name);
    if(p.checkedAt){const done=document.createElement('span');done.className='person-detail';done.textContent='受付済み '+clock(p.checkedAt);body.append(done);}
    const memberNote=p.note.includes('【当日確認】')?(p.note.includes('撮影：')?'撮影：'+p.note.split('撮影：').slice(1).join('撮影：'):''):p.note;
    if(memberNote){const note=document.createElement('span');note.className='member-note';note.textContent=memberNote;body.append(note);}
    label.append(checkbox,body);div.append(label);
    if(p.checkedAt){const undo=document.createElement('button');undo.type='button';undo.className='undo';undo.textContent='この方の受付を取り消す';undo.addEventListener('click',()=>run(async()=>{
      if(!confirm(`${p.name} さんの受付を取り消しますか？`))return;
      const next=structuredClone(state);next.people.find(x=>x.id===p.id).checkedAt=null;
      if(await commit(next)){renderGroup();notify('受付を取り消して保存しました。');}
    }));div.append(undo);}
    $('group-members').append(div);
  }
  $('checkin-submit').hidden=count===members.length;
  updateSelection();
}
function updateSelection(){const count=$('group-members').querySelectorAll('input:checked:not(:disabled)').length;$('checkin-submit').textContent=count?`${count}名の受付を確定`:'来場した方を選んでください';$('checkin-submit').disabled=count===0;}
function stopCamera() {
  scanning=false;
  if(scanFrame)cancelAnimationFrame(scanFrame);scanFrame=null;
  if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;
  $('video').srcObject=null;$('video').classList.remove('live');$('camera-idle').hidden=false;
  $('start-camera').hidden=false;$('stop-camera').hidden=true;
}
async function startCamera() {
  if(!state?.people.length || busy || scanning)return;
  if(!navigator.mediaDevices?.getUserMedia){notify('カメラを利用できません。HTTPSのURLをSafariで開き、カメラを許可してください。','error');return;}
  const generation=session;scanning=true;$('start-camera').disabled=true;
  try {
    const s=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    if(generation!==session || !scanning){s.getTracks().forEach(t=>t.stop());return;}
    stream=s;$('video').srcObject=s;await $('video').play();
    $('video').classList.add('live');$('camera-idle').hidden=true;$('start-camera').hidden=true;$('stop-camera').hidden=false;
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let last=0;
    const tick=timestamp=>{
      if(!scanning || !state)return;
      scanFrame=requestAnimationFrame(tick);
      if(timestamp-last<160 || $('group-dialog').open || busy || $('video').readyState<2)return;
      last=timestamp;
      const v=$('video'),scale=Math.min(1,720/v.videoWidth);canvas.width=Math.round(v.videoWidth*scale);canvas.height=Math.round(v.videoHeight*scale);
      ctx.drawImage(v,0,0,canvas.width,canvas.height);const data=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code=window.jsQR(data.data,data.width,data.height,{inversionAttempts:'attemptBoth'});
      if(code){stopCamera();lastActivity=Date.now();showGroup(code.data);}
    };scanFrame=requestAnimationFrame(tick);
  } catch(e){stopCamera();notify(e.name==='NotAllowedError'?'カメラが許可されていません。SafariのWebサイト設定で許可するか、名簿から名前で受付してください。':'カメラを起動できません。ほかのカメラアプリを閉じて、再度お試しください。','error');}
  finally{$('start-camera').disabled=!state?.people.length;}
}
async function saveFile(content,type,name) {
  const file=new File([content],name,{type});
  if(navigator.canShare?.({files:[file]})) {
    try{await navigator.share({files:[file],title:name});return;}catch(e){if(e.name==='AbortError')return;}
  }
  const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-');
async function checkOffline() {
  try {
    const registration=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error()),8000))]),worker=registration.active;
    if(!worker)throw new Error();
    const result=await new Promise((resolve,reject)=>{const channel=new MessageChannel();const timer=setTimeout(()=>reject(new Error()),5000);channel.port1.onmessage=e=>{clearTimeout(timer);resolve(e.data);};worker.postMessage({type:'CHECK_CACHE'},[channel.port2]);});
    if(!result.ready)throw new Error();
    $('offline-state').textContent='オフライン準備完了';$('cache-detail').textContent=`必要ファイル ${result.count}件を保存済み。次に機内モードで起動と受付を確認してください。`;
  } catch {$('offline-state').textContent='オフライン準備未完了';$('cache-detail').textContent='オンラインでホーム画面のアイコンから開き直してください。ファイルを直接開く方法ではオフライン用保存ができません。';}
}

$('unlock-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{
  if(Date.now()<retryAfter)throw new Error('入力を繰り返したため、30秒待ってから試してください。');
  const pass=$('passphrase').value;
  try {
    if(pendingRestore){
      const opened=await unseal(pendingRestore,pass);
      const current=await readVault();
      if(current&&!confirm('この端末の名簿と記録を、選んだバックアップで置き換えますか？ 未保存の記録は失われます。'))return;
      const replacement={...pendingRestore,revision:(current?.revision||0)+1};await writeVault(replacement,current?.revision??null);
      vault=replacement;({state,key,salt}=opened);pendingRestore=null;
    } else {
      vault=await readVault();
      if(vault){({state,key,salt}=await unseal(vault,pass));}
      else{
        if(pass.length<12)throw new Error('パスフレーズは12文字以上にしてください。');
        if(pass!==$('passphrase-confirm').value)throw new Error('2回のパスフレーズが一致しません。');
        const newSalt=crypto.getRandomValues(new Uint8Array(16)),newKey=await deriveKey(pass,newSalt),empty=blankState();
        const encrypted=await seal(empty,newKey,newSalt,1);await writeVault(encrypted,null);
        salt=newSalt;key=newKey;state=empty;vault=encrypted;
      }
    }
    failedAttempts=0;session++;showWorkspace();
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
  }catch(error){
    key=null;salt=null;state=null;failedAttempts++;if(failedAttempts>=5){retryAfter=Date.now()+30000;failedAttempts=0;}
    throw error;
  }finally{$('passphrase').value='';$('passphrase-confirm').value='';}
});});
$('lock').addEventListener('click',()=>lock());
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
$('search').addEventListener('input',renderList);$('filter').addEventListener('change',renderList);
$('manual-form').addEventListener('submit',e=>{e.preventDefault();showGroup($('manual-id').value);});
$('start-camera').addEventListener('click',startCamera);$('stop-camera').addEventListener('click',stopCamera);
$('close-group').addEventListener('click',()=>$('group-dialog').close());
$('group-dialog').addEventListener('close',()=>{$('group-members').replaceChildren();$('review-note').value='';$('group-warning').textContent='';currentGroupId=null;});
$('save-review').addEventListener('click',()=>run(async()=>{
  if(!state||!currentGroupId)throw new Error('申込を開き直してください。');
  const next=structuredClone(state),groupId=currentGroupId;
  next.reviews||={};next.reviews[groupId]={note:$('review-note').value.trim(),confirmedAt:new Date().toISOString()};
  if(await commit(next)){if($('group-dialog').open&&currentGroupId===groupId)renderGroup();notify('当日確認の記録を暗号化して保存しました。','success');}
}));
$('checkin-form').addEventListener('submit',e=>{e.preventDefault();const ids=new Set(new FormData(e.target).getAll('person'));run(async()=>{
  if(!ids.size)throw new Error('来場した方を1名以上選んでください。');
  const next=structuredClone(state),now=new Date().toISOString();let count=0;
  for(const p of next.people)if(p.groupId===currentGroupId&&ids.has(p.id)&&!p.checkedAt){p.checkedAt=now;count++;}
  if(!count)throw new Error('選択された方はすでに受付済みです。');
  if(await commit(next)){$('group-dialog').close();notify(`${count}名の受付を保存しました。`,'success');}
});});
$('roster-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(!file)return;run(async()=>{
  if(!state)throw new Error('先にロックを解除してください。');
  if(!file.name.toLowerCase().endsWith('.json'))throw new Error('平文CSVは取り込みません。「受付名簿を暗号化して書き出す」で保存したJSONを選んでください。');
  if(file.size>20000000)throw new Error('暗号化名簿は20MB以下にしてください。');
  const generation=session;let candidate;
  try{candidate=JSON.parse(await file.text());}catch{throw new Error('暗号化名簿のJSONファイルを選んでください。');}
  validateEncryptedRoster(candidate);
  if(generation!==session)throw new Error('ロックされました。解除して取り込み直してください。');
  pendingRoster=candidate;$('import-passphrase').value='';$('import-error').textContent='';$('import-error').hidden=true;$('import-dialog').showModal();
});});
$('import-cancel').addEventListener('click',()=>$('import-dialog').close());
$('import-dialog').addEventListener('close',()=>{pendingRoster=null;$('import-passphrase').value='';$('import-error').textContent='';});
$('import-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{
  if(!state||!pendingRoster)throw new Error('暗号化名簿を選び直してください。');
  const generation=session,encrypted=pendingRoster,pass=$('import-passphrase').value;
  $('import-passphrase').value='';
  const text=await decryptRosterCSV(encrypted,pass);
  if(generation!==session||!$('import-dialog').open||pendingRoster!==encrypted)throw new Error('取り込みを中断しました。現在の名簿と記録は変更していません。');
  const incoming=rosterFromCSV(text);
  const next={...structuredClone(state),people:mergeRoster(state.people,incoming),reviews:retainReviews(state.people,incoming,state.reviews),importedAt:new Date().toISOString()};
  if(!confirm(`${incoming.length}名・${new Set(incoming.map(p=>p.groupId)).size}件を取り込みます。同じ人物IDの受付記録を引き継ぎます。よろしいですか？`))return;
  if(await commit(next)){$('import-dialog').close();notify(`${incoming.length}名の名簿を暗号化して保存しました。`,'success');}
});});
$('backup').addEventListener('click',()=>run(async()=>{if(!state)throw new Error('ロックを解除してください。');const latest=await readVault();await saveFile(JSON.stringify(latest,null,2),'application/json','受付バックアップ-'+stamp()+'.json');}));
$('restore').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(!file)return;run(async()=>{
  if(file.size>20000000)throw new Error('バックアップが大きすぎます。');
  const candidate=validateVault(JSON.parse(await file.text()));pendingRestore=candidate;lock(false);gate();notify('バックアップを選びました。保存時のパスフレーズを入力してください。');
});});
$('export-csv').addEventListener('click',()=>run(async()=>{
  if(!state)throw new Error('ロックを解除してください。');
  if(!confirm('氏名・受付メモ・受付日時を含む、暗号化されていないCSVを保存します。保存先の管理に注意してください。続けますか？'))return;
  const jst=value=>value?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'';
  const rows=[['受付ID','人物ID','氏名','区分','申込代表者','受付メモ','受付状態','受付日時（日本時間）','当日確認状態','当日確認メモ','当日確認日時（日本時間）'],...state.people.map(p=>{
    const review=state.reviews?.[p.groupId];
    return [p.groupId,p.id,p.name,p.role,p.representative,p.note,p.checkedAt?'受付済み':'未受付',jst(p.checkedAt),needsReview(p.groupId)?(review?.confirmedAt?'確認済み':'未確認'):'対象外',review?.note||'',jst(review?.confirmedAt)];
  })];
  await saveFile(toCSV(rows),'text/csv;charset=utf-8','受付結果-'+stamp()+'.csv');
}));
$('erase').addEventListener('click',()=>run(async()=>{
  if(!state)throw new Error('ロックを解除してください。');
  if(prompt('端末内の名簿と全受付記録を削除します。必要なバックアップを保存してから「削除」と入力してください。')!=='削除')return;
  await writeVault(null,vault.revision);vault=null;pendingRestore=null;lock(false);notify('この端末の名簿と記録を削除しました。');
}));
$('check-offline').addEventListener('click',checkOffline);
for(const event of ['pointerdown','keydown','input'])document.addEventListener(event,()=>lastActivity=Date.now(),{passive:true});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){hiddenAt=Date.now();stopCamera();}
  else if(state&&hiddenAt&&Date.now()-hiddenAt>=30000)lock();
});
setInterval(()=>{if(state&&!busy&&(Date.now()-lastActivity>=180000 || (document.hidden&&hiddenAt&&Date.now()-hiddenAt>=30000)))lock();},1000);
function networkStatus(){$('network').textContent=navigator.onLine?'オンライン':'オフライン';}
window.addEventListener('online',networkStatus);window.addEventListener('offline',networkStatus);networkStatus();

async function init(){
  if(window.top!==window.self)throw new Error('このアプリは単独の画面で開いてください。');
  if(!window.isSecureContext || !crypto.subtle || !('serviceWorker' in navigator))throw new Error('HTTPSのURLをSafariで開いてください。HTMLファイルを直接開く方法ではカメラ・暗号化・オフライン起動を利用できません。');
  db=await openDB();vault=await readVault();gate();
  try{
    const existing=await navigator.serviceWorker.getRegistration('./');
    if(navigator.onLine||!existing?.active)await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    await checkOffline();
  }catch{await checkOffline();}
}
init().catch(e=>{$('gate-title').textContent='起動条件を確認してください';$('gate-help').textContent=e.message;$('unlock').disabled=true;$('restore').disabled=true;report(e);});
