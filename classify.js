// Classify every artist in the playlist into a microgenre using Claude, with MusicBrainz tags
// and the artist's own track titles as evidence. Resumable; results cached in data/claude-artists.json.
//   node classify.js            classify all unclassified artists
//   node classify.js normalize  merge near-duplicate labels into canonical ones (data/label-map.json)
//   node classify.js test 40    classify only the first 40 unclassified artists (dry run for quality/cost)
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from './spotify.js';

import { claudeCli as cli, stats as ccStats } from './llm.js';
const MODEL = 'claude-opus-5';
// RUNNER=cc routes every call through `claude -p` (Donnie's Claude Code subscription) instead of the API key.
const RUNNER = process.env.RUNNER || 'cc'; // API key only when RUNNER=api is set explicitly
const client = RUNNER === 'api' ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
if (RUNNER === 'api' && !env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY missing from .env'); process.exit(1); }
const claudeCli = (system, user, hint) => cli(MODEL, system, user, hint);
const OUT = 'data/claude-artists.json';
const BATCH = Number(process.env.BATCH) || (RUNNER === 'cc' ? 150 : 60), CONCURRENCY = 4;

const tracks = fs.existsSync('data/tracks-cache.json') ? JSON.parse(fs.readFileSync('data/tracks-cache.json', 'utf8'))
  : JSON.parse(fs.readFileSync(`data/scan-${env.DEFAULT_PLAYLIST}.json`, 'utf8')).tracks;
const mb = fs.existsSync('data/mb-artists.json') ? JSON.parse(fs.readFileSync('data/mb-artists.json', 'utf8')) : {};
const lastfm = fs.existsSync('data/lastfm-artists.json') ? JSON.parse(fs.readFileSync('data/lastfm-artists.json', 'utf8')) : {};
const JUNK = /^(seen live|favou?rites?|.*\d{4}s?$|male vocalists?|female vocalists?|under \d+ listeners|spotify|check out|.*-artiest)$/i;
const lfTagsFor = id => (lastfm[id]?.tags || []).filter(t => t[1] >= 5 && !JUNK.test(t[0])).slice(0, 6).map(t => t[0]);
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const save = () => fs.writeFileSync(OUT, JSON.stringify(cache));

// Evidence per artist: name, MB tags, a few track titles from the playlist, and collaborators.
const artists = new Map();
for (const t of tracks) for (const a of t.artists) {
  if (!a.id) continue;
  if (!artists.has(a.id)) artists.set(a.id, { id: a.id, name: a.name, tracks: [], with: new Set(), count: 0 });
  const e = artists.get(a.id); e.count++;
  if (e.tracks.length < 4) e.tracks.push(t.name + (t.year ? ` (${t.year})` : ''));
  for (const o of t.artists) if (o.id !== a.id) e.with.add(o.name);
}

const PARENTS = ['hip hop', 'r&b', 'pop', 'rock', 'metal', 'punk', 'indie', 'electronic', 'jazz', 'soul', 'funk', 'folk', 'country', 'blues', 'reggae', 'latin', 'african', 'classical', 'soundtrack', 'ambient', 'experimental', 'world', 'comedy', 'spoken word', 'other'];

const Schema = z.object({
  artists: z.array(z.object({
    id: z.string(),
    primary: z.string().describe('the single most specific microgenre that best describes this artist, lowercase'),
    secondary: z.array(z.string()).describe('0 to 3 other microgenres or scenes that fit, lowercase'),
    parent: z.enum(PARENTS),
    confidence: z.number().min(0).max(1),
  })),
});

const SYSTEM = `You are a music librarian with encyclopedic knowledge of artists and the Every Noise at Once style microgenre taxonomy (labels like "bedroom pop", "conscious hip hop", "australian psych", "bossa nova", "uk garage", "neo soul", "midwest emo", "scottish indie", "gym phonk", "japanese city pop", "lo-fi beats", "drill", "vaporwave", "chamber pop", "post-punk revival").

For each artist, choose ONE primary microgenre plus up to three secondary ones. Rules:
- Be as specific as the evidence supports. Prefer a scene, region, or era flavoured label over a broad one, but only when it is a real recognised label, not an invention. "indie rock" beats a made-up compound.
- Reuse labels consistently: two artists in the same scene must get the exact same label string. Lowercase, no punctuation except hyphens, ampersands and spaces, singular form ("hip hop" not "hip-hop", "r&b" not "rnb").
- If you know the artist, trust your knowledge over the evidence. If you do not, infer from the MusicBrainz tags, the track titles, the collaborators, and the release years, and lower the confidence. Give "unknown" as primary only if there is genuinely nothing to go on.
- parent is the broad family the primary belongs to.
- Classical composers and jazz standards writers count by the style of the recordings a listener would be hearing.
Return every artist id you were given exactly once.`;

async function classifyBatch(batch) {
  const lines = batch.map(a => {
    const tags = (mb[a.id]?.tags || []).slice(0, 6).map(t => t[0]).join(', ');
    const lf = lfTagsFor(a.id).join(', ');
    const w = [...a.with].slice(0, 3).join(', ');
    return `id=${a.id} | ${a.name} | ${a.count} track${a.count === 1 ? '' : 's'} | tracks: ${a.tracks.join('; ')}${lf ? ` | last.fm tags: ${lf}` : ''}${tags ? ` | mb tags: ${tags}` : ''}${w ? ` | with: ${w}` : ''}`;
  });
  const user = `Classify these ${batch.length} artists:\n\n${lines.join('\n')}`;
  if (RUNNER === 'cc') {
    const { obj, usage } = await claudeCli(SYSTEM, user, '{"artists":[{"id":string,"primary":string,"secondary":string[],"parent":one of ' + JSON.stringify(PARENTS) + ',"confidence":number 0-1}]}');
    const parsed = Schema.parse(obj);
    return { out: parsed.artists, usage };
  }
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: zodOutputFormat(Schema) },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('refusal: ' + res.stop_details?.explanation);
  if (!res.parsed_output) throw new Error('parse failed: ' + res.stop_reason);
  return { out: res.parsed_output.artists, usage: res.usage };
}

