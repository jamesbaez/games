# games

Browser versions of board games to play with friends. One folder per game, served as a static site (GitHub Pages).

## Drillers (`drillers/`)

Unofficial fan implementation of CGE's *Drillers* for 2 players (engine supports 1–4; no solo bot).

- **Online:** one person taps *Create a new game* and shares the 8-letter code or invite link; the other taps *Join*. Every move is saved to a Firebase database, so you can play live or a move every few hours, and phones can sleep in between. Any phone or laptop with the code can pick up either player.
- **Turn alerts:** in the game, open *Turn alerts* and subscribe to the topic shown in the free [ntfy](https://ntfy.sh) app. You get a notification when it's your turn, unless you have the game on screen.
- **One phone:** *Pass & play* works offline once the page has loaded.

### Setting up the online database (once)

1. Go to https://console.firebase.google.com and create a project (any name; Google Analytics isn't needed).
2. In the left sidebar, open **Databases & Storage → Realtime Database** (or search for "Realtime Database"), then click **Create Database**. Pick a location and start in **locked mode**.
3. Open the **Rules** tab, replace everything with the contents of `drillers/firebase.rules.json`, and click **Publish**.
4. Copy the database URL shown on the **Data** tab (like `https://drillers-1234-default-rtdb.firebaseio.com`) into `DB_URL` in `drillers/js/net.js`.

Anyone who knows a game's code can read or change that game, and nobody can list the games.

Run locally: `python3 -m http.server` from this folder, then open `http://localhost:8000/drillers/`.
Tests: `cd drillers && npm test` (Node 18+).

Game content (cards, tiles, floor cards, board numbers) is all in `drillers/js/data.js`, transcribed from the component photos in `drillers/ref/photos-hires/` (older low-res shots in `drillers/ref/photos/`). Anything marked `TODO verify` is still uncertain.
