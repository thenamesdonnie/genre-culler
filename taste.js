// What Donnie actually listens to, for the Game Night soundtrack brief.
//
//   node taste.js            fetch Liked Songs and top artists/tracks, then report
//   node taste.js --report   report from the cache without refetching
//
// WHY NOT THE PLAYLIST. The first pass at this read "i studied bro", an 8435-track playlist, because
// that is what the culler had cached. Donnie caught it: both are a signal, but Liked Songs is
// stronger, and what he has on repeat is stronger still. So this reads three sources and says which
// is which rather than blending them into one number.
import fs from 'node:fs';
import { savedTracks, topItems } from './spotify.js';

const OUT = 'data/taste.json';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

if (!process.argv.includes('--report')) {
  const liked = await savedTracks((n, t) => process.stdout.write(`\rliked songs ${n}/${t}   `));
  console.log();
  const data = { fetchedAt: new Date().toISOString(), liked, top: {} };
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    data.top[range] = { artists: await topItems('artists', range), tracks: await topItems('tracks', range) };
    console.log(`top ${range}: ${data.top[range].artists.length} artists, ${data.top[range].tracks.length} tracks`);
  }
  fs.writeFileSync(OUT, JSON.stringify(data));
}

const data = readJson(OUT);
if (!data) { console.error('no data; run without --report first'); process.exit(1); }
const arts = readJson('data/claude-artists.json', {});
const lm = readJson('data/label-map.json', {});
const canon = (l) => lm[l] || l;

const genreOf = (t) => {
  const a = arts[t.artists?.[0]?.id];
  return a && a.primary !== 'unknown' ? canon(a.primary) : null;
};
const tally = (arr, fn) => {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
};
const show = (label, rows, n = 16) => {
  console.log(`\n${label}`);
  console.log('   ' + rows.slice(0, n).map(([k, v]) => `${k}:${v}`).join(', '));
};

const liked = data.liked;
console.log(`\n=== LIKED SONGS: ${liked.length}, newest ${liked[0]?.addedAt?.slice(0, 10)}, oldest ${liked[liked.length - 1]?.addedAt?.slice(0, 10)}`);
const known = liked.filter(genreOf).length;
console.log(`    ${known} have a genre from the existing artist classification (${(100 * known / liked.length).toFixed(0)}%); the rest are artists the culler never saw.`);
show('all liked, by genre:', tally(liked, genreOf));
show('last 300 liked, by genre:', tally(liked.slice(0, 300), genreOf));
show('last 300 liked, by artist:', tally(liked.slice(0, 300), (t) => t.artists?.[0]?.name));
const decade = (t) => (t.year ? t.year.slice(0, 3) + '0s' : null);
show('liked, by decade:', tally(liked, decade).sort((a, b) => a[0].localeCompare(b[0])), 12);

for (const [range, label] of [['short_term', 'LAST 4 WEEKS'], ['medium_term', 'LAST 6 MONTHS'], ['long_term', 'ALL TIME']]) {
  const t = data.top[range];
  if (!t) continue;
  console.log(`\n=== TOP ${label}`);
  console.log('    artists: ' + t.artists.slice(0, 15).map((a) => a.name).join(', '));
  console.log('    tracks:  ' + t.tracks.slice(0, 10).map((x) => `${x.name} (${x.artists?.[0]?.name})`).join('; '));
}
