export const APP_VERSION = '1.4.0';
export const EVENT_NAME = '第4回 笠戸島白浜海岸をキレイにしよう！';
export const CSV_HEADERS = ['受付ID', '人物ID', '氏名', '区分', '申込代表者', '受付メモ'];
export const RECEIPT_HEADER = '受付番号';
export const GRADE_HEADER = '学年・年齢';
export const MAX_PEOPLE = 10000;

function validateReceiptNumbers(people){
  const byGroup=new Map(),byNumber=new Map();
  for(const person of people){
    const number=person.receiptNumber||'';
    if(number&&(!/^[A-Z][A-Z0-9]{1,19}-\d{4,9}$/.test(number)||Number(number.split('-')[1])<1||String(Number(number.split('-')[1])).padStart(4,'0')!==number.split('-')[1]))throw new Error('受付番号の形式が正しくありません。');
    if(byGroup.has(person.groupId)&&byGroup.get(person.groupId)!==number)throw new Error('同じ申込の受付番号が一致しません。');
    if(number&&byNumber.has(number)&&byNumber.get(number)!==person.groupId)throw new Error('受付番号が別の申込と重複しています。');
    byGroup.set(person.groupId,number);if(number)byNumber.set(number,person.groupId);
  }
  return people;
}

export function parseCSV(input) {
  const text = input.replace(/^\uFEFF/, '');
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
      else value += c;
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(value); value = ''; closed = false;
      if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else {
      if (closed || c === '"') throw new Error('CSVの引用符が正しくありません。Googleスプレッドシートから再ダウンロードしてください。');
      value += c;
    }
  }
  if (quoted) throw new Error('CSVの引用符が閉じられていません。');
  row.push(value); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

export function rosterFromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('名簿が空です。「受付名簿」シートをCSVで保存してください。');
  const headers = rows.shift().map(v => v.trim());
  const cols = CSV_HEADERS.map(h => headers.indexOf(h));
  if (cols.some(i => i < 0) || new Set(headers).size !== headers.length)
    throw new Error('列が一致しません。付属スクリプトで作成した「受付名簿」シートをCSVで保存してください。');
  if (rows.length > MAX_PEOPLE) throw new Error('1万名を超える名簿には対応していません。');
  const ids = new Set(),receiptColumn=headers.indexOf(RECEIPT_HEADER),gradeColumn=headers.indexOf(GRADE_HEADER);
  return validateReceiptNumbers(rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`${index + 2}行目の列数が一致しません。`);
    const [groupId, id, name, role, representative, note] = cols.map(c => row[c].trim());
    if (!/^KSD4-[a-f0-9]{32}$/.test(groupId)) throw new Error(`${index + 2}行目の受付IDが正しくありません。`);
    if (!id.startsWith(groupId + '-') || id.length > 100 || ids.has(id)) throw new Error(`${index + 2}行目の人物IDが不正または重複しています。`);
    if (!name || name.length > 200 || !['子ども', '保護者'].includes(role) || note.length > 2000 || representative.length > 200)
      throw new Error(`${index + 2}行目の氏名・区分・メモを確認してください。`);
    const receiptNumber=receiptColumn<0?'':row[receiptColumn].trim();
    const grade=gradeColumn<0?undefined:row[gradeColumn].trim();
    if(grade!==undefined&&(grade.length>100||/[\r\n]/.test(grade)))throw new Error(`${index + 2}行目の学年・年齢を確認してください。`);
    ids.add(id); return {groupId, id, name, role, representative, note, checkedAt: null,...(receiptNumber?{receiptNumber}:{}),...(grade===undefined?{}:{grade})};
  }));
}