async function run(limit) {
  // Unclassified artists, plus low-confidence ones that were classified before Last.fm evidence existed for them.
  let todo = [...artists.values()].filter(a => !cache[a.id] || (cache[a.id].confidence < 0.7 && !cache[a.id].lastfmEvidence && lfTagsFor(a.id).length));
  if (limit) todo = todo.slice(0, limit);
  console.log(`${artists.size} artists, ${todo.length} to classify with ${MODEL} via ${RUNNER === 'cc' ? 'Claude Code subscription' : 'API key'}, batch ${BATCH}`);
  const batches = []; for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  const dropped = [];
  let done = 0; const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { out, usage: u } = await classifyBatch(batch);
          for (const k of Object.keys(usage)) usage[k] += u[k] || 0;
          const byId = new Map(out.map(o => [o.id, o]));
          for (const a of batch) {
            const o = byId.get(a.id);
            if (o) cache[a.id] = { name: a.name, primary: o.primary.trim().toLowerCase(), secondary: o.secondary.map(s => s.trim().toLowerCase()), parent: o.parent, confidence: o.confidence, lastfmEvidence: lfTagsFor(a.id).length > 0 };
            else dropped.push(a.name);
          }
          done += batch.length; save();
          console.log(`${done}/${todo.length}  e.g. ${batch[0].name} -> ${cache[batch[0].id].primary}`);
          break;
        } catch (e) {
          console.log(`batch failed (attempt ${attempt + 1}): ${e.message}`);
          if (attempt === 2) for (const a of batch) console.log('  skipped', a.name);
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (dropped.length) console.log(`${dropped.length} artists dropped by the model this pass (rerun picks them up):`, dropped.slice(0, 10).join(', '));
  const cost = (usage.input_tokens * 5 + usage.cache_creation_input_tokens * 6.25 + usage.cache_read_input_tokens * 0.5 + usage.output_tokens * 25) / 1e6;
  console.log('usage', usage, RUNNER === 'cc' ? `(${ccStats.calls} claude -p calls, list-price equivalent $${ccStats.costUsd.toFixed(2)}, billed to subscription)` : `approx cost $${cost.toFixed(2)}`);
  const primaries = new Map(); for (const c of Object.values(cache)) primaries.set(c.primary, (primaries.get(c.primary) || 0) + 1);
  console.log(`${primaries.size} distinct primary labels. Top:`, [...primaries].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(', '));
}

// Merge near-duplicate labels ("aussie psych" / "australian psych rock") into one canonical label each.
async function normalize() {
  const counts = new Map();
  const songs = fs.existsSync('data/claude-tracks.json') ? JSON.parse(fs.readFileSync('data/claude-tracks.json', 'utf8')) : {};
  for (const c of [...Object.values(cache), ...Object.values(songs)]) for (const l of [c.primary, ...c.secondary]) counts.set(l, (counts.get(l) || 0) + 1);
  const labels = [...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`);
  const MapSchema = z.object({ merges: z.array(z.object({ from: z.string(), to: z.string() })) });
  const normPrompt = `These are microgenre labels with usage counts from one music library. Find labels that are spelling variants, synonyms, or trivially nested versions of the same microgenre and map each variant to the single canonical label (prefer the more common, more standard Every Noise style name). Do NOT merge genuinely different genres, and do not merge a specific microgenre into its broad parent. Only output pairs that should merge.\n\n${labels.join('\n')}`;
  let merges;
  if (RUNNER === 'cc') {
    const { obj } = await claudeCli('You are a music librarian.', normPrompt, '{"merges":[{"from":string,"to":string}]}');
    merges = MapSchema.parse(obj).merges;
  } else {
    const res = await client.messages.parse({
      model: MODEL, max_tokens: 32000,
      output_config: { effort: 'medium', format: zodOutputFormat(MapSchema) },
      messages: [{ role: 'user', content: normPrompt }],
    });
    merges = res.parsed_output?.merges || [];
  }
  const map = Object.fromEntries(merges.filter(m => m.from !== m.to).map(m => [m.from.toLowerCase(), m.to.toLowerCase()]));
  fs.writeFileSync('data/label-map.json', JSON.stringify(map, null, 2));
  console.log(`${merges.length} merges written to data/label-map.json`, merges.slice(0, 15));
}

const cmd = process.argv[2];
if (cmd === 'normalize') await normalize();
else if (cmd === 'test') await run(Number(process.argv[3]) || 40);
else await run();
