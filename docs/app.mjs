import {EVENT_NAME, rosterFromCSV, mergeRoster, retainReviews, selectGroup, deriveKey, seal, unseal, validateVault, toCSV} from './core.mjs';
import {validateEncryptedRoster,decryptRosterCSV} from './transfer.mjs';
import {DEVICE_FORMAT,createDeviceKey,sealDeviceState,openDeviceState} from './device.mjs';

const $ = id => document.getElementById(id);
let db, vault = null, state = null, deviceKey = null, busy = false, session = 0, secretMode = null, secretRequest = 0;
let currentGroupId = null, pendingRestore = null, pendingRoster = null, stream = null, scanFrame = null, scanning = false;
let flaggedGroups = new Set();
const blankState = () => ({version:1,eventName:EVENT_NAME,people:[],importedAt:null,reviews:{}});
const needsReview = groupId => flaggedGroups.has(groupId);
const clock = s => new Date(s).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});

function notify(message, type = '') {
  $('notice').textContent = message; $('notice').className = 'notice ' + type; $('notice').hidden = false;
  if($('group-dialog').open){$('dialog-notice').textContent=message;$('dialog-notice').className='notice '+type;$('dialog-notice').hidden=false;}
  if($('import-dialog').open){$('import-error').textContent=message;$('import-error').hidden=false;}
  if($('backup-dialog').open){$('backup-error').textContent=message;$('backup-error').hidden=false;}
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
function matchesVault(current,expected){return expected ? !!current&&current.revision===expected.revision&&current.format===expected.format&&current.ciphertext===expected.ciphertext : !current;}
function readDeviceKey(){return new Promise((resolve,reject)=>{const request=db.transaction('vault','readonly').objectStore('vault').get('device-key');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function writeVault(next, expected, replacementKey, accept=()=>true) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction('vault','readwrite'), store = tx.objectStore('vault');
    let conflict = false, cancelled = false;
    const request = store.get('current');
    request.onsuccess = () => {
      if(!accept()){cancelled=true;tx.abort();return;}
      if (!matchesVault(request.result,expected)) { conflict = true; tx.abort(); return; }
      try{
        if(next){store.put(next,'current');if(replacementKey)store.put(replacementKey,'device-key');}
        else{store.delete('current');store.delete('device-key');}
      }catch{tx.abort();}
    };
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(new Error(cancelled ? '操作を取り消しました。記録は変更していません。' : conflict ? '別の画面で名簿が更新されました。この画面を再読み込みしてください。' : '保存できませんでした。受付は確定していません。端末の空き容量を確認してください。'));
  });
}
async function run(task) {
  if (busy) return;
  busy = true; document.querySelectorAll('button[type="submit"]').forEach(b=>b.disabled=true);
  try { await task(); } catch(e) { report(e); }
  finally { busy = false; document.querySelectorAll('button[type="submit"]').forEach(b=>b.disabled=false);if($('group-dialog').open)updateSelection(); }
}
async function commit(next) {
  if (!deviceKey || !state) throw new Error('受付データを開き直してください。');
  const generation=session, nextVault=await sealDeviceState(next,deviceKey,vault.revision+1);
  await writeVault(nextVault,vault);
  if (generation !== session) return false;
  vault=nextVault; state=next; render(); return true;
}
function clearSession() {
  session++; stopCamera();
  if ($('group-dialog').open) $('group-dialog').close();
  if ($('import-dialog').open) $('import-dialog').close();
  pendingRoster=null;$('import-passphrase').value='';$('import-error').textContent='';
  state=null;deviceKey=null;currentGroupId=null;flaggedGroups=new Set();
  $('people-list').replaceChildren();$('group-members').replaceChildren();$('manual-id').value='';$('search').value='';
  $('group-title').textContent='来場した方を選択';$('group-status').textContent='';
  $('group-warning').textContent='';$('review-note').value='';$('review-status').textContent='';
  $('dialog-notice').textContent='';$('dialog-notice').hidden=true;
  $('notice').hidden=true;$('gate').hidden=false;$('workspace').hidden=true;$('navigation').hidden=true;
}
function showWorkspace() {
  $('gate').hidden=true; $('workspace').hidden=false; $('navigation').hidden=false;
  $('notice').hidden=true;render();
}
async function replaceLocalState(next,expected,accept=()=>true){
  const revision=Number.isSafeInteger(expected?.revision)&&expected.revision>0&&expected.revision<Number.MAX_SAFE_INTEGER?expected.revision+1:1;
  const replacementKey=await createDeviceKey(),replacement=await sealDeviceState(next,replacementKey,revision);
  if(!accept())return false;
  await writeVault(replacement,expected,replacementKey,accept);
  clearSession();vault=replacement;deviceKey=replacementKey;state=next;showWorkspace();return true;
}
async function openLocalState(){
  const stored=await readVault();
  if(!stored){await replaceLocalState(blankState(),null);return;}
  vault=stored;
  if(stored.format!==DEVICE_FORMAT){
    validateVault(stored);$('gate-title').textContent='以前の記録を引き継ぐ';$('gate-help').textContent='旧版の記録が残っています。以前のアプリ用パスフレーズを一度だけ入力すると、次回から入力なしで開けます。';$('migrate').hidden=false;return;
  }
  const record=await readDeviceKey(),opened=await openDeviceState(stored,record);
  deviceKey=record;state=opened;showWorkspace();
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
      if(code){stopCamera();showGroup(code.data);}
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

function openSecret(mode){
  secretRequest++;secretMode=mode;const saving=mode==='save',migrating=mode==='migrate';
  $('backup-title').textContent=saving?'バックアップを暗号化する':migrating?'以前の記録を引き継ぐ':'バックアップを復元する';
  $('backup-help').textContent=saving?'バックアップのファイルを保護するパスフレーズを設定してください。アプリ起動時の入力は不要です。':migrating?'旧版で設定したアプリ用パスフレーズを一度だけ入力してください。':'このバックアップを保存したときのパスフレーズを入力してください。';
  $('backup-confirm-wrap').hidden=!saving;$('backup-confirm').required=saving;
  $('backup-passphrase').autocomplete=saving?'new-password':'off';
  document.querySelector('label[for="backup-passphrase"]').textContent=migrating?'以前のアプリ用パスフレーズ':'バックアップ用パスフレーズ';
  $('backup-submit').textContent=saving?'暗号化して保存':migrating?'引き継いで開く':'復元する';
  $('backup-passphrase').value='';$('backup-confirm').value='';$('backup-error').hidden=true;$('backup-dialog').showModal();
}
$('backup-cancel').addEventListener('click',()=>$('backup-dialog').close());
$('backup-dialog').addEventListener('close',()=>{secretRequest++;secretMode=null;pendingRestore=null;$('backup-passphrase').value='';$('backup-confirm').value='';$('backup-error').textContent='';});
$('migrate').addEventListener('click',()=>openSecret('migrate'));
$('reload').addEventListener('click',()=>location.reload());
$('backup-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{
  const mode=secretMode,request=secretRequest,pass=$('backup-passphrase').value,confirmation=$('backup-confirm').value,restore=pendingRestore,expected=vault;
  const accept=()=>request===secretRequest&&$('backup-dialog').open;
  $('backup-passphrase').value='';$('backup-confirm').value='';
  if(mode==='save'){
    if(!state)throw new Error('受付データを開き直してください。');
    if(pass.length<12)throw new Error('バックアップ用パスフレーズは12文字以上にしてください。');
    if(pass!==confirmation)throw new Error('2回のパスフレーズが一致しません。');
    if(!matchesVault(await readVault(),expected))throw new Error('別の画面で更新されました。再読み込みしてから保存してください。');
    const salt=crypto.getRandomValues(new Uint8Array(16)),key=await deriveKey(pass,salt),backup=await seal(state,key,salt,1);
    if(!accept())return;
    await saveFile(JSON.stringify(backup,null,2),'application/json','受付バックアップ-'+stamp()+'.json');$('backup-dialog').close();
    return;
  }
  if(mode!=='restore'&&mode!=='migrate')throw new Error('操作を選び直してください。');
  const candidate=mode==='restore'?restore?.candidate:expected;
  if(!candidate)throw new Error('バックアップを選び直してください。');
  const opened=await unseal(candidate,pass);
  if(!accept())return;
  if(mode==='restore'&&!confirm('この端末の名簿と受付記録を、バックアップの内容に置き換えますか？'))return;
  if(!await replaceLocalState(opened.state,mode==='restore'?restore.expected:expected,accept))return;
  $('backup-dialog').close();notify(mode==='migrate'?'記録を引き継ぎました。次回からパスフレーズなしで開きます。':'バックアップから復元しました。','success');
});});
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
  if(!state)throw new Error('受付データを開き直してください。');
  if(!file.name.toLowerCase().endsWith('.json'))throw new Error('平文CSVは取り込みません。「受付名簿を暗号化して書き出す」で保存したJSONを選んでください。');
  if(file.size>20000000)throw new Error('暗号化名簿は20MB以下にしてください。');
  const generation=session;let candidate;
  try{candidate=JSON.parse(await file.text());}catch{throw new Error('暗号化名簿のJSONファイルを選んでください。');}
  validateEncryptedRoster(candidate);
  if(generation!==session)throw new Error('受付データが変わりました。取り込み直してください。');
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
$('backup').addEventListener('click',()=>{if(state)openSecret('save');});
$('restore').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(!file)return;run(async()=>{
  if(file.size>20000000)throw new Error('バックアップが大きすぎます。');
  const candidate=validateVault(JSON.parse(await file.text()));pendingRestore={candidate,expected:await readVault()};openSecret('restore');
});});
$('export-csv').addEventListener('click',()=>run(async()=>{
  if(!state)throw new Error('受付データを開き直してください。');
  if(!confirm('氏名・受付メモ・受付日時を含む、暗号化されていないCSVを保存します。保存先の管理に注意してください。続けますか？'))return;
  const jst=value=>value?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'';
  const rows=[['受付ID','人物ID','氏名','区分','申込代表者','受付メモ','受付状態','受付日時（日本時間）','当日確認状態','当日確認メモ','当日確認日時（日本時間）'],...state.people.map(p=>{
    const review=state.reviews?.[p.groupId];
    return [p.groupId,p.id,p.name,p.role,p.representative,p.note,p.checkedAt?'受付済み':'未受付',jst(p.checkedAt),needsReview(p.groupId)?(review?.confirmedAt?'確認済み':'未確認'):'対象外',review?.note||'',jst(review?.confirmedAt)];
  })];
  await saveFile(toCSV(rows),'text/csv;charset=utf-8','受付結果-'+stamp()+'.csv');
}));
$('erase').addEventListener('click',()=>run(async()=>{
  if(!state)throw new Error('受付データを開き直してください。');
  if(prompt('端末内の名簿と全受付記録を削除します。必要なバックアップを保存してから「削除」と入力してください。')!=='削除')return;
  await writeVault(null,vault);vault=null;pendingRestore=null;clearSession();await openLocalState();notify('この端末の名簿と記録を削除しました。');
}));
$('check-offline').addEventListener('click',checkOffline);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
window.addEventListener('pagehide',stopCamera);
function networkStatus(){$('network').textContent=navigator.onLine?'オンライン':'オフライン';}
window.addEventListener('online',networkStatus);window.addEventListener('offline',networkStatus);networkStatus();

async function init(){
  if(window.top!==window.self)throw new Error('このアプリは単独の画面で開いてください。');
  if(!window.isSecureContext || !crypto.subtle || !('serviceWorker' in navigator))throw new Error('HTTPSのURLをSafariで開いてください。HTMLファイルを直接開く方法ではカメラ・暗号化・オフライン起動を利用できません。');
  db=await openDB();await openLocalState();
  if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
  try{
    const existing=await navigator.serviceWorker.getRegistration('./');
    if(navigator.onLine||!existing?.active)await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    await checkOffline();
  }catch{await checkOffline();}
}
init().catch(e=>{$('gate-title').textContent='受付データを開けません';$('gate-help').textContent=e.message;report(e);});
