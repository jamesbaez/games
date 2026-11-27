// ALL game content for Starship Captains, transcribed from photos of the components
// in ref/photos-hires/ and from the rulebook in ref/rulebook/. No logic lives here.
//
// Crew figures are single characters so the queue is a plain, comparable array:
//   'r' 'y' 'b' ensigns, 'g' cadet, 'R' 'Y' 'B' commanders (uppercase = promotion ring),
//   'A' android. Mission lines also use 'gold', which only an android can match.
export const ENSIGNS = ['r', 'y', 'b'];
export const CADET = 'g';
export const ANDROID = 'A';
export const isCommander = (f) => f === 'R' || f === 'Y' || f === 'B';
export const figColor = (f) => (isCommander(f) ? f.toLowerCase() : f);

// A figure matches a room or mission line of this colour. Cadets match only gray;
// androids match every ensign colour and are the only match for gold.
export function matches(fig, color) {
  if (fig === ANDROID) return color !== 'gray'; // androids never activate rooms, checked separately
  if (color === 'gray') return fig !== ANDROID;
  if (color === 'gold') return fig === ANDROID;
  return figColor(fig) === color;
}

// Routes may be coloured or colourless. The colour exists only so a pirate ambush has a
// defined route to land on ("the route matching the pirate's exhaust colour"); a location
// does NOT have one route of each colour, and plenty of routes have no colour at all.
export const ROUTE_COLORS = ['red', 'green', 'yellow']; // pirate exhaust colours

// The four printed rooms, top to bottom as they appear on the ship board.
export const ROOMS = [
  { id: 'repair', name: 'Repair', color: 'gray', fx: ['repair'] },
  { id: 'science', name: 'Science', color: 'b', fx: ['tech'] },
  { id: 'weapons', name: 'Weapons', color: 'y', fx: ['fight'] },
  { id: 'helm', name: 'Helm', color: 'r', fx: ['move', 'move'] },
];

// The three faction tracks, by the arrow colours printed on the components.
// Each is double-sided and a side is chosen at random per game. Every side shares the
// same 13-space skeleton and zone scoring (see TRACK_LEN below); only the bonuses differ.
export const FACTIONS = [
  { id: 'coop', name: 'The Cooperative', color: 'magenta', sides: [
    { id: 'coopA', bonus: { 1: [['medal', 1]], 5: [['medal', 1]], 9: [['medal', 1]], 12: [['medal', 3]] } },
    { id: 'coopB', bonus: { 3: [['medal', 1]], 6: [['repair', 1]], 9: [['medal', 2]], 12: ['queue'] } },
  ] },
  { id: 'tincan', name: 'The Tincan', color: 'gold', sides: [
    { id: 'tincanA', bonus: { 3: [['medal', 1]], 5: [['artifact', 1]], 9: ['android'], 12: ['techR'] } },
    { id: 'tincanB', bonus: { 2: [['medal', 1]], 6: ['techR'], 9: [['repair', 1]], 12: [['artifact', 3]] } },
  ] },
  { id: 'nian', name: "The Ni'an", color: 'black', sides: [
    { id: 'nianA', bonus: { 2: [['repair', 1]], 5: [['medal', 1]], 9: [['repair', 1], ['artifact', 1]], 12: ['cadet'] } },
    { id: 'nianB', bonus: { 1: [['artifact', 1]], 6: [['medal', 1]], 9: ['cadet'], 12: [['repair', 3]] } },
  ] },
];

export const ROUNDS = 4;
export const QUEUE_KEEP = 3; // at end of round, the queue slides forward leaving the last 3
export const COMMANDER_LIMIT = 5; // promotion rings per player
export const TRAIN_COST = 1; // medals
export const PROMOTE_COST = 3;
export const EVENT_LIMIT = 2; // only the first 2 faction events in a game resolve
export const TECH_ROW = 5;    // alpha techs face up on the tech board
export const OMEGA_ROW = 3;   // omega techs face up beside them

// Handed out at the start of each round after the first, per player.
export const ROUND_TRACK = {
  2: { medals: 1, homeStation: true },
  3: { cadets: 1 },
  4: { cadets: 1 },
};

// Scoring is done in half-points so the ½ per medal and artifact stays integer.
export const PTS2 = {
  commander: 2, android: 2, pirate: 2, // 1 point each
  medal: 1, artifact: 1,               // ½ point each
  damage: -2,                          // -1 point each
};
export const TRACK_LOOP_PTS = 5;

// --- Effect tokens -------------------------------------------------------------------
// The rulebook is explicit that a line's effects resolve left to right, so fx is an
// ORDERED ARRAY, not an object. A token is one of:
//   'keyword' | ['keyword', n] | { either: [fx, fx] } | { pay: <token>, then: fx }
//
// Keywords (each is one branch in applyFx):
//   move        1 move along a route; optional, costs 1 damage if the route has a pirate
//   jump        move to any location, ignoring pirates
//   fight       fight a pirate on a route from here: take 1 damage, take the token + reward
//   tech        research: take a tech into an empty, undamaged slot
//   techR       research, may also recycle (discard) an occupied slot
//   repair n    remove n damage, excess damage first
//   damage n    take n damage (mandatory, never optional)
//   medal n     gain n medals
//   artifact n  draw n artifacts (see them all before choosing which to keep)
//   pirateTok n gain n pirate tokens from the supply
//   android     take an android into the ready room
//   cadet       take a NEW cadet from the supply into your ready room (grows the crew)
//   ambush      draw a pirate and place it on the matching route here (mandatory)
//   queue       move the first figure in the queue to the ready room
//   coop n / tincan n / nian n   advance n on that faction track
//   { pay: 'tech', then }  discard an installed tech from your tech board to get `then`
//   techNB      research a tech, but gain none of its edge bonuses
//   anyTrackNB  advance on any track, but resolve no bonus space it passes
//   ignoreMissionDamage   this line takes no effect itself: all damage on this
//               mission is ignored while it is resolved
//   anyTrack n       advance n on one track of your choice
//   anyTrack1x2      advance 1 on any track, then 1 again (same track or not)
// --------------------------------------------------------------------------------------

