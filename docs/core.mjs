export const APP_VERSION = '1.1.0';
export const EVENT_NAME = '第4回 笠戸島白浜海岸をきれいにしよう！';
export const CSV_HEADERS = ['受付ID', '人物ID', '氏名', '区分', '申込代表者', '受付メモ'];
export const MAX_PEOPLE = 10000;

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
  const ids = new Set();
  return rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`${index + 2}行目の列数が一致しません。`);
    const [groupId, id, name, role, representative, note] = cols.map(c => row[c].trim());
    if (!/^KSD4-[a-f0-9]{32}$/.test(groupId)) throw new Error(`${index + 2}行目の受付IDが正しくありません。`);
    if (!id.startsWith(groupId + '-') || id.length > 100 || ids.has(id)) throw new Error(`${index + 2}行目の人物IDが不正または重複しています。`);
    if (!name || name.length > 200 || !['子ども', '保護者'].includes(role) || note.length > 2000 || representative.length > 200)
      throw new Error(`${index + 2}行目の氏名・区分・メモを確認してください。`);
    ids.add(id); return {groupId, id, name, role, representative, note, checkedAt: null};
  });
}

export function mergeRoster(current, incoming) {
  const old = new Map(current.map(p => [p.id, p]));
  const nextIds = new Set(incoming.map(p => p.id));
  const missing = current.filter(p => p.checkedAt && !nextIds.has(p.id));
  if (missing.length) throw new Error(`受付済みの${missing.length}名が新名簿に含まれません。別イベント・古いCSVでないか確認してください。`);
  return incoming.map(p => {
    const prior = old.get(p.id);
    if (prior?.checkedAt && (prior.name !== p.name || prior.role !== p.role || prior.groupId !== p.groupId))
      throw new Error('受付済みの人物情報が変わっています。元の名簿を確認してください。');
    return {...p, checkedAt: prior?.checkedAt || null};
  });
}

export function validateState(data) {
  if (!data || data.version !== 1 || typeof data.eventName !== 'string' || data.eventName.length > 200 || !Array.isArray(data.people) || data.people.length > MAX_PEOPLE)
    throw new Error('バックアップ内の名簿形式が正しくありません。');
  if(data.people.some(p => !p || !['groupId','id','name','role','representative','note'].every(k=>typeof p[k]==='string')))
    throw new Error('バックアップ内の人物情報が正しくありません。');
  const csv = toCSV([CSV_HEADERS, ...data.people.map(p => [p.groupId,p.id,p.name,p.role,p.representative,p.note])], false);
  const valid = data.people.length ? rosterFromCSV(csv) : [];
  for (let i = 0; i < valid.length; i++) {
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
  const source=people=>JSON.stringify(people.map(({id,name,role,representative,note})=>({id,name,role,representative,note})).sort((a,b)=>a.id.localeCompare(b.id)));
  for(const [id,review] of Object.entries(reviews)){
    const next=incoming.filter(p=>p.groupId===id);
    if(next.length)result[id]={note:review.note,confirmedAt:source(current.filter(p=>p.groupId===id))===source(next)?review.confirmedAt:null};
  }
  return result;
}

export function toCSV(rows, safe = true) {
  return '\uFEFF' + rows.map(row => row.map(v => {
    let s = String(v ?? '');
    if (safe && /^[\s\uFEFF]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}

export function selectGroup(people, raw) {
  const id = raw.trim();
  if (!/^KSD4-[a-f0-9]{32}$/.test(id)) throw new Error('この受付システム用のQRではありません。付属スクリプトで発行したQRを提示してもらってください。');
  const group = people.filter(p => p.groupId === id);
  if (!group.length) throw new Error('名簿にありません。最新のCSVを取り込んだか確認してください。');
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
