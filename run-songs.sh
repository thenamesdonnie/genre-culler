#!/bin/bash
# Per-song pass. Waits for the Last.fm artist crawl (shared rate limit), crawls track tags,
# waits for the artist classification to finish (needs its labels as priors), then classifies songs.
cd "$(dirname "$0")"
while pgrep -f '^node lastfm\.js' >/dev/null; do sleep 10; done
node lastfm-tracks.js
until grep -q 'PIPELINE DONE' data/classify.log; do sleep 15; done
node classify-songs.js
node classify.js normalize
curl -s -X POST -H 'Content-Type: application/json' -d '{"playlistId":"64Dr36r3WvgVNpkPmHJ8nB"}' http://127.0.0.1:3320/api/reapply
echo; echo SONGS DONE
