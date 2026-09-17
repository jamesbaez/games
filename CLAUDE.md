# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal repo of browser versions of board games, so the owner and a friend can play on their phones while traveling. Each game has its own folder of static files served by GitHub Pages. There is no build step, framework or backend.

- **Live site:** https://jamesbaez.github.io/games/ (the index page links each game)
- **Repo:** https://github.com/jamesbaez/games. Every push to `main` redeploys the site in about a minute.

| Game | Folder | Status |
|---|---|---|
| Drillers (Czech Games Edition, 2026) | `drillers/` | Playable. Unofficial fan implementation. Online 2-player via game code (live or slow, moves saved in Firebase), plus pass & play. The engine supports 1–4 players; there is no solo bot. |

"It doesn't have to be pretty." The UI is deliberately utilitarian and phone-first.

## Layout

```
index.html              list of games (link each new game here)
README.md
drillers/
  index.html            loads js/ui.js
  firebase.rules.json   Realtime Database rules (paste into the Firebase console when they change)
  css/style.css
  js/data.js            ALL game content: cards, tiles, floor cards, board numbers
  js/engine.js          pure rules engine (no DOM)
  js/net.js             online games: Firebase REST API, ntfy turn alerts, move-link packing
  js/ui.js              rendering + input
  test/engine.test.js   node:test unit tests + full-game bot simulation
  test/ui-fuzz.mjs      random-click smoke test of the real UI (no browser needed)
  test/online-fuzz.mjs  three UI copies play one online game through test/fake-firebase.mjs
  RULES.md              rules summary + every interpretation the engine makes
  ref/                  GITIGNORED local reference material (see below)
```

## Commands

```bash
cd drillers
npm test                 # engine unit tests + bot games (Node 18+, no deps to install)
npm run fuzz             # ui-fuzz, then online-fuzz
                         # ui-fuzz: clicks random buttons in ui.js through 4 local games (abandons any past 2500 turns)
                         #   args: node test/ui-fuzz.mjs <games> <seed> <maxTurns>; the same seed replays the same run
                         #   fails on runtime errors, a screen with no enabled buttons, or no game reaching game over
                         # online-fuzz: 3 devices (2 of them the same player) click for 8 s against a fake database
                         #   that fails writes and drops connections; fails if devices end up disagreeing
                         #   args: node test/online-fuzz.mjs <seconds> <dbUrl>; a real dbUrl also checks its rules

# run locally (from the repo root)
python3 -m http.server 8000   # then open http://localhost:8000/drillers/
                              # add ?db=<database url> to point online play at another database
```

Run both `npm test` and `npm run fuzz` after changing engine, data or UI code.

## Drillers architecture

**Engine (`js/engine.js`)**
- `setup({ names, seed })` returns a state. `apply(state, action)` returns a new state (it uses `structuredClone`) or throws `GameError` with a player-facing message for illegal moves.
- Deterministic: the RNG state lives in `state.rng`. The state is plain JSON.
- Actions are `{ p, type, ...params }`, where `p` is the acting seat. Phases run `ops` → `surface` (only if the mech ends on floor 0) → `upkeep` → next player.
- Card instances map `state.cards[iid] = defId`; look them up with `cardDef(state, iid)`.
- Card behaviour is data-driven through the `fx`, `choose`, `ability`, `passive`, `marketToOverflow` and `teleport` fields documented above `CARDS` in `data.js`. A new kind of effect needs a key in `applyFx` or a `special` in the `ability` case.
- Floor cards are hard-coded by id in `floorEffect` (reveal/corridor/collect) and `endOpsFloor` (end of Operations, with choices passed in `action.opt`).
- The state carries a version, `state.v` (currently 2). **When the state shape changes, bump it and `SAVE_VERSION` in `ui.js` together** so stale saved games are ignored rather than crashing.

