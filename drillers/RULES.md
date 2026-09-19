# Drillers: rules as implemented

This summarizes the official rulebook (`ref/rulebook/`) plus the component photos (`ref/photos-hires/`), and records every interpretation the engine makes. Numbers live in `js/data.js`. If this file and the rulebook disagree, the rulebook wins; fix the engine.

## Components as modelled

- **Mine:** 7 floors. 0 = surface, 1 = entrance, 2–6 underground.
  - **Barriers:** floors 3–6 start behind barriers (drill cost 3/4/5/6; worth 10/15/20/25 points).
  - **Corridor stacks:** floors 2–6 each have one, shuffled per floor (5/6/7/6/5 tiles). Excavating costs 2/2/3/4/5 drills.
  - **Starting minerals:** F2 silver×2; F3 gold, sapphire; F4 gold, sapphire, emerald; F5 sapphire, emerald, ruby; F6 gold, sapphire, emerald, ruby.
  - **Depth penalty at game end:** F2 −3, F3 −5, F4 −7, F5 −9, F6 −11. The surface and entrance cost nothing.
- **Floor cards:** 3 starting cards (one is dealt face up on F2) and 9 deep cards (one face down on each of F3–F6).
- **Shops:** 4 shops (drill, move, util, advanced), each showing 2 cards. 2 extra advanced cards sit under the F4 floor card.
- **Player:** 8 starting cards + 1 DAMAGE, with TORSO first.
  - Fuel starts at 10/10. Storage holds 2 (max 7).
  - 3 drones (1 face up). A shop refresh tile.
  - The first player is chosen at random. Starting resources by turn order (rulebook setup step 16): 2p 2 credits + 3 cards / 4 credits + 4 cards; 3p credits 2 / 3 / 5, cards 3 / 4 / 4; 4p credits 2 / 5 / 4 / 7, cards 3 / 3 / 4 / 4.
- **Minerals:**

| | silver | gold | sapphire | emerald | ruby |
|---|---|---|---|---|---|
| Points | 2 | 3 | 4 | 5 | 6 |
| Market, 1st/2nd/3rd sale | 4/3/2 | 5/4/3 | 6/6/5 | 8/8/7 | 10/10/9 |
| Overflow sale | 0 | 0 | 4 | 6 | 8 |

## Turn

1. **Operations.** Do any of these, in any order, as often as you can afford:
   - **Play a card for its main effect** (pay its fuel, or burn a mineral from storage into overflow for "solid fuel").
   - **Burn a card for fuel** (never above your max).
   - **Default functions:** 3 fuel → 1 move; 4 fuel → 1 drill; once per turn, take 1 damage for 3 fuel.
   - **Move:** 1 move = one floor up or down, onto open floors only.
   - **Drill:**
     - 1 drill collects a mineral on your floor, if storage has room.
     - The corridor cost excavates the top corridor tile: its minerals go onto the floor and the tile onto your track.
     - The barrier cost, while standing directly above a barrier, removes it: the tile goes onto your track, the floor card is revealed and resolved, and you move down for free.
   - **Exhaust a mine tile** for its bottom effect (it loses its printed point loss), at any point during Operations or Surfacing (rulebook p. 9 note). Battery tiles can't be exhausted this way; see buying.
   - **Use a face-up drone** (flip it down) to sell 1 mineral or buy 1 card.
   - **Use abilities** of cards played this turn, or of permanent cards.
2. **Surfacing** (only if Operations ended on the surface). In any order:
   - Sell all storage.
   - One paid repair per surfacing (5 credits).
   - Discard hand cards for 2 credits each.
   - Upgrade storage (3 credits) or fuel (next cost in 2,2,3,3,3,4,4,4; the cap starts over spaces 11–12, max 10 → 18).
   - Refuel to max. The engine does this automatically when you finish surfacing, after any tank upgrade.
   - Buy cards: bought cards go on top of your deck; permanent cards go beside the dashboard.
   - Shop refresh tile, once per game.
3. **Upkeep.**
   - Keep 1 hand card free; pay 1 fuel for each extra card kept. Discard the rest along with the play area.
   - Reset moves and drills to 0.
   - Draw 3. Reshuffle as soon as the deck is empty.
   - Refill the shops.

## Track, milestones, end

- **The track** is 25 notches. Tiles take their width in notches: corridors 2/2/3/4/5 on F2–F6; barriers 3/4/5/6.
- **Overflow** has 10 slots, each 1 notch. Every overflow cube shortens the track by 1. Beyond 10 cubes, minerals still sell but no longer shorten the track.
- **Milestones:**
  - The first player whose tiles total ≥ 5 / 10 / 15 notches takes the 4 / 5 / 6 point token, and every other player gains 3 / 4 / 5 credits. The printed lines sit at about 4.5 / 9.4 / 14.2 notches.
  - Whoever triggers the end takes the 18-point token, and every other player draws 1 card.
