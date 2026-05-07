// Mirrors a subset of server config; runtime config from server overrides.
export const CLIENT = {
  INPUT_HZ: 60,
  PING_HZ: 1,
  INTERP_DELAY_MS: 100,        // render slightly behind server for smooth interp
  MOUSE_SENS: 0.0022,
  WEAPON_MOUSE_SENS: 0.004,
  WEAPON_OFFSET_CLAMP: 1.6,    // max angular reach of weapon control (rad-ish)
};

// Defaults if server hasn't replied yet.
export let RUNTIME = {
  player: { radius: 0.4, height: 1.8, eyeY: 1.65, hp: 100, stamina: 100, moveSpeed: 4.5, sprintMult: 1.6 },
  weapon: { length: 1.1, mass: 1.1, name: "arming sword" },
  weapons: {},
  arena: { size: 30, wallH: 4, obstacles: [], racks: [] },
};
export function applyRuntime(welcome) {
  RUNTIME.player = { ...RUNTIME.player, ...welcome.config.player };
  RUNTIME.arena  = { ...RUNTIME.arena, ...welcome.arena };
  if (welcome.config.weapons) RUNTIME.weapons = welcome.config.weapons;
  // Pick this player's weapon stats.
  const k = welcome.you?.weaponKey;
  const w = (k && RUNTIME.weapons[k]) || welcome.config.weapon;
  if (w) RUNTIME.weapon = { ...RUNTIME.weapon, ...w };
}