**Online play (`js/net.js`)**
- Games live in a Firebase Realtime Database (free Spark plan, owner's Google account), set by `DB_URL` in `net.js`. It's used through the REST API only: no SDK, no auth.
- `rooms/<CODE>` (8 letters) = `{ seq, host, state }`. `state` is the engine state as a JSON string (the database drops empty arrays and nulls), missing until the second player joins.
- There is no host: every device applies actions with the engine and writes the whole room. `firebase.rules.json` only accepts `seq + 1`, so a device that missed a move gets its write refused (401), drops its queued writes, and reloads. **When the rules change, the owner must paste them into the Firebase console.**
- Writes are POSTs with `?x-http-method-override=PUT` so browsers skip the CORS preflight. Reads stream through `EventSource`, reopened on `visibilitychange`.
- A seat isn't tied to a device: any device with the code can pick a player. The full state goes to every device (trusted friends); the UI shows only your own hand and top card.
- **Turn alerts:** after a save that passes the turn, the device posts to the ntfy.sh topic `drillers-<code>-p<seat+1>`, unless `seen/<CODE>/<seat>` (written every 30 s while that seat's page is visible) is under 90 s old.
- localStorage: `drillers.online` (`{code, seat}` of the last online game), `drillers.local` (pass & play), `drillers.name`.

**UI (`js/ui.js`)**
- Every change re-renders all of `#app` via `innerHTML`.
- Buttons carry `data-act` JSON actions, handled by one delegated click listener. Lobby and navigation buttons use `data-lobby`.
- Pass & play shows a "pass the phone" curtain between turns.
- **Undo:** each device keeps a stack of earlier states of its own turn in `session.undo`. Each committed action is pushed unless `revealsInfo(prev, next)` in the engine says it exposed hidden information or passed the turn, in which case the stack is cleared. Online, an undo is just another save, and a move arriving from another device clears the stack. The stack lives only in memory.
- **Online saves** show immediately and queue in `session.saving`. `session.seq` is -1 while loading or reloading, and actions are refused until the room arrives.
- **Links:** `#room=<CODE>` (invite links and ntfy alert clicks) opens that game. `#move=` (pass & play only, the Menu bar's "Move device") packs `{mode:'local', state}` with `packSave` (gzip + base64url, about 3 KB).
- **Component images:** `pic(path)` renders a 🖼 button with `data-img="img/<path>.webp"`, which opens a full-screen viewer attached to `document.body`, so re-renders don't close it. Crops live in `drillers/img/{cards,floors,tiles}/` plus `board`, `dashboard` and `milestones`, named by the ids in `data.js`.

## Conventions

- Vanilla ES modules only: no bundler, no npm dependencies, no external scripts. The only outside services are Firebase (online games) and ntfy.sh (turn alerts), both over plain `fetch`/`EventSource`.
- Game content belongs in `data.js`, not in engine code. Keep the engine free of DOM access.
- Before assuming a rule, check `drillers/RULES.md`, then the rulebook PDF in `drillers/ref/rulebook/`, then the component photos in `drillers/ref/photos-hires/`.
- A new game gets its own top-level folder with its own `index.html`, linked from the root `index.html`. Don't build shared code until a second game actually needs it.
- Pushing to `main` updates the live site immediately, possibly while the friend is mid-game. State-shape changes break saved games unless the version is bumped (see above).

## Reference material (`drillers/ref/`, gitignored, local only)

- `photos-hires/`: the owner's full-resolution photos of every card, tile, floor card, the main board, the player dashboard and the milestone tokens. `data.js` was transcribed from these.
  - IMG_7399: starting floor cards
  - IMG_7400: deep floor cards
  - IMG_7401: starting deck
  - IMG_7402: DAMAGE
  - IMG_7403–7406: drill / move / utility / advanced shops
  - IMG_7407: corridor and barrier tiles
  - IMG_7408: dashboard
  - IMG_7411: main board
  - IMG_7412: milestone tokens and components
- `photos/`: older low-res shots (superseded).
- `rulebook/Drillers_rulebook_EN_2026-05-21.pdf`: the official English rulebook, also at https://filemanager.czechgames.com/storage/files/drillers/rules/Drillers_rulebook_EN_2026-05-21.pdf
- `press-kit/`: CGE press renders of the components.

Never commit anything from `ref/`. The files are large and contain the publisher's copyrighted art. The exception is `drillers/img/`: small per-component crops made from these files. The owner chose to publish those so the in-game 🖼 buttons work on the live site.

## Git

- **Always ask before `git commit` or `git push`.** The approval must be in the owner's current message; earlier approvals don't carry over.
- Use conventional commits: `type(scope): description`, e.g. `feat(drillers): add solo bot`.
- Do not add "Co-Authored-By: Claude" or "Generated with Claude Code" footers.

## Working style

- State assumptions. If a request is ambiguous or a rule is unclear, ask rather than guess.
- Prefer the minimum code that solves the problem. Touch only what the task needs, and match the existing style.
- Verify with `npm test` and `npm run fuzz` before calling work done.

## Status and known gaps (as of 2026-09-15)

- Online play replaced the PeerJS version on 2026-09-17. The database is the owner's Firebase project `drillers-6dbe9`. It has been tested with `online-fuzz` against both the fake and the real database, and with two copies of the page in headless Chrome against the real one, but **not yet on real phones**, and ntfy alerts have not been received on a real device.
- Solo mode (the bot boards on the back of the dashboards) is not implemented.
- An advanced card's Buy button stays enabled without a battery tile; the engine rejects it with a message.
- Some choices are made automatically: solid fuel burns the cheapest stored mineral, and Current-C Miner moves the cheapest market column.
- Bot simulations run long (~35 turns per player), but the bots are dumb, so this isn't a real pacing signal.