export function mergeRoster(current, incoming) {
  const old = new Map(current.map(p => [p.id, p]));
  const nextIds = new Set(incoming.map(p => p.id));
  const missing = current.filter(p => p.checkedAt && !nextIds.has(p.id));
  if (missing.length) throw new Error(`受付済みの${missing.length}名が新名簿に含まれません。別イベント・古いCSVでないか確認してください。`);
  return validateReceiptNumbers(incoming.map(p => {
    const prior = old.get(p.id);
    if (prior?.checkedAt && (prior.name !== p.name || prior.role !== p.role || prior.groupId !== p.groupId))
      throw new Error('受付済みの人物情報が変わっています。元の名簿を確認してください。');
    if(prior?.receiptNumber&&p.receiptNumber&&prior.receiptNumber!==p.receiptNumber)throw new Error('同じ申込の受付番号が変更されています。元の名簿を確認してください。');
    const receiptNumber=p.receiptNumber||prior?.receiptNumber;
    const grade=p.grade===undefined?prior?.grade:p.grade;
    return {...p, checkedAt: prior?.checkedAt || null,...(receiptNumber?{receiptNumber}:{}),...(grade===undefined?{}:{grade})};
  }));
}

export function validateState(data) {
  if (!data || data.version !== 1 || typeof data.eventName !== 'string' || data.eventName.length > 200 || !Array.isArray(data.people) || data.people.length > MAX_PEOPLE)
    throw new Error('バックアップ内の名簿形式が正しくありません。');
  if(data.people.some(p => !p || !['groupId','id','name','role','representative','note'].every(k=>typeof p[k]==='string') || (p.receiptNumber!==undefined&&typeof p.receiptNumber!=='string') || (p.grade!==undefined&&typeof p.grade!=='string')))
    throw new Error('バックアップ内の人物情報が正しくありません。');
  const csv = toCSV([[...CSV_HEADERS,RECEIPT_HEADER,GRADE_HEADER], ...data.people.map(p => [p.groupId,p.id,p.name,p.role,p.representative,p.note,p.receiptNumber||'',p.grade||''])], false);
  const valid = data.people.length ? rosterFromCSV(csv) : [];
  for (let i = 0; i < valid.length; i++) {
    if(data.people[i].grade===undefined)delete valid[i].grade;
    const at = data.people[i].checkedAt;
    if (at !== null && (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at) || !Number.isFinite(Date.parse(at)))) throw new Error('受付日時が正しくありません。');
    valid[i].checkedAt = at;
  }
  const reviews = {}, groups = new Set(valid.map(p=>p.groupId));
  if(data.reviews!==undefined){
    if(!data.reviews || typeof data.reviews!=='object' || Array.isArray(data.reviews))throw new Error('確認メモの形式が正しくありません。');
    for(const [id,review] of Object.entries(data.reviews)){
      if(!groups.has(id) || !review || typeof review.note!=='string' || review.note.length>2000 ||
        (review.confirmedAt!==null && (typeof review.confirmedAt!=='string' || !Number.isFinite(Date.parse(review.confirmedAt)))))
        throw new Error('確認メモの内容が正しくありません。');
      reviews[id]={note:review.note,confirmedAt:review.confirmedAt};
    }
  }
  return {version:1, eventName:data.eventName, people:valid, importedAt:typeof data.importedAt === 'string' ? data.importedAt : null,reviews};
}

export function retainReviews(current,incoming,reviews={}) {
  const result={};
  const source=people=>JSON.stringify(people.map(({id,name,role,representative,note,grade})=>({id,name,role,representative,note,grade:grade||''})).sort((a,b)=>a.id.localeCompare(b.id)));
  for(const [id,review] of Object.entries(reviews)){
    const next=incoming.filter(p=>p.groupId===id);
    if(next.length)result[id]={note:review.note,confirmedAt:source(current.filter(p=>p.groupId===id))===source(next)?review.confirmedAt:null};
  }
  return result;
}

