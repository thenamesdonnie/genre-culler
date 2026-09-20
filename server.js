import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as sp from './spotify.js';
import { applyGenres } from './genres.js';

const PORT = Number(sp.env.PORT || 3320);
const DATA = path.resolve('data');
fs.mkdirSync(DATA, { recursive: true });

const scanFile = id => path.join(DATA, `scan-${id}.json`);
const cullsFile = id => path.join(DATA, `culls-${id}.json`);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

const jobs = new Map(); // playlistId -> { status, progress, error }
// OAUTH STATE, ON DISK AND PLURAL. It was one variable in memory, which broke twice over: a server
// restart between /login and Spotify's callback wiped it, and two open tabs meant the second login
// overwrote the first tab's state. Both showed up as "state mismatch" with nothing obviously wrong.
// So: a small set of unspent states with a ten minute expiry, persisted, pruned on every use.
const stateFile = path.join(DATA, 'oauth-states.json');
function issueState() {
  const states = readJson(stateFile, {});
  const now = Date.now();
  for (const [k, exp] of Object.entries(states)) if (exp < now) delete states[k];
  const state = crypto.randomBytes(8).toString('hex');
  states[state] = now + 10 * 60_000;
  writeJson(stateFile, states);
  return state;
}
function spendState(state) {
  const states = readJson(stateFile, {});
  const ok = Boolean(state && states[state] && states[state] > Date.now());
  if (state) delete states[state];
  writeJson(stateFile, states);
  return ok;
}

async function runScan(playlistId) {
  const job = { status: 'running', progress: 'starting', startedAt: Date.now() };
  jobs.set(playlistId, job);
  try {
    const pl = await sp.playlist(playlistId);
    const tracks = await sp.playlistTracks(playlistId, (n, t) => { job.progress = `tracks ${n}/${t}`; });
    job.progress = 'applying genre data';
    const coverage = applyGenres(tracks);
    const result = {
      playlist: { id: pl.id, name: pl.name, owner: pl.owner, total: pl.items?.total ?? pl.tracks?.total, snapshot_id: pl.snapshot_id },
      scannedAt: new Date().toISOString(),
      coverage,
      tracks,
    };
    writeJson(scanFile(playlistId), result);
    job.status = 'done';
  } catch (e) {
    console.error('scan failed', e);
    job.status = 'error'; job.error = e.message;
  }
}

async function findOrCreateCullPlaylist(userId, sourceName) {
  const name = `Culled from ${sourceName}`.slice(0, 100);
  const mine = await sp.myPlaylists();
  const existing = mine.find(p => p.name === name);
  if (existing) return existing.id;
  const created = await sp.createPlaylist(userId, name, `Songs removed from "${sourceName}" by the genre culler. Safe to delete once you are happy.`);
  return created.id;
}

async function cull(playlistId, genre, uris) {
  const scan = readJson(scanFile(playlistId));
  if (!scan) throw new Error('no scan for that playlist');
  const known = new Set(scan.tracks.map(t => t.uri));
  const target = uris.filter(u => known.has(u) && !u.startsWith('spotify:local:'));
  if (!target.length) throw new Error('nothing to remove');
  const user = await sp.me();
  const cullPlaylistId = await findOrCreateCullPlaylist(user.id, scan.playlist.name);
  // Snapshot before touching anything.
  const cullId = crypto.randomUUID();
  writeJson(path.join(DATA, `backup-${playlistId}-${Date.now()}.json`), scan);
  await sp.addTracks(cullPlaylistId, target);
  await sp.removeTracks(playlistId, target);
  const removed = scan.tracks.filter(t => target.includes(t.uri));
  scan.tracks = scan.tracks.filter(t => !target.includes(t.uri));
  writeJson(scanFile(playlistId), scan);
  const culls = readJson(cullsFile(playlistId), []);
  const entry = { id: cullId, genre, at: new Date().toISOString(), cullPlaylistId, tracks: removed, undone: false };
  culls.push(entry);
  writeJson(cullsFile(playlistId), culls);
  return { cullId, removed: removed.length, cullPlaylistId };
}