// --- Ship board ----------------------------------------------------------------------
// Read off ref/photos-hires/Starship/PXL_20261101_193438765.jpg.
export const SHIP = {
  cargoSlots: 7,        // hexes along the ship's wing
  cargoDamaged: 3,      // 3 of them are printed with damage at setup (rulebook p. 6)
  techSlots: 6,         // the separate tech-slot board
  techDamaged: [0, 1, 4, 5], // slots printed with damage: the outer two at each end
  medals: 1,            // "Don't forget your medal!"
  rings: COMMANDER_LIMIT,
  ready: ['r', 'y', 'b', 'g'], // one ensign of each colour plus a cadet
  queue: ['r', 'y', 'b'],      // order printed on the board, index 0 nearest the ready room
};

// --- Tech bonus icons ----------------------------------------------------------------
// There are exactly three bonus icons. A card or slot edge carries any subset of them,
// and "matching adjacent icons" (rulebook p. 11) means the two FACING edges carry the
// same icon - so what matters is which icons an edge has, not where they sit on it.
// (An earlier note here claimed each icon had a fixed row; checking the cards against
// close crops disproved it: Quadcorders prints move where Artifact Display prints medal.)
// Resolve matches in BONUS_ICONS order, one effect per match even though the icon shows
// on both sides. Only edges that face a neighbour can ever pay: the outer edges of the
// first and last slot match nothing.
export const BONUS_ICONS = ['rep', 'med', 'mov']; // in resolution order, top to bottom

// Glyphs that are easy to confuse when reading the components:
//   a HEXAGON  = an artifact (the tokens are hexes)
//   a circled MICROCHIP = a tech
//   a WRENCH   = repair, a CURVED ARROW = move, an ORANGE COG = a damage token
//   an upward ARROW in magenta / gold / black = advance on Cooperative / Tincan / Ni'an

// Tech-slot board, one side: 6 slots, each with a set of icons on its left and right edge.
// A tech card placed in a slot covers that slot's printed icons. Slots 1, 2, 5 and 6 start
// damaged. The rep/rep pair facing each other across the 3|4 boundary is already a match
// with nothing played, and is the pair the "1 point per matching pair" omega tech means by
// "printed in the middle of your board".
export const SLOT_BOARD = [
  { L: [], R: [], dmg: true },
  { L: ['mov'], R: [], dmg: true },
  { L: ['med'], R: ['rep'], dmg: false },
  { L: ['rep'], R: ['med'], dmg: false },
  { L: [], R: ['mov'], dmg: true },
  { L: [], R: [], dmg: true },
];

// --- The board, 1-3 player side ------------------------------------------------------
// 13 planets plus Home Station. Names are ours, after the artwork, since the board
// doesn't name them. Read off the physical board by the owner and checked for symmetry.
export const LOCS = [
  { id: 'home', name: 'Home Station', station: true },
  { id: 'green', name: 'Green' }, { id: 'frost', name: 'Frost' },
  { id: 'rust', name: 'Rust' }, { id: 'rings', name: 'Rings' },
  { id: 'moon', name: 'Moon' }, { id: 'ice', name: 'Ice' },
  { id: 'lava', name: 'Lava' }, { id: 'wreck', name: 'Wreck' },
  { id: 'earth', name: 'Earth' }, { id: 'sand', name: 'Sand' },
  { id: 'crater', name: 'Crater' }, { id: 'marble', name: 'Marble' },
  { id: 'rock', name: 'Rock' },
];

// Where each planet sits on img/board.webp, as a percentage of the picture's width and
// height, so the UI can put live markers (missions, tiles, stations, ships) on the photo.
// Read off the picture by hand against a 100px grid; good to about half a planet's width,
// which is all a marker needs. Routes are not mapped: they curve so much that a marker at
// the straight-line midpoint would often sit on top of a different route's planet.
export const MAP = {
  green: [15.2, 15.7], frost: [40.8, 18.6], rust: [65.5, 10.0], rings: [84.5, 27.2],
  ice: [24.8, 31.5], moon: [60.5, 30.5], home: [42.0, 43.4], rock: [84.0, 46.8],
  lava: [11.5, 50.6], marble: [58.5, 52.0], wreck: [31.0, 66.8], crater: [77.0, 70.1],
  earth: [8.5, 81.1], sand: [56.0, 81.6],
};