- **End trigger:** tiles ≥ 25 − overflow cubes. It's checked whenever a tile or an overflow cube is added, and only for a player with at least one tile. The triggering player finishes their turn, then each other player takes one final turn.
- **Scoring:**
  - **Points for:** tile points (minus losses for exhausted tiles); every mineral in market, overflow and storage; 1 per 5 credits; milestone tokens; 1 for an unused refresh tile.
  - **Points against:** the depth penalty, and every negative-point card still owned (deck, hand, discard and play area).
  - **Ties:** most credits wins, then most fuel.

## Interpretations and edge cases (engine behaviour)

**Damage and repair**
- **Taking damage** puts a DAMAGE card in your discard pile (or on top of your deck, or into your hand, as the card says). With the pile empty, you lose the top mineral of your most valuable non-empty market column instead (rulebook FAQ).
- **Card-granted repairs** (Laser Cutter, Pit Stop, Repair Bots, …) add to `turn.repairs`. They can be spent in Operations or Surfacing on any owned card in hand, play area, discard pile, or on top of the deck. Unused repairs expire at end of turn. A repaired DAMAGE card returns to the pile; any other repaired card leaves the game. Repairing a card from your hand draws a replacement. The paid 5-credit repair is separate and limited to once per surfacing.

**Buying**
- **Batteries:** buying an advanced card automatically exhausts your unexhausted battery tile with the smallest point loss (the first one on the track if tied). Exhausting a battery tile has no other effect, so this is never worse than choosing.
- **Drone buys** happen during Operations and can't use the shop refresh tile.

**Card choices made automatically or by default**
- **Solid fuel:** the engine takes an optional `solid` mineral parameter; the UI always burns the cheapest stored mineral.
- **Current-C Miner** moves the top mineral of the cheapest non-empty market column to overflow (optional `market` parameter). With an empty market, nothing happens.
- **Choice cards** (Torso, Footless Treads, Utility Bot, Transformer Drill) take an `option` index. Transformer Drill's "2× (1 drill / 2 moves)" is modelled as three options: 2⛏, 1⛏ + 2↕️, 4↕️.

**Card abilities and passives**
- **Harpoon Drill** (1x): spend 1 drill to collect from an adjacent open floor. That floor's collect trigger fires.
- **Superior Soaker** (1x): upgrade one stored mineral one step (silver → gold → sapphire → emerald → ruby).
- **Suction Engine:** collecting silver costs no drills for the rest of the turn. The card shows the silver icon, not the any-mineral icon; other minerals still cost 1 drill.
- **Flywheel:** on play, gain fuel equal to the cards already burned for fuel this turn; each later burn this turn gives +1 fuel.
- **Jackhammer:** after it's played, each corridor or barrier drilled this turn gives +1 fuel.
- **Requirements:** Wrecking Ball needs 3 moves gained this turn; Recoil Capacitor needs 3 drills gained. "Gained" counts cards, abilities, exhausted tiles and default functions.
- **Free fuel-cap upgrades** (Refuelling Drone, Ultrahot Furnace): the cap goes up before the card's fuel is added, since a card's effects can resolve in any order (rulebook p. 8).
- **Antigravity Drive:** move to any open floor, the surface included, for free.

**Floor cards**
- **Pileup** (end of Operations): optionally take a silver from the floor into storage.
- **Brewery** (end of Operations): +1 fuel.
- **The Ritz:** +2 credits after each corridor excavated there.
- **Lobby:**
  - On reveal, the revealer gains 2 credits.
  - When collecting there, you may pay 1 credit for 1 fuel.
  - At end of Operations there, you keep up to 3 cards for free this upkeep.
- **The Squeeze:**
  - Collecting there gives +2 credits.
  - At end of Operations, for each other mech on the floor, pay 1 fuel. You can choose damage instead, and you take damage anyway if you have no fuel.
- **Dispatch** (end of Operations): either +2 credits per face-up drone (the default), or pay 1 fuel to refresh a drone.
- **Hot Tub:** your first corridor there each turn costs 1 less drill and puts a DAMAGE into your hand.
- **Jackpot:**
  - On reveal, one emerald is reserved per player (`floors[f].jackpot[seat]`). Each player collects their own for 1 drill while on that floor.
  - At end of Operations there, you may upgrade one stored mineral.
- **Rad Bath:** your first corridor there each turn gives +5 fuel and 1 damage.
- **Cave With No Ceiling** (end of Operations): optionally spend 1 / 2 / 3 moves to take a sapphire / emerald / ruby from the supply into storage.
- **Chill Out Zone:**
  - Reveal: +2 fuel.
  - After each corridor there: +2 fuel.
  - End of Operations there: pay 1 fuel, or take damage (by choice, or if you have no fuel).
- **Toys R' Rust** (end of Operations): optionally pay 1 fuel and burn your cheapest mineral to repair one owned card.
- **Floor effects apply only to the player who triggers them** (Jackpot's reserved emeralds are the exception: one per player). All are mandatory unless marked optional ("you may").

## Uncertain or unverified

- **Solo mode** is not implemented. Its rules are on the rulebook's final pages.
