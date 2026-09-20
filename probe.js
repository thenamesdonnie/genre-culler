// Coverage probe: how many tracks in the playlist get at least one Spotify artist genre?
import { playlist, playlistTracks, artistsGenres, env } from './spotify.js';

const id = process.argv[2] || env.DEFAULT_PLAYLIST;
const pl = await playlist(id);
console.log(`Playlist: ${pl.name} (${pl.items?.total ?? pl.tracks?.total} tracks)`);
const tracks = await playlistTracks(id, (n, t) => process.stdout.write(`\rtracks ${n}/${t}   `));
console.log();
const artistIds = tracks.flatMap(t => t.artists.map(a => a.id));
const genres = await artistsGenres(artistIds, (n, t) => process.stdout.write(`\rartists ${n}/${t}   `));
console.log();
let covered = 0; const genreCount = new Map();
for (const t of tracks) {
  const g = new Set(t.artists.flatMap(a => genres.get(a.id)?.genres || []));
  if (g.size) covered++;
  for (const x of g) genreCount.set(x, (genreCount.get(x) || 0) + 1);
}
console.log(`tracks with >=1 genre: ${covered}/${tracks.length} (${(100 * covered / tracks.length).toFixed(1)}%)`);
console.log(`distinct genres: ${genreCount.size}`);
console.log('top 30:', [...genreCount].sort((a, b) => b[1] - a[1]).slice(0, 30));
