# Starship Captains — rules summary and every call this engine makes

Unofficial fan implementation of **Starship Captains** (Czech Games Edition, 2022,
Peter B. Hoffgaard). This file is the reference for what the engine does and, more
importantly, **where it had to decide something the rulebook leaves open**. If a game
goes wrong, start here.

The rulebook lives in `ref/rulebook/` (gitignored). All card content was transcribed from
the owner's photos in `ref/photos-hires/`.

---

## The shape of a game

Four rounds. On your turn you either **activate a room**, **complete a mission**, or
**pass** for the rest of the round. Before acting you may train and promote crew. You may
keep taking turns until you pass; the round ends when everyone has passed.

Scoring is kept internally in **half-points** (`pts2`, `total2`) so the ½ per medal and
artifact never introduces floating point. Divide by two to show it.

## Crew

Single characters, so the queue is a plain comparable array:

| | |
|---|---|
| `r` `y` `b` | red / yellow / blue ensigns |
| `g` | cadet |
| `R` `Y` `B` | commanders (uppercase = promotion ring) |
| `A` | android |

- A **cadet** works only the gray Repair room and matches no mission line.
- An **android** never activates a room, matches every mission line including gold, and
  **leaves the game** after the mission rather than joining the queue. That is what makes
  Oil Bath worth a card.
- A **commander** does its line or room as an ensign of its colour, then takes a **second
  task**: do the same line/room again, or call a cadet or same-colour ensign up from
  anywhere in the queue.

## Missions

Assign one ready-room figure per line, top to bottom. A figure that doesn't match its
line's colour does nothing there, but the mission still scores its points. Four lines in
the deck are **gold** — Steal Secret Plans, Tincan Library, Gateway to the Stars and
Restore the Hive Mind — and only an android can match those.

After a mission: crew slide into the queue in line order, the highest face-up triangle
tile moves face down onto the cleared planet, and a new mission is dealt where that tile
came from. When tile 1 is turned face down, the **pirate uprising** fires.

---

## Interpretations — the calls this engine makes

These are the places the rules are silent, ambiguous, or impractical on a phone. Each one
is a deliberate choice, not an oversight.

### Mission lines are offered only when they can hurt
The rules let you refuse **any** line. This engine resolves a line automatically when it
can only help, and asks "resolve / skip" only when the line contains damage or an ambush.
Otherwise you would tap through a confirmation for every line of every mission.

### Events resolve themselves for the other player
Events hit everyone, but the pending machine only ever asks the player whose turn it is.
So when an event damages or repairs someone else: damage jettisons their first spare
token, and a repair takes the first damage it finds (excess, then cargo, then tech slot,
then a sabotaged room). Only their own turn asks them to choose.

### Medals are spent before stored tokens
With the Artifact or Trophy Display installed, a stored artifact or pirate token can pay
as a medal. The engine spends real medals first, then the oldest qualifying token, rather
than asking which to spend.

### Draw-three leftovers go to the bottom
"Draw 3 and research one of them" — the two you don't take go to the bottom of their deck.

### Ni'an Expansion Treaty ignores route colour
It puts a pirate on *every* empty route around that planet, colourless routes included.
Route colour only constrains an **ambush**, which must match the pirate's exhaust.

### The Tincan event shares its tech in place
The Tincan track's face-up alpha tech becomes usable by **every** player once the event
fires. It is never installed in anyone's slot, so it pays no edge bonuses and can't be
recycled.

### Gateway to the Stars is information only
"Look at the top 3 missions, then move" leaves the deck untouched. It cannot be undone,
because you cannot un-see it.

---

## Board facts worth knowing

- **Routes.** 25 routes between 14 locations. A route is either colourless or carries one
  colour along its whole length, marked by a dot at each end. **Every planet has exactly
  one red, one green and one yellow route**; planets with more than three routes have the
  rest colourless (green–lava, home–lava, home–wreck, wreck–crater). A test enforces this,
  so an ambush always has a defined destination.
- **Arrow colours on cards.** purple = Cooperative, gold = Tincan, black = Ni'an, white
  outline = any track of your choice.
- **Slashed hexagons.** A teal slashed hexagon means spend an **artifact**; a black one
  with a skull means spend a **pirate token**.
- **Mirrored techs.** Five abilities are printed on two cards each whose **edge icons are
  mirror images**: Auxiliary Engine, Quantum Torpedoes, Dimensional Lockers, Omega
  Megacomputer and Time Turner. They are separate entries (`..._m`), not one entry with a
  copy count, because the edges are what the tech-slot bonuses read.
- **Tech bonuses.** When a tech goes into a slot, any edge icon matching the facing edge of
  the neighbouring slot or card pays out at once, resolved repair → medal → move.

## Nothing is hidden between players

Every input to `score` is open information, so the UI can show each player's ship, cargo
and current score in full without leaking anything:

- **Artifacts in cargo are face up** (rulebook p. 9): "When you gain artifact or pirate
  tokens, simply place them in empty cargo slots. Artifacts go face up." Only the supply
  is face down, plus the artifacts the Crowdsourcing event puts on room techs - and the
  fact that event has to say "face-down" is itself the proof that face up is the default.
- **Omega techs** sit installed in a slot, face up, so their scoring condition is readable.
- **Completed missions** are kept face down (p. 13), but only for tidiness: every player
  watched that card sit face up on a planet and watched it being taken.

The genuinely hidden zones are the decks and bags, listed under Undo below.

## Undo

The current turn's history lives in the game state, so undo survives a reload, a device
switch, and online it is just another save. A move can't be taken back if it revealed
hidden information: the tech, omega or mission decks, the artifact or pirate bags, a tile
turning over, or the Gateway peek above.

## Not implemented

- **Solo mode** (Captain Shadow, action cards, passengers). Same call as Drillers.
- **The 4-player board side.** The engine supports 1–4 seats but only the 1–3 player board
  is transcribed.
- **Oil Bath, Hull Plating and the Holodeck**, plus the four discard-to-use techs
  (Quantum Torpedoes, Omega Megacomputer, Ram Drive, Time Turner): these need an action
  for using an installed tech, which does not exist yet. They sit in slots and pay their
  edge bonuses, but their printed abilities do nothing.
