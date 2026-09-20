// MusicBrainz artist tag crawl. Keyless, 1 request/second, resumable, results cached in data/mb-artists.json.
// Usage: node mb.js   (reads data/tracks-cache.json or data/scan-<id>.json for the artist list)
import fs from 'node:fs';
const OUT = 'data/mb-artists.json';
const UA = process.env.MB_CONTACT ? `genre-culler/1.0 (${process.env.MB_CONTACT})` : 'genre-culler/1.0 (https://github.com/thenamesdonnie/genre-culler)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = fs.existsSync('data/tracks-cache.json') ? JSON.parse(fs.readFileSync('data/tracks-cache.json', 'utf8'))
  : JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).tracks;
const artists = new Map();
for (const t of src) for (const a of t.artists) if (a.id && !artists.has(a.id)) artists.set(a.id, a.name);
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const todo = [...artists].filter(([id]) => !cache[id]);
console.log(`${artists.size} artists, ${todo.length} to fetch`);

let n = 0, backoff = 5000;
for (const [id, name] of todo) {
  let entry = { name, mbid: null, score: 0, tags: [] };
  // Retry the SAME artist on 503/429 (MusicBrainz "busy" = rate limit) with growing backoff.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const q = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`);
      const res = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${q}&fmt=json&limit=3`,
        { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 503 || res.status === 429) { console.log(`${res.status} on ${name}, backoff ${backoff}ms`); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
      backoff = 5000;
      const j = await res.json();
      const hit = (j.artists || []).find(a => a.name.toLowerCase() === name.toLowerCase()) || (j.artists || [])[0];
      if (hit && hit.score >= 90) {
        entry = { name, mbid: hit.id, score: hit.score, mbName: hit.name,
          tags: (hit.tags || []).filter(t => t.count > 0).sort((a, b) => b.count - a.count).map(t => [t.name, t.count]) };
      }
      break;
    } catch (e) { console.log('err', name, e.message); await sleep(backoff); }
  }
  cache[id] = entry;
  n++;
  if (n % 25 === 0) { fs.writeFileSync(OUT, JSON.stringify(cache)); console.log(`${new Date().toISOString().slice(11, 19)} ${n}/${todo.length} ${name} -> ${entry.tags.slice(0, 4).map(t => t[0]).join(', ') || '(none)'}`); }
  await sleep(1200);
}
fs.writeFileSync(OUT, JSON.stringify(cache));
const withTags = Object.values(cache).filter(e => e.tags.length).length;
console.log(`done. ${withTags}/${Object.keys(cache).length} artists have tags`);
