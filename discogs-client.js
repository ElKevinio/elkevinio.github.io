/* Shared Discogs GET transport. Cache stays in memory and is isolated by token. */
(function (root) {
  'use strict';
  function createDiscogsClient({fetch: request = (...args) => root.fetch(...args), now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    searchTtl = 120000, detailTtl = 1800000, maxEntries = 250} = {}) {
    const cache = new Map(), pending = new Map();
    let blockedUntil = 0;
    function fetchOnce(input, {refresh = false, onWait} = {}) {
      const url = new URL(input);
      if (url.origin !== 'https://api.discogs.com') return Promise.reject(new Error('Ungültige Discogs-API-Adresse'));
      url.hash = ''; url.searchParams.sort();
      const key = url.href, saved = cache.get(key);
      if (blockedUntil > now() && (pending.has(key) || refresh || !(saved && saved.expires > now()))) {
        onWait?.(blockedUntil - now());
      }
      if (pending.has(key)) return pending.get(key).then(response => response.clone());
      if (!refresh && saved && saved.expires > now()) return Promise.resolve(saved.response.clone());
      cache.delete(key);
      const task = Promise.resolve().then(async () => {
        while (blockedUntil > now()) await sleep(blockedUntil - now());
        const response = await request(key);
        if (response.status === 429) {
          const retry = response.headers.get('Retry-After');
          const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - now();
          blockedUntil = Math.max(blockedUntil, now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 60000));
        }
        if (response.ok) {
          cache.set(key, {response: response.clone(), expires: now() + (url.pathname === '/database/search' ? searchTtl : detailTtl)});
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return response;
      });
      pending.set(key, task);
      const cleanup = () => { if (pending.get(key) === task) pending.delete(key); };
      task.then(cleanup, cleanup);
      return task.then(response => response.clone());
    }
    return async (input, options) => {
      const response = await fetchOnce(input, options);
      if (response.status !== 429 || !options?.retryRateLimit) return response;
      return fetchOnce(input, options);
    };
  }
  root.createDiscogsClient = createDiscogsClient;
  root.fetchDiscogsApi = createDiscogsClient();
})(globalThis);
