// All game content lives here, transcribed from photos of the components
// (ref/photos-hires). Values marked "TODO verify" are still uncertain.

export const MINERALS = ['silver', 'gold', 'sapphire', 'emerald', 'ruby'];
export const MINERAL_POINTS = { silver: 2, gold: 3, sapphire: 4, emerald: 5, ruby: 6 };
// Credits for the 1st, 2nd, 3rd sale of each mineral (market fills bottom-up).
export const MARKET_PRICES = {
  silver: [4, 3, 2], gold: [5, 4, 3], sapphire: [6, 6, 5], emerald: [8, 8, 7], ruby: [10, 10, 9],
};
export const OVERFLOW_PRICE = { silver: 0, gold: 0, sapphire: 4, emerald: 6, ruby: 8 };
export const OVERFLOW_SLOTS = 10;

// Fuel cap starts over spaces 11–12 (max 10); each upgrade slides it one space right (max 18).
export const FUEL = { start: 10, startMax: 10, upgradeCosts: [2, 2, 3, 3, 3, 4, 4, 4] };
export const STORAGE = { start: 2, max: 7, upgradeCost: 3 };
export const DEFAULTS = { moveFuel: 3, drillFuel: 4, damageFuel: 3 };
export const REPAIR_COST = 5;
export const DISCARD_CREDITS = 2;
export const HAND_SIZE = 3;
export const DAMAGE_CARDS = 14;
// Starting resources by player count, indexed by turn order (rulebook setup step 16).
export const STARTING_CREDITS = { 1: [2], 2: [2, 4], 3: [2, 3, 5], 4: [2, 5, 4, 7] };
export const STARTING_CARDS = { 1: [3], 2: [3, 4], 3: [3, 4, 4], 4: [3, 3, 4, 4] };

// Progress track, in notches (one notch = one overflow slot). Milestone lines sit
// at roughly 4.5 / 9.4 / 14.2 notches, so covering them takes 5 / 10 / 15.
export const TRACK_LENGTH = 25;
export const MILESTONES = [
  { at: 5, pts: 4, credits: 3 },
  { at: 10, pts: 5, credits: 4 },
  { at: 15, pts: 6, credits: 5 },
];
export const FINAL_MILESTONE = { pts: 18, draw: 1 };
export const REFRESH_TILE_POINTS = 1;

// Floor 0 = surface, 1 = mine entrance, 2–6 underground.
export const FLOORS = [
  { name: 'Surface', penalty: 0, minerals: [] },
  { name: 'Entrance', penalty: 0, minerals: [] },
  { name: 'Floor 2', penalty: 3, minerals: ['silver', 'silver'], corridorCost: 2 },
  { name: 'Floor 3', penalty: 5, minerals: ['gold', 'sapphire'], corridorCost: 2,
    barrier: { drill: 3, pts: 10, width: 3, ex: 'battery', loss: 2 } },
  { name: 'Floor 4', penalty: 7, minerals: ['gold', 'sapphire', 'emerald'], corridorCost: 3,
    barrier: { drill: 4, pts: 15, width: 4, ex: 'battery', loss: 1 } },
  { name: 'Floor 5', penalty: 9, minerals: ['sapphire', 'emerald', 'ruby'], corridorCost: 4,
    barrier: { drill: 5, pts: 20, width: 5, ex: 'battery', loss: 1 } },
  { name: 'Floor 6', penalty: 11, minerals: ['gold', 'sapphire', 'emerald', 'ruby'], corridorCost: 5,
    barrier: { drill: 6, pts: 25, width: 6, ex: 'battery', loss: 1 } },
];