async function undo(playlistId, cullId) {
  const culls = readJson(cullsFile(playlistId), []);
  const entry = culls.find(c => c.id === cullId);
  if (!entry || entry.undone) throw new Error('nothing to undo');
  const uris = entry.tracks.map(t => t.uri);
  await sp.addTracks(playlistId, uris);
  await sp.removeTracks(entry.cullPlaylistId, uris);
  entry.undone = true;
  writeJson(cullsFile(playlistId), culls);
  const scan = readJson(scanFile(playlistId));
  if (scan) { scan.tracks.push(...entry.tracks); writeJson(scanFile(playlistId), scan); }
  return { restored: uris.length };
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.resolve('public/index.html')));
    }
    if (req.method === 'GET' && p === '/login') {
      res.writeHead(302, { Location: sp.authorizeUrl(issueState()) });
      return res.end();
    }
    if (req.method === 'GET' && p === '/callback') {
      if (url.searchParams.get('error')) return send(res, 400, { error: url.searchParams.get('error') });
      if (!spendState(url.searchParams.get('state'))) {
        // Never a dead end: bounce straight back into a fresh login rather than showing an error
        // the user can do nothing with.
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      await sp.exchangeCode(url.searchParams.get('code'));
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    if (req.method === 'GET' && p === '/api/status') {
      if (!sp.loadTokens()) return send(res, 200, { loggedIn: false, defaultPlaylist: sp.env.DEFAULT_PLAYLIST });
      try {
        const user = await sp.me();
        return send(res, 200, { loggedIn: true, user: { id: user.id, name: user.display_name, product: user.product }, defaultPlaylist: sp.env.DEFAULT_PLAYLIST });
      } catch (e) {
        return send(res, 200, { loggedIn: false, error: e.message, defaultPlaylist: sp.env.DEFAULT_PLAYLIST });
      }
    }
    if (req.method === 'GET' && p === '/api/playlists') return send(res, 200, await sp.myPlaylists());
    if (req.method === 'POST' && p === '/api/scan') {
      const { playlistId } = await readBody(req);
      if (!playlistId) return send(res, 400, { error: 'playlistId required' });
      if (jobs.get(playlistId)?.status !== 'running') runScan(playlistId);
      return send(res, 202, { started: true });
    }
    const m = p.match(/^\/api\/scan\/([A-Za-z0-9]+)$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      const scan = readJson(scanFile(m[1]));
      return send(res, 200, { job: job || null, scan: job?.status === 'running' ? null : scan });
    }
    const c = p.match(/^\/api\/culls\/([A-Za-z0-9]+)$/);
    if (req.method === 'GET' && c) {
      const culls = readJson(cullsFile(c[1]), []);
      return send(res, 200, culls.map(x => ({ id: x.id, genre: x.genre, at: x.at, count: x.tracks.length, undone: x.undone })));
    }
    if (req.method === 'POST' && p === '/api/reapply') {
      const { playlistId } = await readBody(req);
      const scan = readJson(scanFile(playlistId));
      if (!scan) return send(res, 400, { error: 'scan first' });
      scan.coverage = applyGenres(scan.tracks);
      scan.reappliedAt = new Date().toISOString();
      writeJson(scanFile(playlistId), scan);
      return send(res, 200, scan.coverage);
    }
    if (req.method === 'POST' && p === '/api/cull') {
      const { playlistId, genre, uris } = await readBody(req);
      return send(res, 200, await cull(playlistId, genre, uris || []));
    }
    if (req.method === 'POST' && p === '/api/undo') {
      const { playlistId, cullId } = await readBody(req);
      return send(res, 200, await undo(playlistId, cullId));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, e.code === 'NOAUTH' ? 401 : 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`genre culler on http://127.0.0.1:${PORT}`));
