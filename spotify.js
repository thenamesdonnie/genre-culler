// Spotify Web API client: token storage/refresh, rate-limit retry, paging helpers.
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const TOKEN_FILE = path.join(DATA, 'tokens.json');
const API = 'https://api.spotify.com/v1';

export const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

export const SCOPES = [
  'playlist-read-private', 'playlist-read-collaborative',
  'playlist-modify-private', 'playlist-modify-public',
  // Added 2026-09-08 for the taste analysis behind the Game Night soundtrack. Liked Songs is a
  // stronger signal than any one playlist, and top-read is stronger still: it is what he actually
  // listens to rather than what he remembered to save.
  'user-library-read', 'user-top-read', 'user-read-recently-played',
].join(' ');

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
export function saveTokens(t) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export function authorizeUrl(state) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: env.REDIRECT_URI,
    state,
  });
  return `https://accounts.spotify.com/authorize?${q}`;
}

export async function exchangeCode(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env.REDIRECT_URI });
  const tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  saveTokens(tokens);
  return tokens;
}

export async function accessToken() {
  let t = loadTokens();
  if (!t) throw Object.assign(new Error('not logged in'), { code: 'NOAUTH' });
  if (Date.now() > t.expires_at - 60_000) {
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    t = { access_token: r.access_token, refresh_token: r.refresh_token || t.refresh_token, expires_at: Date.now() + r.expires_in * 1000 };
    saveTokens(t);
  }
  return t.access_token;
}

// Generic API call with 429/5xx retry.
export async function api(method, endpoint, { query, body } = {}) {
  const url = endpoint.startsWith('http') ? new URL(endpoint) : new URL(API + endpoint);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await accessToken();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 2) * 1000 + 250;
      console.log(`429 on ${endpoint}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  throw new Error(`gave up on ${method} ${endpoint} after retries`);
}

export async function me() { return api('GET', '/me'); }

export async function myPlaylists() {
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next) {
    const page = await api('GET', next);
    out.push(...page.items.map(p => ({ id: p.id, name: p.name, total: p.items?.total ?? p.tracks?.total ?? 0, owner: p.owner?.display_name, public: p.public })));
    next = page.next;
  }
  return out;
}

export async function playlist(id) {
  return api('GET', `/playlists/${id}`, { query: { fields: 'id,name,snapshot_id,owner(id,display_name),items(total)' } });
}

// All items in a playlist, 100 per page. Spotify moved this from /tracks to /items in 2025
// (the old path now returns 403) and the per-item key is `item`, not `track`. onProgress(fetched, total).
export async function playlistTracks(id, onProgress) {
  const out = [];
  let next = `/playlists/${id}/items?limit=100&fields=next,total,items(added_at,is_local,item(id,uri,name,type,duration_ms,is_local,artists(id,name),album(id,name,release_date)))`;
  while (next) {
    const page = await api('GET', next);
    for (const it of page.items) {
      const t = it.item || it.track;
      if (!t || (t.type && t.type !== 'track')) continue;
      out.push({
        id: t.id, uri: t.uri, name: t.name, isLocal: !!(t.is_local || it.is_local),
        durationMs: t.duration_ms, addedAt: it.added_at,
        album: t.album?.name, year: (t.album?.release_date || '').slice(0, 4),
        artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
      });
    }
    onProgress?.(out.length, page.total);
    next = page.next;
  }
  return out;
}

// Genres for many artist ids, 50 per call. Returns Map id -> { name, genres }.
export async function artistsGenres(ids, onProgress) {
  const map = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const res = await api('GET', '/artists', { query: { ids: batch.join(',') } });
    for (const a of res.artists) if (a) map.set(a.id, { name: a.name, genres: a.genres || [], popularity: a.popularity });
    onProgress?.(Math.min(i + 50, unique.length), unique.length);
  }
  return map;
}

export async function createPlaylist(userId, name, description) {
  return api('POST', `/me/playlists`, { body: { name, description, public: false } });
}

export async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await api('POST', `/playlists/${playlistId}/items`, { body: { uris: uris.slice(i, i + 100) } });
  }
}

export async function removeTracks(playlistId, uris) {
  let snapshot;
  for (let i = 0; i < uris.length; i += 100) {
    const r = await api('DELETE', `/playlists/${playlistId}/items`, {
      body: { items: uris.slice(i, i + 100).map(uri => ({ uri })) },
    });
    snapshot = r?.snapshot_id;
  }
  return snapshot;
}

/** Liked Songs, newest save first. 50 a page. onProgress(fetched, total). */
export async function savedTracks(onProgress) {
  const out = [];
  let next = '/me/tracks?limit=50';
  while (next) {
    const page = await api('GET', next);
    for (const it of page.items) {
      const t = it.track;
      if (!t || (t.type && t.type !== 'track')) continue;
      out.push({
        id: t.id, uri: t.uri, name: t.name, addedAt: it.added_at,
        album: t.album?.name, year: (t.album?.release_date || '').slice(0, 4),
        artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
      });
    }
    onProgress?.(out.length, page.total);
    next = page.next;
  }
  return out;
}

/** Top artists or tracks. range: short_term (~4 weeks), medium_term (~6 months), long_term (years). */
export async function topItems(type = 'artists', range = 'medium_term', limit = 50) {
  const page = await api('GET', `/me/top/${type}`, { query: { time_range: range, limit } });
  return page.items.map((x, i) => ({
    rank: i + 1, id: x.id, name: x.name,
    ...(type === 'tracks' ? { artists: (x.artists || []).map(a => ({ id: a.id, name: a.name })), year: (x.album?.release_date || '').slice(0, 4) } : {}),
  }));
}