// 25 routes. A route is either colourless or carries one colour for its whole length,
// marked by a coloured dot where it leaves each planet (red is printed pink on the board).
// Every planet has exactly one red, one green and one yellow route; planets with four or
// five routes have the rest colourless. So the coloured routes form a proper 3-edge
// -colouring of a graph in which every planet has degree 3, and `routeColours` below
// checks exactly that - it is what caught this data being wrong in the first place.
//
// Colour matters only for a pirate ambush, which puts the drawn pirate on the route at
// your location matching its exhaust colour; a colourless route never receives one.
const r = (a, b, c = null) => ({ a, b, c });
export const ROUTES = [
  r('green', 'frost', 'green'),
  r('green', 'ice', 'yellow'),
  r('green', 'lava'),
  r('green', 'rust', 'red'),
  r('frost', 'moon', 'red'), r('frost', 'rust', 'yellow'),
  r('rust', 'rings', 'green'),
  r('rings', 'moon', 'yellow'), r('rings', 'rock', 'red'),
  r('moon', 'home', 'green'),
  r('ice', 'home', 'red'), r('ice', 'lava', 'green'),
  r('home', 'lava'), r('home', 'wreck'), r('home', 'marble', 'yellow'),
  r('lava', 'wreck', 'yellow'), r('lava', 'earth', 'red'),
  r('wreck', 'earth', 'green'), r('wreck', 'sand', 'red'), r('wreck', 'crater'),
  r('earth', 'sand', 'yellow'),
  r('sand', 'crater', 'green'),
  r('crater', 'marble', 'red'), r('crater', 'rock', 'yellow'),
  r('marble', 'rock', 'green'),
];

// The routes printed with a skull: each starts the game with a pirate on it.
export const SETUP_PIRATES = [
  ['home', 'wreck'], ['home', 'moon'], ['earth', 'lava'], ['green', 'rust'], ['rock', 'crater'],
];
// Index of the route joining two locations, or -1.
export const routeBetween = (a, b) =>
  ROUTES.findIndex((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));

// --- Triangle tiles ------------------------------------------------------------------
// In a 1-3 player game 8 tiles are in play: numbered 1-5 and 3 station ("bonus") tiles.
// Setup: the purple station tile is Home Station's, and it starts on the round-counting
// track because every ship starts at Home and a station tile is only put out when no ship
// is on its planet. The other 7 tiles go on 7 random planets, numbers orange side up.
// The remaining 6 planets each get a face-up mission card.
//
// Completing a mission: take the mission card, then move the HIGHEST face-up numbered
// tile onto that planet, face down. The planet it came from is now empty, so deal a new
// mission there. When tile 1 is turned face down, the pirate uprising fires and every
// numbered tile is turned face up again, wherever it now sits.
export const NUMBERED_TILES = 5;
export const STATION_TILES = [
  { id: 'gold', name: 'Gold Station', fx: ['android'] },
  { id: 'blue', name: 'Blue Station', fx: [['artifact', 1], ['repair', 1]] },
  // The purple tile is Home Station's: 1 step on each of the three faction tracks.
  { id: 'home', name: 'Home Station', home: true, fx: [['tincan', 1], ['nian', 1], ['coop', 1]] },
];
// Of the 13 planets, 7 start with a tile and 6 start with a mission.
export const SETUP_TILED_PLANETS = 7;

// --- Artifacts -----------------------------------------------------------------------
// 3 distinct types, each showing two of the three ensign colours. Two artifacts activate
// a room of a colour they share; any two activate the gray room (rulebook p. 7).
export const ARTIFACTS = [
  { id: 'rb', c: ['r', 'b'] },
  { id: 'ry', c: ['r', 'y'] },
  { id: 'by', c: ['b', 'y'] },
];
// The colours a pair of artifacts can pay for: shared colours, plus gray for any pair.
export const artifactPair = (a, b) =>
  ['gray', ...ARTIFACTS.find((x) => x.id === a).c.filter((c) => ARTIFACTS.find((x) => x.id === b).c.includes(c))];

// --- Pirates -------------------------------------------------------------------------
// 30 tokens. Exhaust colour decides where an ambushed pirate lands: the route at your
// location of that colour, or nothing if that route already has one (no route ever holds
// two). Reward is taken when you defeat the token, after taking 1 damage.
//   'medalArt' = 1 medal + 1 random artifact      'android' = 1 android to the ready room
// The rulebook's uprising example shows a purple exhaust, but this board only uses the
// three route colours; purple presumably belongs to the 4-player side.
// ASSUMPTION: an even 15/15 split of the two rewards; not yet counted from the components.
export const PIRATE_REWARDS = ['medalArt', 'android'];
export const PIRATES = ROUTE_COLORS.flatMap((c) =>
  PIRATE_REWARDS.map((reward) => ({ c, reward, n: 5 })), // 3 colours x 2 rewards x 5 = 30
);

// --- Omega techs ---------------------------------------------------------------------
// 12 cards, all end-game scoring. They sit in tech slots like any tech, so they carry
// edge icons too (L/R, see BONUS_ICONS). score.pts2 is in half-points, as everywhere.
//   per: 'flat'          a fixed score
//        'artifactType'  each DIFFERENT artifact you hold (3 types exist, so max 6 pts)
//        'missionColor'  each completed mission with at least 1 line of colour c
//                        (a mission with two lines of that colour still counts once)
//        'iconPair'      each matching pair of tech bonus icons across your tech slots,
//                        including the rep/rep pair printed on the board if uncovered
//        'pirate'        each pirate token on your ship
//        'figColor'      each figure of colour c, ensigns and commanders alike
//        'commander'     each commander (max 5)
//        'damage'        each damage token (cancels out its own -1 penalty)
const o = (id, name, score, L = [], R = []) => ({ id, name, kind: 'omega', score, L, R });
export const OMEGA = [
  o('artifact_blueprints', 'Artifact Blueprints', { per: 'artifactType', pts2: 4 }, ['rep'], ['rep', 'med']),
  o('science_logs', 'Science Logs', { per: 'missionColor', c: 'b', pts2: 2 }),
  o('starship_schematics', 'Starship Schematics', { per: 'iconPair', pts2: 2 }, ['rep']),
  o('wanted_list', 'Wanted List', { per: 'pirate', pts2: 2 }, ['mov'], ['rep']),
  o('weapons_index', 'Weapons Index', { per: 'figColor', c: 'y', pts2: 2 }, [], ['med']),
  o('cookbook', 'Cookbook', { per: 'flat', pts2: 4 }, ['rep', 'mov'], ['med']), // a flat 2; it pays off through its three edge icons
  o('tactical_logs', 'Tactical Logs', { per: 'missionColor', c: 'y', pts2: 2 }),
  o('diplomacy_logs', 'Diplomacy Logs', { per: 'missionColor', c: 'r', pts2: 2 }),
  o('galactic_map', 'Galactic Map', { per: 'figColor', c: 'r', pts2: 2 }, ['med']),
  o('crew_evaluator', 'Crew Evaluator', { per: 'commander', pts2: 2 }, ['med'], ['med']),
  o('crash_reports', 'Crash Reports', { per: 'damage', pts2: 2 }, ['med'], ['mov']),
  o('astropedia', 'Astropedia', { per: 'figColor', c: 'b', pts2: 2 }, [], ['med']),
];