export function mergeLegacyState(current,legacy){
  current=validateState(current);legacy=validateState(legacy);
  const numbers=new Map(),people=new Map(current.people.map(person=>[person.id,{...person}]));
  for(const person of [...current.people,...legacy.people])if(person.receiptNumber){
    if(numbers.has(person.groupId)&&numbers.get(person.groupId)!==person.receiptNumber)throw new Error('旧版と現在の受付番号が一致しません。現在の記録は変更していません。');
    numbers.set(person.groupId,person.receiptNumber);
  }
  for(const person of legacy.people){
    const existing=people.get(person.id);
    if(existing){
      if(['groupId','name','role'].some(field=>existing[field]!==person[field]))throw new Error('旧版と現在の人物情報が一致しません。現在の記録は変更していません。');
      existing.checkedAt=existing.checkedAt||person.checkedAt;
      if(existing.grade===undefined&&person.grade!==undefined)existing.grade=person.grade;
    }else people.set(person.id,{...person});
  }
  const merged=Array.from(people.values(),person=>({...person,...(numbers.has(person.groupId)?{receiptNumber:numbers.get(person.groupId)}:{})}));
  const reviews={...retainReviews(legacy.people,merged,legacy.reviews),...retainReviews(current.people,merged,current.reviews)};
  return validateState({...current,eventName:current.people.length?current.eventName:legacy.eventName,people:merged,reviews,importedAt:current.importedAt||legacy.importedAt});
}

export function toCSV(rows, safe = true) {
  return '\uFEFF' + rows.map(row => row.map(v => {
    let s = String(v ?? '');
    if (safe && /^[\s\uFEFF]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}

export function selectGroup(people, raw, allowReceiptNumber=false) {
  const id = raw.trim();
  const receipt=allowReceiptNumber&&/^[A-Z][A-Z0-9]{1,19}-\d{4,9}$/.test(id.toUpperCase());
  if (!receipt&&!/^KSD4-[a-f0-9]{32}$/.test(id)) throw new Error('この受付システム用のQRではありません。受付番号は手入力欄へ入力してください。');
  const group = people.filter(p => receipt?p.receiptNumber===id.toUpperCase():p.groupId===id);
  if (!group.length) throw new Error('名簿にありません。最新の暗号化名簿を取り込んだか確認してください。');
  return group;
}

const bytesTo64 = a => {let binary='';for(let i=0;i<a.length;i+=24576)binary+=String.fromCharCode(...a.subarray(i,i+24576));return btoa(binary);};
const from64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export function validateVault(v) {
  if (!v || v.format !== 'kasado-reception-encrypted-v1' || v.kdf !== 'PBKDF2-SHA256' || v.iterations !== 600000 || v.cipher !== 'AES-256-GCM' ||
      !['salt','iv','ciphertext'].every(k => typeof v[k] === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v[k])) ||
      v.ciphertext.length > 20000000 || !Number.isSafeInteger(v.revision) || v.revision < 1)
    throw new Error('対応する暗号化バックアップではありません。');
  if (from64(v.salt).length !== 16 || from64(v.iv).length !== 12 || from64(v.ciphertext).length < 16) throw new Error('暗号化ファイルが破損しています。');
  return v;
}
export async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:600000, hash:'SHA-256'}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
export async function seal(state, key, salt, revision) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode('kasado-reception-encrypted-v1');
  const result = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:aad}, key, new TextEncoder().encode(JSON.stringify(state)));
  return {format:'kasado-reception-encrypted-v1', kdf:'PBKDF2-SHA256', iterations:600000, cipher:'AES-256-GCM', salt:bytesTo64(salt), iv:bytesTo64(iv), ciphertext:bytesTo64(new Uint8Array(result)), revision};
}
export async function unseal(vault, passphrase) {
  validateVault(vault);
  const salt = from64(vault.salt), key = await deriveKey(passphrase, salt);
  try {
    const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv:from64(vault.iv), additionalData:new TextEncoder().encode(vault.format)}, key, from64(vault.ciphertext));
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    const state = validateState(parsed);
    return {state,key,salt};
  } catch { throw new Error('パスフレーズが違うか、ファイルが破損しています。'); }
}
