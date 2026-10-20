// Apps Scriptの書き出し画面にも、同一のコードを埋め込みます。
export const ROSTER_FORMAT='kasado-roster-encrypted-v1';
const MAX_CSV_BYTES=10000000;
const transferTo64=bytes=>{let binary='';for(let i=0;i<bytes.length;i+=24576)binary+=String.fromCharCode(...bytes.subarray(i,i+24576));return btoa(binary);};
const transferFrom64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export function validateEncryptedRoster(value){
  if(!value||value.format!==ROSTER_FORMAT||value.kdf!=='PBKDF2-SHA256'||value.iterations!==600000||value.cipher!=='AES-256-GCM'||
    !['salt','iv','ciphertext'].every(k=>typeof value[k]==='string'&&value[k].length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(value[k]))||value.ciphertext.length>14000000)
    throw new Error('対応する暗号化名簿ではありません。スプレッドシートの「受付名簿を暗号化して書き出す」で保存したJSONを選んでください。バックアップは「暗号化バックアップから復元」で選びます。');
  try{
    const size=transferFrom64(value.ciphertext).length;
    if(transferFrom64(value.salt).length!==16||transferFrom64(value.iv).length!==12||size<16||size>MAX_CSV_BYTES+16)throw new Error();
  }catch{throw new Error('暗号化名簿ファイルが破損しています。');}
  return value;
}
async function transferKey(passphrase,salt){
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptRosterCSV(csv,passphrase){
  if(typeof passphrase!=='string'||passphrase.length<12||passphrase.length>200)throw new Error('受け渡し用パスフレーズは12〜200文字にしてください。');
  if(typeof csv!=='string')throw new Error('名簿データの形式が正しくありません。');
  const bytes=new TextEncoder().encode(csv);
  if(!bytes.length||bytes.length>MAX_CSV_BYTES)throw new Error('名簿は10MB以下にしてください。');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await transferKey(passphrase,salt);
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(ROSTER_FORMAT)},key,bytes);
  return {format:ROSTER_FORMAT,kdf:'PBKDF2-SHA256',iterations:600000,cipher:'AES-256-GCM',salt:transferTo64(salt),iv:transferTo64(iv),ciphertext:transferTo64(new Uint8Array(cipher))};
}
export async function decryptRosterCSV(value,passphrase){
  validateEncryptedRoster(value);
  if(typeof passphrase!=='string'||passphrase.length>200)throw new Error('パスフレーズを確認してください。');
  try{
    const key=await transferKey(passphrase,transferFrom64(value.salt));
    const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:transferFrom64(value.iv),additionalData:new TextEncoder().encode(ROSTER_FORMAT)},key,transferFrom64(value.ciphertext));
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }catch{throw new Error('受け渡し用パスフレーズが違うか、暗号化名簿が破損しています。現在の受付記録は変更していません。');}
}