// --- Faction tracks ------------------------------------------------------------------
// All three tracks share this layout. 13 positions, 0-12: 0 is the start, and a 13th step
// from 12 lands back on 0, which flips the marker and scores +5. Twice around is +10.
// Zone points are scored for where the marker ENDS the game; bonuses resolve whenever you
// advance onto OR THROUGH that space (rulebook p. 16), not only when you land on it.
export const TRACK_LEN = 13;
// Points for ending the game on each position, index 0-12.
export const TRACK_ZONE_PTS = [0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
// The event space is position 7 on every track and every side, so it isn't in the
// per-side bonus tables; the engine resolves it there. That makes the race to trigger an
// event the same distance whichever sides are dealt.
export const EVENT_SPACE = 7;


// --- Techs ---------------------------------------------------------------------------
// The 50 alpha+beta techs, read off ref/photos-hires/Starship/PXL_20261101_195122475.jpg
// (32 alpha) and PXL_20261101_195259175.jpg (18 beta, photographed upside down).
// They shuffle into one deck; the rulebook deals from the alpha-beta deck even when an
// omega tech is taken. Several beta cards are printed twice, so `n` is the copy count.
//
// Three kinds, per the rulebook's "TYPES OF TECHS" (p. 11):
//   room:    { room: <ROOMS colour>, fx } - a new room, activated by a matching figure
//   ability: { when: <string>, fx? }      - a passive, worded on the card
//   plain:   edge icons only
// L and R are the bonus icons printed down the card's left and right edges, in printed
// order (top to bottom), from BONUS_ICONS. A tech bonus fires when a card's edge icon
// matches the icon on the facing edge of the neighbouring slot or tech.
const t = (id, name, L, R, extra = {}) => ({ id, name, L, R, n: 1, ...extra });

export const TECHS = [
  // -- alpha: crew-cost abilities ----------------------------------------------------
  t('quadcorders', 'Quadcorders', ['mov'], ['rep'], { when: 'trainFree', c: 'b', text: "Training to a blue ensign doesn't require a medal." }),
  t('blast_phasers', 'Blast-Phasers', ['med'], ['mov'], { when: 'trainFree', c: 'y', text: "Training to a yellow ensign doesn't require a medal." }),
  t('hyper_pads', 'Hyper-Pads', ['rep'], ['med'], { when: 'trainFree', c: 'r', text: "Training to a red ensign doesn't require a medal." }),
  t('security_suit', 'Security Suit', ['mov'], ['med'], { when: 'promoteCheap', c: 'y', less: 1, text: 'Promoting to a yellow commander requires 1 less medal.' }),
  t('engineering_suit', 'Engineering Suit', ['rep'], ['mov'], { when: 'promoteCheap', c: 'b', less: 1, text: 'Promoting to a blue commander requires 1 less medal.' }),
  t('navigator_suit', 'Navigator Suit', ['med'], ['rep'], { when: 'promoteCheap', c: 'r', less: 1, text: 'Promoting to a red commander requires 1 less medal.' }),
  // -- alpha: stored tokens ----------------------------------------------------------
  t('artifact_display', 'Artifact Display', ['rep', 'med'], ['rep'], { when: 'spendAs', tok: 'art', text: 'A stored artifact can be spent as a medal.' }),
  t('trophy_display', 'Trophy Display', ['rep'], ['mov'], { when: 'spendAs', tok: 'pir', text: 'A stored pirate token can be spent as a medal.' }),
  // -- alpha: icon conversions -------------------------------------------------------
  t('repair_bots', 'Repair Bots', ['rep'], ['rep', 'mov'], { when: 'convert', from: 'mov', to: 'rep', text: 'Any move tech bonus is now a repair.' }),
  t('wormhole_generator', 'Wormhole Generator', ['med', 'mov'], ['mov'], { when: 'convert', from: 'mov', to: 'jump', text: 'Any move tech bonus is now a jump.' }),
  t('universal_translator', 'Universal Translator', ['med'], ['rep'], { when: 'anyTrackIsAny', text: 'An advance on a named faction track may be made on any track instead.' }),
  t('hyper_charger', 'Hyper-Charger', ['mov'], ['rep', 'mov'], { when: 'moveOrJumpAsRepair', text: 'Each move or jump can be a repair instead.' }),
  t('auxiliary_engine', 'Auxiliary Engine', ['mov'], ['rep', 'med'], { when: 'extraMovePerTurn', text: 'Once per turn, when moving: one extra move.' }),
  t('auxiliary_engine_m', 'Auxiliary Engine', ['rep', 'med'], ['mov'], { when: 'extraMovePerTurn', text: 'Once per turn, when moving: one extra move.' }),
  t('stealth_paint', 'Stealth Paint', ['mov'], ['med', 'mov'], { when: 'stealth', text: 'Ignore your first damage on each mission. Ignore pirates when you move.' }),
  t('training_holovisor', 'Training Holovisor', ['med'], ['rep', 'med'], { when: 'medalBonusTrains', text: 'When you get a medal tech bonus, you may also train a cadet or ensign for free.' }),
  // -- alpha: faction observers ------------------------------------------------------
  t('fleet_observer', 'Fleet Observer', [], ['mov'], { when: 'afterMission', c: 'r', fx: [['coop', 1]], text: 'After completing a Cooperative mission: advance 1 on the Cooperative track.' }),
  t('tincan_observer', 'Tincan Observer', ['rep'], ['rep'], { when: 'afterMission', c: 'b', fx: [['tincan', 1]], text: 'After completing a Tincan mission: advance 1 on the Tincan track.' }),
  t('nian_observer', 'Ni\'an Observer', ['mov'], [], { when: 'afterMission', c: 'y', fx: [['nian', 1]], text: "After completing a Ni'an mission: advance 1 on the Ni'an track." }),
  t('fleet_comms', 'Fleet Comms', ['rep'], ['med'], { when: 'afterPromote', fx: [['coop', 1]], text: 'After promoting a commander: advance 1 on the Cooperative track.' }),
  t('nian_comms', 'Ni\'an Comms', ['rep', 'mov'], ['rep'], { when: 'afterMissionWith', fx: [['nian', 1]], text: "After completing a mission that involved damage, a move or a jump: advance 1 on the Ni'an track." }),
  t('tincan_comms', 'Tincan Comms', ['rep'], ['rep'], { when: 'afterFightAndroid', fx: [['tincan', 1]], text: 'After a fight in which you gained an android: advance 1 on the Tincan track.' }),
  // -- alpha: room techs -------------------------------------------------------------
  t('repair_bay', 'Repair Bay', ['med', 'mov'], ['rep', 'mov'], { room: 'b', fx: [['repair', 3]] }),
  t('regen_drive', 'Regen Drive', ['med', 'mov'], ['rep'], { room: 'b', fx: [['repair', 1], 'move'] }),
  t('jump_drive', 'Jump Drive', ['rep', 'med'], ['med'], { room: 'y', fx: ['jump'] }),
  t('turbo_lasers', 'Turbo-Lasers', ['med'], [], { room: 'y', fx: ['fightSafe'] }),
  t('replicator', 'Replicator', ['med'], ['med'], { room: 'y', fx: [['repair', 1], ['artifact', 1], ['pirateTok', 1]] }),
  t('captains_chair', "Captain's Chair", ['rep'], ['med', 'mov'], { room: 'r', fx: [['anyTrack', 1], ['anyTrack', 1]] }),
  t('auction_terminal', 'Auction Terminal', ['rep'], ['rep'], { room: 'r', fx: [{ pay: 'pirateTok', then: [['anyTrack', 2], ['artifact', 1]] }] }),
  t('trash_compactor', 'Trash Compactor', ['med', 'mov'], ['med', 'mov'], { room: 'y', fx: [{ pay: 'pirateTok', then: ['move', 'move', ['tincan', 1]] }] }),
  t('matter_converter', 'Matter Converter', ['rep', 'med'], ['rep', 'med'], { room: 'y', fx: [{ pay: 'pirateTok', then: [['artifact', 1], 'move', 'move'] }] }),
  t('tincan_assembly_line', 'Tincan Assembly Line', ['rep', 'mov'], ['med'], { room: 'r', fx: [{ pay: 'artifact', then: ['cadet', ['repair', 1]] }] }),
  // -- beta --------------------------------------------------------------------------
  t('quantum_torpedoes', 'Quantum Torpedoes', [], ['rep', 'mov'], { discard: [['fight', 2], 'ignoreDamage1'] }),
  t('quantum_torpedoes_m', 'Quantum Torpedoes', ['rep', 'mov'], [], { discard: [['fight', 2], 'ignoreDamage1'] }),
  t('oil_bath', 'Oil Bath', ['rep'], [], { when: 'androidReturns', text: 'When an android leaves you, you may discard this card to keep it.' }),
  t('dimensional_lockers', 'Dimensional Lockers', ['rep', 'mov'], ['rep', 'med'], { when: 'extraStorage', slots: 2, text: 'Can store 2 more artifacts or pirate tokens.' }),
  t('dimensional_lockers_m', 'Dimensional Lockers', ['rep', 'med'], ['rep', 'mov'], { when: 'extraStorage', slots: 2, text: 'Can store 2 more artifacts or pirate tokens.' }),
  t('hull_plating', 'Hull Plating', ['rep'], ['med', 'mov'], { when: 'payPirateOrDiscardToIgnoreDamage', text: 'You can discard a pirate token, or discard this card, to ignore 1 damage.' }),
  t('omega_megacomputer', 'Omega Megacomputer', ['rep'], ['med'], { discard: ['drawOmega3'] }),
  t('omega_megacomputer_m', 'Omega Megacomputer', ['med'], ['rep'], { discard: ['drawOmega3'] }),
  t('ram_drive', 'Ram Drive', [], ['rep'], { room: 'r', cost: ['damage', 1], discard: ['fight', 'move'] }),
  t('engineering_lab', 'Engineering Lab', ['mov'], ['rep'], { room: 'b', fx: ['techR'] }),
  t('experimental_lab', 'Experimental Lab', ['med'], ['mov'], { room: 'b', fx: [{ pay: 'artifact', then: ['techR', ['anyTrack', 1]] }] }),
  t('holodeck', 'Holodeck', ['rep'], ['rep'], { room: 'r', when: 'copyBoardRoom', text: 'Copy the effect of any room on the central tech board.' }),
  t('time_turner', 'Time Turner', ['mov'], ['rep'], { discard: ['queue'] }),
  t('time_turner_m', 'Time Turner', ['rep'], ['mov'], { discard: ['queue'] }),
  // -- beta adapters: edge icons only, and may replace an existing tech ---------------
  t('plasma_adapter', 'Plasma Adapter', ['rep', 'mov'], ['med', 'mov'], { when: 'replacesTech', text: 'This can replace an existing tech.' }),
  t('supply_adapter', 'Supply Adapter', ['rep', 'med'], ['rep', 'mov'], { when: 'replacesTech', text: 'This can replace an existing tech.' }),
  t('universal_adapter', 'Universal Adapter', ['rep', 'med', 'mov'], ['rep', 'med', 'mov'], { when: 'replacesTech', text: 'This can replace an existing tech.' }),
  t('data_adapter', 'Data Adapter', ['med', 'mov'], ['rep', 'med'], { when: 'replacesTech', text: 'This can replace an existing tech.' }),
];

// Alpha and beta shuffle into one deck, but setup deals only alpha cards face up (beta
// cards it runs into go to the bottom unseen), so each card has to know which it is.
// Counts: 32 alpha, 18 beta.
//
// Five abilities are printed on two cards each whose EDGE ICONS are mirror images of
// each other: Auxiliary Engine, Quantum Torpedoes, Dimensional Lockers, Omega
// Megacomputer and Time Turner. Each pair is two entries, not one entry with n: 2,
// because the edges are what the tech-slot bonuses read. The mirrored one ends in _m.
const BETA_TECHS = new Set(['quantum_torpedoes', 'quantum_torpedoes_m', 'oil_bath',
  'dimensional_lockers', 'dimensional_lockers_m', 'omega_megacomputer_m', 'time_turner_m',
  'hull_plating', 'omega_megacomputer', 'ram_drive', 'engineering_lab', 'experimental_lab',
  'holodeck', 'time_turner', 'plasma_adapter', 'supply_adapter', 'universal_adapter',
  'data_adapter']);
for (const x of TECHS) x.tier = BETA_TECHS.has(x.id) ? 'b' : 'a';

// --- Missions ------------------------------------------------------------------------
// The 50 mission cards, read off ref/photos-hires/Starship/PXL_20261101_194235791.jpg
// (36) and PXL_20261101_194354452.MP.jpg (14). Each is unique.
//
// A mission is a stack of lines. Each line shows a crew colour down the left edge and the
// effects you get for assigning a matching figure to it; you may leave a line unmanned.
// `pts` is the victory points in the circle at the bottom right.
// A line's colour uses the crew letters: 'r' 'y' 'b'. `note` lines carry a worded rider
// that applies to the whole mission rather than to one assignment.
//
// The mission's own colour (which the three Observer techs test) is the colour of its
// FIRST line: red -> Cooperative, blue -> Tincan, yellow -> Ni'an.
// A line's colour is the crew it needs. Four lines are GOLD, which only an android can
// match (rulebook p. 15) - all four hand out something the Tincan would care about.
const L = (c, ...fx) => ({ c, fx });
const ms = (id, name, pts, lines, note) => (note ? { id, name, pts, lines, note } : { id, name, pts, lines });

export const MISSIONS = [
  ms('repair_station', 'Repair the Repair Station', 4, [L('r', ['coop', 1]), L('b', ['repair', 3])]),
  ms('anti_time', 'Anti-Time Anomaly', 3, [L('r', ['tincan', 2]), L('b', { pay: 'artifact', then: ['queue'] })]),
  ms('arena_battle', 'Arena Battle', 7, [L('b', 'ignoreMissionDamage'), L('y', ['damage', 1], ['nian', 3]), L('r', ['damage', 1], ['medal', 1], ['anyTrack', 1])]),
  ms('routine_inspection', 'Routine Inspection', 3, [L('b', ['repair', 1]), L('r', ['medal', 1], ['coop', 2])]),
  ms('omnipotent_being', 'Omnipotent Being', 4, [L('y', ['damage', 1], ['anyTrack', 2]), L('r', 'jump')]),
  ms('distress_call', 'Distress Call', 4, [L('y', ['damage', 1], 'android'), L('b', ['tincan', 2])]),
  ms('shooting_contest', 'Shooting Contest', 2, [L('y', ['medal', 1], ['nian', 1])]),
  ms('mooncake', 'Mooncake Diplomacy', 2, [L('b', ['medal', 1]), L('y', ['coop', 1], ['tincan', 1], ['nian', 1], ['anyTrack', 1])]),
  ms('metal_bugs', 'Metal-Eating Bugs', 6, [L('b', ['damage', 1], ['tincan', 3]), L('y', { pay: 'tech', then: [['repair', 1]] })]),
  ms('experimental_research', 'Experimental Research', 3, [L('b', 'techNB')]),
  ms('sentient_slime', 'Sentient Slime', 6, [L('y', ['damage', 2], ['anyTrack', 4]), L('b', ['artifact', 1])]),
  ms('scrap_yard', 'Scrap Yard', 3, [L('r', ['repair', 2]), L('b', { pay: 'pirateTok', then: [['repair', 1], ['nian', 2]] })]),
  ms('galactic_race', 'Galactic Race', 5, [L('r', 'move', 'move'), L('r', ['medal', 1])]),
  ms('shady_deal', 'Shady Deal', 5, [L('b', { pay: 'medal', then: [['anyTrack', 3]] }), L('y', ['artifact', 2])]),
  ms('emotion_chips', 'Trade Emotion Chips', 4, [L('y', ['tincan', 2]), L('r', { either: [[['tincan', 2]], [{ pay: 'medal', then: ['android'] }]] })]),
  ms('barbecue', 'Intergalactic Barbecue', 2, [L('r', ['coop', 1], ['tincan', 1], ['nian', 1]), L('y', ['anyTrackNB', 1], ['anyTrackNB', 1], ['anyTrackNB', 1])]),
  ms('younglings', 'Saving Younglings', 6, [L('r', ['anyTrack', 1]), L('y', ['medal', 1])]),
  ms('assembly_required', 'Assembly Required', 4, [L('b', ['tincan', 3]), L('b', { pay: 'artifact', then: ['android'] })]),
  ms('artifact_guardians', 'Artifact Guardians', 7, [L('y', ['damage', 1], ['anyTrack', 1], ['artifact', 1]), L('y', ['damage', 1], ['anyTrack', 1], ['artifact', 1])]),
  ms('secret_plans', 'Steal Secret Plans', 2, [L('y', ['nian', 1], ['medal', 1]), L('gold', 'drawOmega3')]),
  ms('ancient_puzzle', 'Ancient Puzzle', 4, [L('y', ['tincan', 3]), L('b', { either: [[['artifact', 1]], [{ pay: 'artifact', then: [['anyTrack', 2]] }]] })]),
  ms('peace_talks', 'Peace Talks', 3, [L('r', ['nian', 3]), L('r', ['tincan', 3])]),
  ms('escort_ambassador', 'Escort the Ambassador', 3, [L('y', ['damage', 1], ['anyTrack', 3])]),
  ms('tincan_library', 'Tincan Library', 3, [L('b', ['tincan', 3]), L('gold', 'drawTech3')]),
  ms('special_delivery', 'Special Delivery', 2, [L('r', 'move', 'ambush', ['anyTrack', 1])]),
  ms('roddenberries', 'Roddenberries', 3, [L('b', ['damage', 1], 'queue'), L('y', ['coop', 2])]),
  ms('alien_bazaar', 'Alien Bazaar', 4, [L('b', ['coop', 1], ['tincan', 1], ['nian', 1]), L('r', ['artifact', 1])]),
  ms('plasmabeard', "Plasmabeard's Treasure", 3, [L('b', ['artifact', 3], 'ambush'), L('r', { either: [['fight'], [{ pay: 'artifact', then: [['nian', 3]] }]] })]),
  ms('prototype_shuttle', 'Prototype Shuttlecraft', 4, [L('b', { pay: 'pirateTok', then: [['coop', 3]] }), L('r', 'move')]),
  ms('save_a_planet', 'Save a Planet', 7, [L('b', 'android'), L('r', ['tincan', 1]), L('y', ['medal', 1])]),
  ms('lost_world', 'Lost World', 4, [L('y', ['anyTrack', 1], ['anyTrack', 1]), L('b', ['artifact', 2])]),
  ms('oil_crumpets', 'Oil and Crumpets', 3, [L('r', ['tincan', 1], ['artifact', 1])]),
  ms('honest_deal', 'Honest Deal', 4, [L('r', ['coop', 3]), L('b', ['artifact', 1])]),
  ms('ancient_beast', 'Find the Ancient Beast', 5, [L('y', ['medal', 1]), L('y', ['damage', 1], ['nian', 4])]),
  ms('nullspace_catapult', 'Nullspace Catapult', 3, [L('r', ['coop', 2]), L('b', 'jump', 'ambush')]),
  ms('underwater_ruin', 'Underwater Ruin', 5, [L('y', ['damage', 1], ['artifact', 2]), L('b', ['nian', 3])]),
  ms('pirate_flagship', 'Pirate Flagship', 7, [L('r', ['medal', 1], 'ambush'), L('b', ['damage', 1], 'fight'), L('y', ['coop', 3])]),
  ms('gateway_stars', 'Gateway to the Stars', 4, [L('r', ['coop', 2]), L('gold', 'peekMissions3', 'move')]),
  ms('cutlass_caylus', 'The Cutlass of Caylus', 4, [L('r', ['medal', 1], ['artifact', 1]), L('y', ['nian', 2])]),
  ms('trade_negotiations', 'Trade Negotiations', 4, [L('y', { either: [[['nian', 2]], [{ pay: 'pirateTok', then: [['nian', 3]] }]] }), L('r', { either: [[['coop', 2]], [{ pay: 'artifact', then: [['coop', 3]] }]] })]),
  ms('the_duel', 'The Duel', 4, [L('y', 'ambush', ['nian', 3]), L('r', ['medal', 1])]),
  ms('diplomatic_conference', 'Diplomatic Conference', 4, [L('r', ['anyTrack', 2]), L('y', ['anyTrack', 2])]),
  ms('shipwreck_salvage', 'Shipwreck Salvage', 4, [L('b', { either: [[['pirateTok', 1], ['artifact', 1]], [['repair', 2]]] }), L('y', { pay: 'pirateTok', then: [['nian', 3]] })]),
  ms('dormant_lab', 'Awaken the Dormant Lab', 4, [L('b', ['damage', 1], ['tincan', 4]), L('b', 'techNB')]),
  ms('pet_admiral', 'Pet for the Admiral', 6, [L('b', ['damage', 1], ['medal', 1]), L('r', ['medal', 1])]),
  ms('bounty_hunting', 'Bounty Hunting', 3, [L('y', ['coop', 2], 'ambush'), L('r', { either: [[['nian', 3]], ['fight']] })]),
  ms('hive_mind', 'Restore the Hive Mind', 7, [L('b', ['repair', 2]), L('y', ['artifact', 1]), L('gold', 'trackPerAndroid')]),
  ms('infiltrate_pirate_base', 'Infiltrate Pirate Base', 4, [L('r', ['coop', 3]), L('y', ['medal', 1], 'ambush', 'ambush', 'ambush')]),
  ms('first_contact', 'First Contact', 6, [L('y', ['coop', 3]), L('r', ['artifact', 1]), L('b', 'techNB')]),
  ms('urgent_repair', 'Urgent Repair', 3, [L('b', ['repair', 1], ['coop', 1])]),
];

// Does a mission carry a line of this colour? The Observer techs and the Logs omega cards
// both test it, and the rulebook appendix is explicit: "These cards care only about
// whether the completed mission has at least 1 line of the depicted color. They don't care
// if you used that line or not, and a mission with 2 red lines is the same as a mission
// with 1." So this is NOT the first line's colour, which is what it used to read.
export const missionHasColor = (m, c) => m.lines.some((l) => l.c === c);

// --- Faction events ------------------------------------------------------------------
// 11 event cards: 5 Cooperative, 5 Ni'an, and 1 Tincan. At setup the Cooperative and
// Ni'an tracks each get one card at random; the Tincan track always uses its single
// event AND a random alpha tech (rulebook p. 15). Only the first EVENT_LIMIT events to
// be triggered in a game resolve; a third is removed with no effect.
//
// Events are global and worded, so each is a named `special` with one branch in the
// engine rather than an fx array. `text` is shown to the player.
export const EVENTS = [
  // -- Cooperative -------------------------------------------------------------------
  { id: 'overtime_incentives', f: 'coop', name: 'Overtime Incentives', special: 'overtime',
    text: 'Each player calls the front of their queue to their ready room. Players who have passed gain a cadet instead.' },
  { id: 'routine_maintenance', f: 'coop', name: 'Routine Maintenance', special: 'routineMaintenance',
    text: 'Everyone who has the least damage gains 1 medal. Everyone else repairs 1 cargo slot.' },
  { id: 'outreach_program', f: 'coop', name: 'Outreach Program', special: 'outreach',
    text: 'Advance all markers on all faction tracks 1 space, except for those that would trigger an event or end on a space with a bonus.' },
  { id: 'crowdsourcing', f: 'coop', name: 'Crowdsourcing', special: 'crowdsourcing',
    text: 'Each player places a face-down artifact on each of their room techs. After activating such a room, you may gain its artifact.' },
  { id: 'diplomatic_order', f: 'coop', name: 'Diplomatic Order #12', special: 'stationBounty', give: 'medal',
    text: 'Place 1 medal on each space station. The first player who ends their turn there takes the medal.' },
  // -- Ni'an -------------------------------------------------------------------------
  { id: 'repossession_treaty', f: 'nian', name: 'Repossession Treaty', special: 'repossession',
    text: 'Everyone with no pirate token takes 1 damage. Then everyone with the most pirate tokens discards 1 of them.' },
  { id: 'sabotaged_negotiations', f: 'nian', name: 'Sabotaged Negotiations', special: 'sabotage',
    text: "Each player places 1 damage on the basic room matching the first crew member in their queue. The room can't be used until repaired." },
  { id: 'explosive_crisis', f: 'nian', name: 'Explosive Crisis', special: 'stationBounty', give: 'damageAndTrack',
    text: 'Place 1 damage on each space station. The first player to end their turn there takes the damage and advances 1 on a track.' },
  { id: 'honesty_summit', f: 'nian', name: 'Honesty Summit', special: 'honestySummit',
    text: 'Move all markers on all faction tracks back 1 space, except for those on a space with a bonus or on a starting space.' },
  { id: 'nian_expansion', f: 'nian', name: "Ni'an Expansion Treaty", special: 'nianExpansion',
    text: 'Around the planet with the highest face-up triangle tile, each route with no pirate gets one.' },
  // -- Tincan ------------------------------------------------------------------------
  // The Tincan card is a reminder, not an effect of its own: at setup a random alpha tech
  // is dealt face up onto the track (`tracks[tincan].tech`). Triggering the event makes
  // that tech shared - from then on EVERY player may use it as though it were installed
  // on their own tech board. It is never installed in a slot, so it has no edge bonuses.
  { id: 'tincan_tech', f: 'tincan', name: 'Tincan Technology', special: 'tincanTech',
    text: 'The tech on the Tincan track becomes available to every player, as if it were on their own tech board.' },
];

export const eventsFor = (faction) => EVENTS.filter((e) => e.f === faction);

// --- Lookups -------------------------------------------------------------------------
// Decks are arrays of def ids (every card in this game is unique by id), so a card is
// found by id rather than through an instance table the way Drillers needs.
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const TECH_BY_ID = byId(TECHS);
const OMEGA_BY_ID = byId(OMEGA);
const MISSION_BY_ID = byId(MISSIONS);
const EVENT_BY_ID = byId(EVENTS);
export const techDef = (id) => TECH_BY_ID[id] ?? OMEGA_BY_ID[id];
export const missionDef = (id) => MISSION_BY_ID[id];
export const eventDef = (id) => EVENT_BY_ID[id];