// ex = exhaust effect: 'battery' or an effect object; loss = points lost when exhausted.
const S = 'silver', G = 'gold', Sa = 'sapphire', E = 'emerald', R = 'ruby';
const t = (floor, pts, width, minerals, ex, loss) => ({ floor, pts, width, minerals, ex, loss });
export const CORRIDOR_TILES = [
  t(2, 4, 2, [S, G], { credits: 2 }, 1),
  t(2, 4, 2, [S, G], { fuel: 2 }, 2),
  t(2, 4, 2, [S, G], { draw: 1 }, 3),
  t(2, 4, 2, [S, G], { credits: 3 }, 2),
  t(2, 4, 2, [S, G], { fuel: 1 }, 1),
  t(3, 6, 2, [S, G, Sa], 'battery', 2),
  t(3, 6, 2, [G, G, Sa], 'battery', 2),
  t(3, 6, 2, [S, G, G], 'battery', 2),
  t(3, 6, 2, [S, Sa], 'battery', 2),
  t(3, 6, 2, [G, G, G], 'battery', 2),
  t(3, 6, 2, [G, Sa], 'battery', 2),
  t(4, 10, 3, [G, Sa, Sa], { draw: 1 }, 3),
  t(4, 10, 3, [Sa, Sa, E], { drone: 1 }, 1),
  t(4, 10, 3, [Sa, Sa, E], { credits: 5 }, 2),
  t(4, 10, 3, [G, Sa, E], { fuel: 2 }, 1),
  t(4, 10, 3, [Sa, E], { moves: 1 }, 2),
  t(4, 10, 3, [G, Sa, E], { moves: 1 }, 2),
  t(4, 10, 3, [Sa, Sa, Sa], { fuel: 2 }, 1),
  t(5, 15, 4, [Sa, Sa, Sa, R], 'battery', 1),
  t(5, 15, 4, [E, E, R], 'battery', 1),
  t(5, 15, 4, [Sa, Sa, R], 'battery', 1),
  t(5, 15, 4, [Sa, E, E], 'battery', 1),
  t(5, 15, 4, [Sa, E, R], 'battery', 1),
  t(5, 15, 4, [E, E, E], 'battery', 1),
  t(6, 21, 5, [E, R, R], { draw: 1 }, 3),
  t(6, 21, 5, [E, E, R, R], { fuel: 2 }, 2),
  t(6, 21, 5, [E, E, E, R], { fuel: 1 }, 1),
  t(6, 21, 5, [E, R, R], { drone: 1 }, 1),
  t(6, 21, 5, [R, R], { drone: 1 }, 1),
];

// Floor card rules are implemented by id in engine.js (floorEffect / endOpsFloor).
export const FLOOR_CARDS = [
  { id: 'pileup', name: 'Pileup', deck: 'start', text: 'End of Operations here: you may collect a silver from this floor for free.' },
  { id: 'brewery', name: 'Brewery', deck: 'start', text: 'End of Operations here: gain 1 fuel.' },
  { id: 'ritz', name: 'The Ritz', deck: 'start', text: 'After excavating a corridor here: gain 2 credits.' },
  { id: 'lobby', name: 'Lobby', deck: 'deep', text: 'On reveal: gain 2 credits. When collecting here: you may pay 1 credit for 1 fuel. End of Operations here: keep up to 3 cards without paying fuel.' },
  { id: 'squeeze', name: 'The Squeeze', deck: 'deep', text: 'When collecting here: gain 2 credits. End of Operations here: for each other mech here, pay 1 fuel or take 1 damage.' },
  { id: 'dispatch', name: 'Dispatch', deck: 'deep', text: 'End of Operations here: gain 2 credits per face-up drone, OR pay 1 fuel to refresh a drone.' },
  { id: 'hottub', name: 'Hot Tub', deck: 'deep', text: 'First corridor every turn: pay 1 drill less and put a DAMAGE into your hand.' },
  { id: 'jackpot', name: 'Jackpot', deck: 'deep', text: 'On reveal: place 1 emerald per player; each player may spend 1 drill here to collect theirs. End of Operations here: you may upgrade 1 mineral in storage.' },
  { id: 'radbath', name: 'Rad Bath', deck: 'deep', text: 'First corridor every turn: gain 5 fuel and take 1 damage.' },
  { id: 'nocave', name: 'Cave With No Ceiling', deck: 'deep', text: 'End of Operations here: you may spend moves to gain a mineral from the supply: 1 → sapphire, 2 → emerald, 3 → ruby.' },
  { id: 'chill', name: 'Chill Out Zone', deck: 'deep', text: 'On reveal: gain 2 fuel. After a corridor here: gain 2 fuel. End of Operations here: pay 1 fuel or take 1 damage.' },
  { id: 'toys', name: "Toys R' Rust", deck: 'deep', text: 'End of Operations here: you may pay 1 fuel and burn 1 mineral to repair a card.' },
];

