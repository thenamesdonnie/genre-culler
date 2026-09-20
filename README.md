# Genre culler

Spotify stopped exposing genres on artists in 2026. This is a small tool that puts them back:
it classifies every artist and track in a playlist into microgenres, then lets you delete a whole
group with one button. There is a second job in here too, a taste reader that reports what you have
actually been listening to rather than what you think you have.

Node 22, no framework, no build step, one HTML file for the whole UI.

## Why

A playlist of several thousand tracks is unsortable by hand, and Spotify's own API will not tell
you what anything sounds like any more. Classification therefore happens locally: crawl what public
tag data still exists (MusicBrainz, Last.fm), then hand whatever is left to an LLM in batches, and
cache all of it so the page opens instantly on the next run.

## Run it

```sh
cp .env.example .env   # a Spotify client id and secret, at minimum
npm install
node server.js         # http://127.0.0.1:3320
```

Classification is a separate pass, `./run-all.sh`, which re-scans and re-classifies only what is
new. It can run through an Anthropic API key or through a local `claude -p` subscription;
`RUNNER=cc` picks the latter.

## What is here

| file | job |
| --- | --- |
| `server.js` | the web app: OAuth, scan, cull, undo |
| `spotify.js` | Spotify client. Read the comments before trusting any endpoint |
| `public/index.html` | the whole UI, one file |
| `genres.js` | merges the genre sources onto tracks |
| `classify.js`, `classify-songs.js` | LLM classification, artist level and song level |
| `llm.js` | runs the prompts, through an API key or a local CLI |
| `mb.js`, `lastfm.js`, `lastfm-tracks.js` | MusicBrainz and Last.fm tag crawls |
| `taste.js` | liked songs and top artists, for working out what you actually listen to |
| `playlist.js` | builds a playlist from a hand-written pick list in `picks/` |
| `run-all.sh` | the whole classification pipeline end to end |

## Things that will bite you

Written down because each one cost an afternoon.

- **Spotify moved almost everything in 2026.** Playlist contents are `/playlists/{id}/items`, not
  `/tracks`, which now returns 403. The per-item key is `item`, not `track`. The track count is
  `items.total`. You create a playlist with `POST /me/playlists`. And **artists have no `genres`
  field at all any more**, which is the entire reason the classification step exists.
- **An OAuth token keeps the permissions it was issued with.** Adding a scope means logging in
  again, and the app cannot detect this: it just starts getting 403s. There is a re-authorise link
  beside your name for exactly this.
- **The redirect URI must be a loopback address**, so reaching the app from another machine means
  an SSH port forward rather than pointing a browser at the LAN address.
- **MusicBrainz throttles hard**, roughly every other request, so a full crawl takes hours. Last.fm
  does not, and is the better source.
- **Batch size matters more than you would think** when classification runs through an LLM. Each
  call carries a fixed prompt overhead of roughly 24k tokens, so 150 items per call is far cheaper
  per item than 20.

## Licence

MIT.
