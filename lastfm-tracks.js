// Last.fm per-track top tags for songs whose lead artist has 2+ songs in the playlist.
// Resumable; cached in data/lastfm-tracks.json keyed by Spotify track id.
import fs from 'node:fs';
import { env } from './spotify.js';
if (!env.LASTFM_API_KEY) { console.error('LASTFM_API_KEY missing from .env'); process.exit(1); }
const OUT = 'data/lastfm-tracks.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tracks = JSON.parse(fs.readFileSync('data/tracks-cache.json', 'utf8'));
const perArtist = new Map();
for (const t of tracks) { const id = t.artists[0]?.id; if (id) perArtist.set(id, (perArtist.get(id) || 0) + 1); }
const eligible = tracks.filter(t => t.id && perArtist.get(t.artists[0]?.id) >= 2);
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const todo = eligible.filter(t => !cache[t.id]);
console.log(`${eligible.length} eligible songs, ${todo.length} to fetch from Last.fm`);

async function topTags(artist, track) {
  const u = new URL('https://ws.audioscrobbler.com/2.0/');
  u.search = new URLSearchParams({ method: 'track.gettoptags', artist, track, autocorrect: '1', api_key: env.LASTFM_API_KEY, format: 'json' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    const j = await res.json();
    if (j.error === 6) return { found: false, tags: [] };
    if (j.error === 29) { await sleep(5000); continue; }
    if (j.error) throw new Error(`lastfm error ${j.error}: ${j.message}`);
    return { found: true, tags: (j.toptags?.tag || []).map(t => [t.name.toLowerCase(), Number(t.count)]).filter(t => t[1] > 0) };
  }
  throw new Error('gave up');
}

let n = 0; const queue = [...todo];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const t = queue.shift();
    try { cache[t.id] = await topTags(t.artists[0].name, t.name.replace(/\s*[-(]\s*(feat|ft|with)\.?\s.*$/i, '')); }
    catch (e) { console.log('err', t.name, e.message); continue; }
    n++;
    if (n % 200 === 0) { fs.writeFileSync(OUT, JSON.stringify(cache)); console.log(`${n}/${todo.length} ${t.artists[0].name} - ${t.name} -> ${cache[t.id].tags.slice(0, 4).map(x => x[0]).join(', ') || '(none)'}`); }
    await sleep(250);
  }
}));
fs.writeFileSync(OUT, JSON.stringify(cache));
console.log(`done. ${Object.values(cache).filter(e => e.tags.length).length}/${Object.keys(cache).length} songs have Last.fm tags`);
