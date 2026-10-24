import {validateState} from './core.mjs';

export const DEVICE_FORMAT='kasado-reception-device-v1';
const bytesTo64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=24576)text+=String.fromCharCode(...bytes.subarray(i,i+24576));return btoa(text);};
const from64=text=>Uint8Array.from(atob(text),char=>char.charCodeAt(0));
const validKey=record=>record&&/^[a-f0-9]{32}$/.test(record.id)&&record.key?.type==='secret'&&record.key.extractable===false&&record.key.algorithm?.name==='AES-GCM'&&record.key.algorithm.length===256&&['encrypt','decrypt'].every(usage=>record.key.usages.includes(usage));

export async function createDeviceKey(){
  return {id:Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join(''),key:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])};
}
export function validateDeviceVault(vault){
  if(!vault||vault.format!==DEVICE_FORMAT||vault.cipher!=='AES-256-GCM'||!/^[a-f0-9]{32}$/.test(vault.keyId)||!Number.isSafeInteger(vault.revision)||vault.revision<1||!['iv','ciphertext'].every(field=>typeof vault[field]==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(vault[field]))||vault.ciphertext.length>20000000)
    throw new Error('端末内の受付データの形式が正しくありません。バックアップから復元してください。');
  if(from64(vault.iv).length!==12||from64(vault.ciphertext).length<16)throw new Error('端末内の受付データが破損しています。');
  return vault;
}
export async function sealDeviceState(state,record,revision){
  if(!validKey(record))throw new Error('端末の暗号鍵を利用できません。');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(DEVICE_FORMAT+':'+record.id)},record.key,new TextEncoder().encode(JSON.stringify(validateState(state))));
  return validateDeviceVault({format:DEVICE_FORMAT,cipher:'AES-256-GCM',keyId:record.id,iv:bytesTo64(iv),ciphertext:bytesTo64(new Uint8Array(ciphertext)),revision});
}
export async function openDeviceState(vault,record){
  validateDeviceVault(vault);
  if(!validKey(record)||vault.keyId!==record.id)throw new Error('保存した暗号鍵が見つかりません。暗号化バックアップから復元してください。');
  try{
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(vault.iv),additionalData:new TextEncoder().encode(DEVICE_FORMAT+':'+record.id)},record.key,from64(vault.ciphertext));
    return validateState(JSON.parse(new TextDecoder().decode(plain)));
  }catch{throw new Error('端末内の受付データを開けません。暗号化バックアップから復元してください。');}
}
