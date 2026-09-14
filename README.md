# games

Browser versions of board games to play with friends. One folder per game, served as a static site (GitHub Pages).

## Drillers (`drillers/`)

Unofficial fan implementation of CGE's *Drillers* for 2 players (engine supports 1–4; no solo bot).

- **Two phones:** one person taps *Host a new game* and shares the 5-letter code; the other enters it. Phones connect peer-to-peer (PeerJS); the host's phone runs the game, so the host should keep the page open. Reloading either phone resumes.
- **One phone:** *Pass & play* works offline once the page has loaded.

Run locally: `python3 -m http.server` from this folder, then open `http://localhost:8000/drillers/`.
Tests: `cd drillers && npm test` (Node 18+).

Game content (cards, tiles, floor cards, board numbers) is all in `drillers/js/data.js`, transcribed from the component photos in `drillers/ref/photos-hires/` (older low-res shots in `drillers/ref/photos/`). Anything marked `TODO verify` is still uncertain.
