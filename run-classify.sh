#!/bin/bash
# Full classification pipeline: Claude classify -> label normalize -> reapply onto the scan.
cd "$(dirname "$0")"
set -e
if grep -q '^LASTFM_API_KEY=.' .env; then node lastfm.js; fi
node classify.js
node classify.js normalize
curl -s -X POST -H 'Content-Type: application/json' -d "{\"playlistId\":\"$(grep DEFAULT_PLAYLIST .env | cut -d= -f2)\"}" http://127.0.0.1:3320/api/reapply
echo
echo "done: reload the page"
