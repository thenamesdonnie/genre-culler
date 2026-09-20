// A playlist picked by hand from what Donnie has liked in the last three months, made on his account.
//
//   node playlist.js --set slow            resolve every pick on Spotify and show what would go in (dry run)
//   node playlist.js --set pace --create   make the playlist (private) and add the tracks
//
// The sets live in picks/<set>.js as [artist, title, why] with a name and a description.
//
// WHY BY HAND. The taste reader (taste.js) says his last three months are 1967 to 1977 rock with a
// slow ache at the centre (the Velvets, Crazy Horse, Neil Young, Harrison, Lennon, the Hollies,
// Crimson's gentle side) and a prog gateway around it (ELP, Crimson, ELO, Latte E Miele in his top
// plays), with a soul and funk thread (Roy Ayers, Funkadelic, Al Green, Thee Sacred Souls) and a
// few modern bands that sound like that decade (junodream, Arcy Drive). The picks below sit in that
// world and are songs he has NOT liked: every candidate is checked against his full Liked Songs
// before it goes in. Spotify's own recommendations endpoint went away in 2024, and a list a person
// reasoned about beats a similarity score anyway.
import fs from 'node:fs';
import { api, me, createPlaylist, addTracks } from './spotify.js';

const CREATE = process.argv.includes('--create');
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'slow';
const { NAME, DESCRIPTION, PICKS } = await import(`./picks/${SET}.js`);

const liked = JSON.parse(fs.readFileSync('data/taste.json', 'utf8')).liked;
const likedIds = new Set(liked.map((t) => t.id));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const likedKeys = new Set(liked.map((t) => `${norm(t.artists[0]?.name ?? '')}|${norm(t.name).replace(/ (remaster|remastered|mix|version).*$/, '')}`));

const chosen = [];
for (const [artist, title, why] of PICKS) {
  const res = await api('GET', '/search', { query: { q: `track:${title} artist:${artist.split(' & ')[0]}`, type: 'track', limit: 10, market: 'GB' } });
  const items = res?.tracks?.items ?? [];
  const wantA = norm(artist), wantT = norm(title);
  // The original recording, not a later remix or re-recording: among the matches, the earliest release.
  const suffix = (t) => t.name.slice(title.length);
  const matches = items.filter((t) => t.artists.some((a) => norm(a.name) === wantA) && norm(t.name).startsWith(wantT) && !/remix|dub|live|demo|acoustic|xlv/i.test(suffix(t)));
  const loose = items.filter((t) => t.artists.some((a) => norm(a.name).includes(wantA.split(' ')[0])) && norm(t.name).includes(wantT.split(' ')[0]));
  // The plain album recording first (no "single edit", "extended", "mono"), then the earliest release.
  const rank = (t) => (/edit|single|extended|mono|version/i.test(suffix(t)) ? 1 : 0);
  const byYear = (list) => [...list].sort((x, y) => rank(x) - rank(y) || (x.album.release_date || '9999').localeCompare(y.album.release_date || '9999'))[0];
  const hit = byYear(matches) ?? byYear(loose);
  if (!hit) { console.log(`  MISSING  ${artist} - ${title}`); continue; }
  const key = `${norm(hit.artists[0].name)}|${norm(hit.name).replace(/ (remaster|remastered|mix|version).*$/, '')}`;
  const already = likedIds.has(hit.id) || likedKeys.has(key);
  console.log(`  ${already ? 'LIKED   ' : 'ok      '} ${hit.artists[0].name} - ${hit.name}  (${(hit.album.release_date || '').slice(0, 4)})  ${why}`);
  if (!already) chosen.push({ uri: hit.uri, artist: hit.artists[0].name, name: hit.name, year: (hit.album.release_date || '').slice(0, 4), why });
}
console.log(`\n${chosen.length} of ${PICKS.length} picks resolved and not already liked.`);
if (!CREATE) { console.log('dry run; add --create to make the playlist'); process.exit(0); }

const user = await me();
const made = await createPlaylist(user.id, NAME, DESCRIPTION);
await addTracks(made.id, chosen.map((t) => t.uri));
fs.writeFileSync(`data/playlist-${SET}.json`, JSON.stringify({ id: made.id, url: made.external_urls?.spotify, madeAt: new Date().toISOString(), tracks: chosen }, null, 2));
console.log(`\nmade "${NAME}": ${made.external_urls?.spotify}`);
