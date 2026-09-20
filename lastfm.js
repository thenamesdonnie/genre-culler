// Last.fm artist top tags for every artist in the playlist. Needs LASTFM_API_KEY in .env.
// Resumable; cached in data/lastfm-artists.json. ~4 requests/second.
import fs from 'node:fs';
import { env } from './spotify.js';
if (!env.LASTFM_API_KEY) { console.error('LASTFM_API_KEY missing from .env'); process.exit(1); }
const OUT = 'data/lastfm-artists.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tracks = fs.existsSync('data/tracks-cache.json') ? JSON.parse(fs.readFileSync('data/tracks-cache.json', 'utf8'))
  : JSON.parse(fs.readFileSync(`data/scan-${env.DEFAULT_PLAYLIST}.json`, 'utf8')).tracks;
const artists = new Map();
for (const t of tracks) for (const a of t.artists) if (a.id && !artists.has(a.id)) artists.set(a.id, a.name);
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const todo = [...artists].filter(([id]) => !cache[id]);
console.log(`${artists.size} artists, ${todo.length} to fetch from Last.fm`);

async function topTags(name) {
  const u = new URL('https://ws.audioscrobbler.com/2.0/');
  u.search = new URLSearchParams({ method: 'artist.gettoptags', artist: name, autocorrect: '1', api_key: env.LASTFM_API_KEY, format: 'json' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    const j = await res.json();
    if (j.error === 6) return { found: false, tags: [] };            // artist not found
    if (j.error === 29) { await sleep(5000); continue; }               // rate limit
    if (j.error) throw new Error(`lastfm error ${j.error}: ${j.message}`);
    const tags = (j.toptags?.tag || []).map(t => [t.name.toLowerCase(), Number(t.count)]).filter(t => t[1] > 0);
    return { found: true, matched: j.toptags?.['@attr']?.artist, tags };
  }
  throw new Error('gave up');
}

let n = 0;
const CONC = 4;
const queue = [...todo];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const [id, name] = queue.shift();
    try { cache[id] = { name, ...(await topTags(name)) }; }
    catch (e) { console.log('err', name, e.message); continue; }
    n++;
    if (n % 100 === 0) { fs.writeFileSync(OUT, JSON.stringify(cache)); console.log(`${n}/${todo.length} ${name} -> ${cache[id].tags.slice(0, 4).map(t => t[0]).join(', ') || '(none)'}`); }
    await sleep(250);
  }
}));
fs.writeFileSync(OUT, JSON.stringify(cache));
const withTags = Object.values(cache).filter(e => e.tags.length).length;
console.log(`done. ${withTags}/${Object.keys(cache).length} artists have Last.fm tags`);
