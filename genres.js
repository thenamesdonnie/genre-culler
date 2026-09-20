// Merge genre evidence from local caches onto tracks. Sources:
//   data/mb-artists.json      MusicBrainz community tags per artist  (mb.js)
//   data/claude-artists.json  Claude microgenre classification       (classify.js)
//   data/label-map.json       synonym merges for Claude labels       (classify.js normalize)
import fs from 'node:fs';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// MusicBrainz tags that are not genres.
const MB_JUNK = /^(seen live|favou?rites?|own(ed)?|.*\d{4}s?$|male vocalists?|female vocalists?|american|british|english|canadian|australian|german|french|japanese|swedish|scottish|irish|usa|uk|united states|producer|rapper|singer|songwriter|band|group|duo|composer|dj|guitarist|pianist|vocalist|musician|artist|unknown|.*-artiest|.*-artist)$/i;

export function sources() {
  return {
    mb: readJson('data/mb-artists.json', {}),
    claude: readJson('data/claude-artists.json', {}),
    lastfm: readJson('data/lastfm-artists.json', {}),
    songs: readJson('data/claude-tracks.json', {}),
    labelMap: readJson('data/label-map.json', {}),
  };
}

export function applyGenres(tracks) {
  const { mb, claude, lastfm, songs, labelMap } = sources();
  // Never let normalisation collapse a specific label into a broad family name.
  const BROAD = new Set(['hip hop', 'r&b', 'pop', 'rock', 'metal', 'punk', 'indie', 'electronic', 'jazz', 'soul', 'funk', 'folk', 'country', 'blues', 'reggae', 'latin', 'african', 'classical', 'soundtrack', 'ambient', 'experimental', 'world', 'edm', 'electronica', 'dance']);
  const canon = l => (labelMap[l] && !BROAD.has(labelMap[l])) ? labelMap[l] : l;
  for (const t of tracks) {
    const mbTags = new Set(), claudeTags = new Set(), lfTags = new Set();
    let primary = null, parent = null, confidence = 0;
    for (const a of t.artists) {
      for (const [tag] of (mb[a.id]?.tags || []).slice(0, 8)) if (!MB_JUNK.test(tag)) mbTags.add(tag.toLowerCase());
      for (const [tag, w] of (lastfm[a.id]?.tags || []).slice(0, 8)) if (w >= 5 && !MB_JUNK.test(tag)) lfTags.add(tag);
      const c = claude[a.id];
      if (c) {
        if (c.primary !== 'unknown') claudeTags.add(canon(c.primary));
        for (const s of c.secondary) claudeTags.add(canon(s));
        if (primary === null && c.primary !== 'unknown') { primary = canon(c.primary); parent = c.parent; confidence = c.confidence; }
      }
    }
    const sc = songs[t.id];
    if (sc && sc.primary !== 'unknown') {
      t.artistPrimary = primary;
      primary = canon(sc.primary); parent = sc.parent; confidence = sc.confidence;
      claudeTags.add(primary); for (const x of sc.secondary) claudeTags.add(canon(x));
      t.songLevel = true;
    }
    t.mbTags = [...mbTags];
    t.lfTags = [...lfTags];
    t.claudeTags = [...claudeTags];
    t.primary = primary;                 // Claude's microgenre for the lead artist (first artist with a result)
    t.parent = parent;
    t.confidence = confidence;
    t.genres = [...new Set([...claudeTags, ...lfTags, ...mbTags])]; // union, for the "rarest tag" mode
  }
  return {
    mbArtists: Object.keys(mb).length, mbWithTags: Object.values(mb).filter(e => e.tags?.length).length,
    claudeArtists: Object.keys(claude).length, labelMerges: Object.keys(labelMap).length,
    songsClassified: Object.keys(songs).length,
    lastfmArtists: Object.keys(lastfm).length, lastfmWithTags: Object.values(lastfm).filter(e => e.tags?.length).length,
  };
}
