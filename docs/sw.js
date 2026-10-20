const PREFIX='kasado-shell:'+self.registration.scope+':';
const CACHE=PREFIX+'v1.1.1';
const FILES=['./','./index.html','./style.css','./app.mjs','./core.mjs','./transfer.mjs','./vendor/jsQR.js','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];
// 更新版は既存の画面をすべて閉じてから有効化し、旧HTMLと新JSの混在を防ぎます。
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(FILES.map(file=>new Request(new URL(file,self.location.href),{cache:'reload'})));})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(event.request,{ignoreSearch:true});
    if(cached)return cached;
    if(event.request.mode==='navigate')return cache.match('./index.html');
    return fetch(event.request);
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='CHECK_CACHE')event.waitUntil((async()=>{const cache=await caches.open(CACHE);const checks=await Promise.all(FILES.map(f=>cache.match(f)));event.ports[0]?.postMessage({ready:checks.every(Boolean),count:checks.filter(Boolean).length});})());
});
