// Per-song microgenre classification for songs whose lead artist has 2+ songs in the playlist.
// Uses the artist-level classification as a prior. Resumable; cached in data/claude-tracks.json.
//   node classify-songs.js          classify all eligible unclassified songs
//   node classify-songs.js test 60  one batch only
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from './spotify.js';

import { claudeCli as cli, stats as ccStats } from './llm.js';
const MODEL = 'claude-opus-5';
const RUNNER = process.env.RUNNER || 'cc'; // API key only when RUNNER=api is set explicitly
const client = RUNNER === 'api' ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
if (RUNNER === 'api' && !env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY missing from .env'); process.exit(1); }
const OUT = 'data/claude-tracks.json';
const BATCH = Number(process.env.BATCH) || (RUNNER === 'cc' ? 150 : 60), CONCURRENCY = 4;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const tracks = readJson('data/tracks-cache.json', []);
const artistsC = readJson('data/claude-artists.json', {});
const labelMap = readJson('data/label-map.json', {});
const lfTracks = readJson('data/lastfm-tracks.json', {});
const lfArtists = readJson('data/lastfm-artists.json', {});
const canon = l => labelMap[l] || l;
const JUNK = /^(seen live|favou?rites?|.*\d{4}s?$|male vocalists?|female vocalists?|under \d+ listeners|spotify|check out|love|beautiful|awesome|.*-artiest)$/i;
const lf = (entry, min) => (entry?.tags || []).filter(t => t[1] >= min && !JUNK.test(t[0])).slice(0, 6).map(t => t[0]);
const cache = readJson(OUT, {});
const save = () => fs.writeFileSync(OUT, JSON.stringify(cache));

const perArtist = new Map();
for (const t of tracks) { const id = t.artists[0]?.id; if (id) perArtist.set(id, (perArtist.get(id) || 0) + 1); }
const eligible = tracks.filter(t => t.id && perArtist.get(t.artists[0]?.id) >= 2);

// Vocabulary from the artist pass keeps song labels consistent with artist labels.
const vocabCount = new Map();
for (const a of Object.values(artistsC)) for (const l of [a.primary, ...a.secondary]) if (l !== 'unknown') vocabCount.set(canon(l), (vocabCount.get(canon(l)) || 0) + 1);
const VOCAB = [...vocabCount].sort((a, b) => b[1] - a[1]).slice(0, 250).map(x => x[0]);
const PARENTS = ['hip hop', 'r&b', 'pop', 'rock', 'metal', 'punk', 'indie', 'electronic', 'jazz', 'soul', 'funk', 'folk', 'country', 'blues', 'reggae', 'latin', 'african', 'classical', 'soundtrack', 'ambient', 'experimental', 'world', 'comedy', 'spoken word', 'other'];

const Schema = z.object({
  songs: z.array(z.object({
    id: z.string(),
    primary: z.string().describe('the single most specific microgenre for THIS song, lowercase'),
    secondary: z.array(z.string()).describe('0 to 2 other fitting microgenres, lowercase'),
    parent: z.enum(PARENTS),
    confidence: z.number().min(0).max(1),
  })),
});

const SYSTEM = `You are a music librarian classifying individual songs into Every Noise at Once style microgenres. Songs are grouped by artist. For each artist you are given the artist-level classification from an earlier pass; treat it as the default and give a different label only when the specific song clearly belongs elsewhere (a different era, a side style, a genre-hopping artist, a cover, a feature on someone else's track, an ambient interlude on a rap album). Use your own knowledge of the song and album first, then the Last.fm tags, album name and year.

Rules:
- Lowercase labels, hyphens/ampersands/spaces only, "hip hop" not "hip-hop", "r&b" not "rnb".
- Prefer labels from the existing vocabulary below so groups stay consistent; add a new label only when nothing in the vocabulary fits.
- Be specific where you can be (scene, region, era), never invent compound labels that are not real recognised genre names.
- parent is the broad family of the primary label.
- Return every song id exactly once.

Existing vocabulary (most used first): ${VOCAB.join(', ')}`;

function describeArtist(a) {
  const c = artistsC[a.id];
  if (!c) return 'artist pass: none';
  return `artist pass: ${canon(c.primary)}${c.secondary.length ? ` (also ${c.secondary.map(canon).join(', ')})` : ''}, parent ${c.parent}, confidence ${c.confidence}`;
}

async function classifyBatch(batch) {
  const byArtist = new Map();
  for (const t of batch) { const k = t.artists[0].id; if (!byArtist.has(k)) byArtist.set(k, []); byArtist.get(k).push(t); }
  const blocks = [...byArtist.values()].map(songs => {
    const a = songs[0].artists[0];
    const lfa = lf(lfArtists[a.id], 10).join(', ');
    const head = `## ${a.name}  |  ${describeArtist(a)}${lfa ? `  |  last.fm artist tags: ${lfa}` : ''}`;
    const lines = songs.map(t => {
      const feats = t.artists.slice(1).map(x => x.name).join(', ');
      const lft = lf(lfTracks[t.id], 5).join(', ');
      return `id=${t.id} | ${t.name}${feats ? ` (with ${feats})` : ''} | album: ${t.album}${t.year ? ` (${t.year})` : ''}${lft ? ` | last.fm song tags: ${lft}` : ''}`;
    });
    return [head, ...lines].join('\n');
  });
  const user = `Classify these ${batch.length} songs:\n\n${blocks.join('\n\n')}`;
  if (RUNNER === 'cc') {
    const { obj, usage } = await cli(MODEL, SYSTEM, user, '{"songs":[{"id":string,"primary":string,"secondary":string[],"parent":one of ' + JSON.stringify(PARENTS) + ',"confidence":number 0-1}]}');
    return { out: Schema.parse(obj).songs, usage };
  }
  const res = await client.messages.parse({
    model: MODEL, max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: zodOutputFormat(Schema) },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('refusal: ' + res.stop_details?.explanation);
  if (!res.parsed_output) throw new Error('parse failed: ' + res.stop_reason);
  return { out: res.parsed_output.songs, usage: res.usage };
}

async function run(limit) {
  // Order by artist so each batch holds whole catalogues.
  let todo = eligible.filter(t => !cache[t.id]).sort((a, b) => a.artists[0].id.localeCompare(b.artists[0].id) || (a.year || '').localeCompare(b.year || ''));
  if (limit) todo = todo.slice(0, limit);
  console.log(`${eligible.length} eligible songs, ${todo.length} to classify with ${MODEL} via ${RUNNER === 'cc' ? 'Claude Code subscription' : 'API key'}, batch ${BATCH} (vocab ${VOCAB.length} labels)`);
  const batches = []; for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let done = 0; const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { out, usage: u } = await classifyBatch(batch);
          for (const k of Object.keys(usage)) usage[k] += u[k] || 0;
          const byId = new Map(out.map(o => [o.id, o]));
          for (const t of batch) {
            const o = byId.get(t.id);
            if (o) cache[t.id] = { primary: o.primary.trim().toLowerCase(), secondary: o.secondary.map(s => s.trim().toLowerCase()), parent: o.parent, confidence: o.confidence };
          }
          done += batch.length; save();
          const ex = batch.find(t => cache[t.id]);
          console.log(`${done}/${todo.length}  e.g. ${ex?.artists[0].name} - ${ex?.name} -> ${ex && cache[ex.id]?.primary}`);
          break;
        } catch (e) {
          console.log(`batch failed (attempt ${attempt + 1}): ${e.message}`);
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const cost = (usage.input_tokens * 5 + usage.cache_creation_input_tokens * 6.25 + usage.cache_read_input_tokens * 0.5 + usage.output_tokens * 25) / 1e6;
  console.log('usage', usage, RUNNER === 'cc' ? `(${ccStats.calls} claude -p calls, list-price equivalent $${ccStats.costUsd.toFixed(2)}, billed to subscription)` : `approx cost $${cost.toFixed(2)}`);
  let differ = 0, total = 0;
  for (const t of eligible) { const c = cache[t.id], a = artistsC[t.artists[0].id]; if (c && a) { total++; if (c.primary !== canon(a.primary)) differ++; } }
  console.log(`${differ}/${total} songs got a different label from their artist`);
}

const cmd = process.argv[2];
if (cmd === 'test') await run(Number(process.argv[3]) || 60); else await run();