// Card fields: shop, cost (credits), bat (needs battery), fuel (gained if burned),
// play (fuel cost of main effect, or 'solid'), fx (main effect), choose (pick one option),
// ability (1x / inf; perm cards use it every turn), passive, perm, pts, text.
// fx keys: moves, drills, fuel, credits, draw, drone, damage, damageTop, damageHand,
//          upStorage, upFuel, repair, removeSelf
// Special main effects: marketToOverflow, teleport.
const c = (id, name, shop, o) => ({ id, name, shop, cost: 0, bat: false, fuel: 0, play: 0, fx: {}, pts: 0, ...o });
export const CARDS = [
  // Starting deck (one each per player, plus 1 DAMAGE)
  c('vintage_drill', 'Vintage Drill', 'start', { fuel: 3, play: 0, fx: { drills: 1, removeSelf: true }, text: 'Remove this card from the game.' }),
  c('torso', 'Torso', 'start', { fuel: 2, play: 1, choose: [{ label: '1⛏', fx: { drills: 1 } }, { label: '1↕️', fx: { moves: 1 } }] }),
  c('crutch', 'Crutch', 'start', { fuel: 2, play: 0, fx: { moves: 1 }, pts: -2 }),
  c('spider_leg', 'Spider Leg', 'start', { fuel: 2, play: 1, fx: { moves: 2 }, pts: -1 }),
  c('claw', 'Claw', 'start', { fuel: 2, play: 1, fx: { drills: 1 }, pts: -2 }),
  c('grabber', 'Grabber', 'start', { fuel: 2, play: 4, fx: { drills: 2 }, pts: -1 }),
  c('stock_propeller', 'Stock Propeller', 'start', { fuel: 3, play: 2, fx: { moves: 3 }, pts: -1 }),
  c('mining_arm', 'Mining Arm', 'start', { fuel: 3, play: 6, fx: { drills: 3 }, pts: -1 }),
  c('damage', 'DAMAGE', 'damage', { fuel: 2, play: 2, fx: { draw: 1 }, pts: -3 }),

  // Spinerama — drilling
  c('auto_drill', 'Auto-Drill', 'drill', { cost: 5, fuel: 3, play: 1, fx: { drills: 1, draw: 1 } }),
  c('dynamite_launcher', 'Dynamite Launcher', 'drill', { cost: 11, fuel: 3, play: 5, fx: { drills: 4 } }),
  c('superior_soaker', 'Superior Soaker', 'drill', { cost: 4, fuel: 3, play: 1, fx: { drills: 2 }, ability: { limit: '1x', special: 'exchange' }, text: '1x: upgrade 1 mineral in storage (silver→gold→sapphire→emerald→ruby).' }),
  c('jackhammer', 'Jackhammer', 'drill', { cost: 9, fuel: 3, play: 3, fx: { drills: 3 }, passive: 'jackhammer', text: 'This turn: whenever you drill a corridor or barrier, gain 1 fuel.' }),
  c('careless_drilling', 'Careless Drilling', 'drill', { cost: 9, fuel: 4, play: 3, fx: { drills: 4, damage: 1 } }),
  c('harpoon_drill', 'Harpoon Drill', 'drill', { cost: 9, fuel: 3, play: 3, fx: { drills: 3 }, ability: { limit: '1x', special: 'harpoon' }, text: '1x: spend 1 drill to collect a mineral from an adjacent open floor.' }),
  c('burner_drill', 'Burner Drill', 'drill', { cost: 6, fuel: 3, play: 'solid', fx: { drills: 2, fuel: 2 } }),
  c('mining_drone', 'Mining Drone', 'drill', { cost: 6, fuel: 3, play: 3, fx: { drills: 2, drone: 1, upStorage: 1 }, text: 'Upgrade your storage cap once for free.' }),
  c('wrecking_ball', 'Wrecking Ball', 'drill', { cost: 11, perm: true, ability: { limit: '1x', req: { movesGained: 3 }, gain: { drills: 1 } }, text: 'Permanent. 1x: if you have gained 3 moves this turn, gain 1 drill.' }),
  c('laser_cutter', 'Laser Cutter', 'drill', { cost: 7, fuel: 4, play: 3, fx: { drills: 2, repair: 1 } }),
  c('reckless_drilling', 'Reckless Drilling', 'drill', { cost: 2, fuel: 3, play: 1, fx: { drills: 3, damageTop: 1 }, text: 'Put a DAMAGE on top of your deck.' }),
  c('all_in_one_tire', 'All-in-One Tire', 'drill', { cost: 7, fuel: 4, play: 3, fx: { moves: 2, drills: 2 } }),

  // Pony Express — movement
  c('proper_propeller', 'Proper Propeller', 'move', { cost: 5, fuel: 3, play: 0, fx: { moves: 3 } }),
  c('rocket_drone_plus', 'Rocket Drone Plus', 'move', { cost: 9, fuel: 4, play: 1, fx: { moves: 4, drone: 2 } }),
  c('flywheel', 'Flywheel', 'move', { cost: 3, fuel: 4, play: 1, fx: { moves: 3 }, passive: 'flywheel', text: 'Gain 1 fuel for each card you play (or have played) this turn just to gain fuel.' }),
  c('hover_pads', 'Hover Pads', 'move', { cost: 8, perm: true, ability: { limit: '1x', gain: { moves: 1 } }, text: 'Permanent. 1x: gain 1 move.' }),
  c('atm_drone', 'ATM Drone', 'move', { cost: 3, fuel: 3, play: 1, fx: { moves: 1, drone: 1, credits: 7 } }),
  c('suction_engine', 'Suction Engine', 'move', { cost: 6, fuel: 4, play: 2, fx: { moves: 4 }, passive: 'suction', text: "This turn, collecting minerals doesn't cost drills." }),
  c('panic_button', 'Panic Button', 'move', { cost: 0, fuel: 3, play: 0, fx: { moves: 4, damage: 1 } }),
  c('wheels_on_heels', 'Wheels on Heels', 'move', { cost: 5, fuel: 3, play: 1, fx: { moves: 2, draw: 1 } }),
  c('rocket_drone', 'Rocket Drone', 'move', { cost: 4, fuel: 3, play: 1, fx: { moves: 3, drone: 1 } }),
  c('footless_treads', 'Footless Treads', 'move', { cost: 5, fuel: 3, play: 1, fx: { moves: 3 }, choose: [{ label: '+1↕️', fx: { moves: 1 } }, { label: 'refresh drone', fx: { drone: 1 } }, { label: '+1⛽', fx: { fuel: 1 } }] }),
  c('rocket_engine', 'Rocket Engine', 'move', { cost: 7, fuel: 4, play: 2, fx: { moves: 3, repair: 1 } }),
  c('adaptive_engine', 'Adaptive Engine', 'move', { cost: 2, fuel: 3, play: 0, fx: { moves: 2 }, ability: { limit: 'inf', cost: { fuel: 2 }, gain: { moves: 1 } }, text: 'Any number of times: pay 2 fuel to gain 1 move.' }),

  // Bots 4 Less — utility
  c('repair_drone', 'Repair Drone', 'util', { cost: 5, fuel: 4, play: 1, fx: { drone: 1, repair: 1 }, ability: { limit: 'inf', cost: { drone: 1 }, gain: { fuel: 2 } }, text: 'Any number of times: exhaust a drone to gain 2 fuel.' }),
  c('refuelling_break', 'Refuelling Break', 'util', { cost: 8, fuel: 5, play: 0, fx: { fuel: 3, draw: 1 } }),
  c('refuelling_drone', 'Refuelling Drone', 'util', { cost: 6, fuel: 5, play: 0, fx: { fuel: 4, drone: 1, upFuel: 1 }, text: 'Upgrade your maximum fuel once for free.' }),
  c('sentient_drone', 'Sentient Drone', 'util', { cost: 6, fuel: 3, play: 1, fx: { moves: 1, drone: 1, draw: 1 } }),
  c('current_miner', 'Current-C Miner', 'util', { cost: 7, fuel: 3, play: 1, fx: { credits: 5, draw: 1 }, marketToOverflow: true, text: 'Move the topmost mineral from a market column to your overflow zone.' }),
  c('swiss_arm', 'Swiss Arm', 'util', { cost: 8, fuel: 4, play: 3, fx: { moves: 1, drills: 1, drone: 1, draw: 1 } }),
  c('water_cooling', 'Water Cooling', 'util', { cost: 9, fuel: 4, play: 2, fx: { draw: 1, repair: 1 } }),
  c('cleaning_break', 'Cleaning Break', 'util', { cost: 4, fuel: 3, play: 0, fx: { draw: 1, upStorage: 1 }, text: 'Upgrade your storage cap once for free.' }),
  c('coffee_break', 'Coffee Break', 'util', { cost: 7, fuel: 4, play: 2, fx: { draw: 2 } }),
  c('nuclear_reactor', 'Nuclear Reactor', 'util', { cost: 7, perm: true, ability: { limit: '1x', gain: { fuel: 1 } }, text: 'Permanent. 1x: gain 1 fuel.' }),
  c('pit_stop', 'Pit Stop', 'util', { cost: 8, fuel: 5, play: 0, fx: { fuel: 3, repair: 1 } }),
  c('utility_bot', 'Utility Bot', 'util', { cost: 2, fuel: 3, play: 0, fx: { moves: 1 }, choose: [{ label: 'refresh 2 drones', fx: { drone: 2 } }, { label: 'repair', fx: { repair: 1 } }] }),

  // Old corp tech — advanced (needs a battery)
  c('ultrahot_furnace', 'Ultrahot Furnace', 'adv', { cost: 3, bat: true, fuel: 3, play: 'solid', fx: { fuel: 6, upFuel: 1 }, text: 'Upgrade your maximum fuel once for free.' }),
  c('transformer_drill', 'Transformer Drill', 'adv', { cost: 2, bat: true, fuel: 4, play: 1, choose: [{ label: '2⛏', fx: { drills: 2 } }, { label: '1⛏ 2↕️', fx: { drills: 1, moves: 2 } }, { label: '4↕️', fx: { moves: 4 } }] }),
  c('reckless_descent', 'Reckless Descent', 'adv', { cost: 0, bat: true, fuel: 4, play: 0, fx: { moves: 4, damage: 1 } }),
  c('super_heavy_drill', 'Super Heavy Drill', 'adv', { cost: 17, bat: true, fuel: 5, play: 4, fx: { drills: 5 } }),
  c('mining_drone_pro', 'Mining Drone Pro', 'adv', { cost: 6, bat: true, fuel: 4, play: 3, fx: { drills: 3, drone: 1 } }),
  c('recoil_capacitor', 'Recoil Capacitor', 'adv', { cost: 8, bat: true, perm: true, ability: { limit: '1x', req: { drillsGained: 3 }, gain: { fuel: 2 } }, text: 'Permanent. 1x: if you have gained 3 drills this turn, gain 2 fuel.' }),
  c('supercharged_drilling', 'Supercharged Drilling', 'adv', { cost: 12, bat: true, fuel: 5, play: 6, fx: { drills: 6, damageHand: 1 }, text: 'Take a DAMAGE into your hand.' }),
  c('rocket_engine_pro', 'Rocket Engine Pro', 'adv', { cost: 9, bat: true, fuel: 4, play: 2, fx: { moves: 5, repair: 1 } }),
  c('surgeon', 'Surgeon', 'adv', { cost: 8, bat: true, perm: true, ability: { limit: '1x', cost: { fuel: 1 }, gain: { drills: 1 } }, text: 'Permanent. 1x: pay 1 fuel to gain 1 drill.' }),
  c('deep_neural_network', 'Deep Neural Network', 'adv', { cost: 9, bat: true, perm: true, ability: { limit: '1x', cost: { fuel: 2 }, gain: { draw: 1 } }, text: 'Permanent. 1x: pay 2 fuel to draw a card.' }),
  c('repair_bots', 'Repair Bots', 'adv', { cost: 5, bat: true, fuel: 4, play: 2, fx: { moves: 1, repair: 2 } }),
  c('atomic_dislocator', 'Atomic Dislocator', 'adv', { cost: 16, bat: true, fuel: 5, play: 0, fx: { drills: 3, fuel: 1 } }),
  c('printer_3d', '3D Printer', 'adv', { cost: 7, bat: true, perm: true, ability: { limit: '1x', gain: { drone: 1 } }, text: 'Permanent. 1x: refresh a drone.' }),
  c('laser_cutter_pro', 'Laser Cutter Pro', 'adv', { cost: 18, bat: true, fuel: 5, play: 4, fx: { drills: 4, repair: 1 } }),
  c('antigravity_drive', 'Antigravity Drive', 'adv', { cost: 11, bat: true, fuel: 5, play: 0, teleport: true, text: 'Move your mech to any open floor (or the surface).' }),
  c('auto_drill_ultra', 'Auto-Drill Ultra', 'adv', { cost: 8, bat: true, fuel: 4, play: 2, fx: { drills: 2, draw: 1 } }),
];

export const SHOPS = [
  { id: 'drill', name: 'Spinerama (drills)' },
  { id: 'move', name: 'Pony Express (movement)' },
  { id: 'util', name: 'Bots 4 Less (utility)' },
  { id: 'adv', name: 'Old corp tech (advanced, needs battery)' },
];
