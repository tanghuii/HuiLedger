// 行星记账的离线缓存：网页本身（脚本、样式、图标、字体）缓存在手机上，断网也能打开。
// 网页代码先走网络（联网时总是最新版），连不上再用缓存；图标、字体、银行 logo 直接用缓存。
// 云端数据（Supabase）和汇率不经过这里，离线时由页面自己的快照顶上。
const CACHE = 'huiledger-20261121090409';
const SHELL = ['./', 'index.html', 'style.css', 'config.js', 'shared.js', 'planets.js', 'flags.js', 'icons.js', 'more.js', 'ai.js', 'app.js', 'modules/budget.js', 'modules/monthly.js', 'modules/mood.js', 'modules/loans.js', 'modules/schedules.js', 'modules/backup.js', 'modules/manage.js', 'modules/editor.js', 'css/home.css', 'css/stats.css', 'css/themes.css', 'css/tags.css', 'css/import.css', 'css/tidy.css', 'css/extras.css', 'css/editor.css', 'css/ai.css', 'css/cosmos.css', 'modules/appearance.js', 'modules/art.js', 'modules/cosmos.js', 'modules/tags.js', 'modules/import.js', 'modules/tidy.js', 'modules/lock.js', 'modules/reminders.js', 'modules/voice.js', 'modules/onboard.js', 'css/onboard.css', 'modules/links.js', 'css/links.css', 'modules/intro.js', 'css/intro.css', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  ...['brand', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'].map((k) => `icons/planets/${k}-180.png`)];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const stable = /\/(icons|fonts|logos)\//.test(url.pathname);
  if (stable) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
    return;
  }
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(new Request(url.pathname), copy)); }
    return res;
  }).catch(() => caches.match(new Request(url.pathname)).then((hit) => hit || caches.match('index.html'))));
});
