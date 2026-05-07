// Tunables — kept in one place.
export const CONFIG = {
  PORT: Number(process.env.PORT) || 8080,
  TICK_HZ: 30,                 // server simulation rate
  SNAP_HZ: 20,                 // snapshot broadcast rate
  MAX_PLAYERS: 4,
  ARENA: { size: 30, wallH: 4 },
  PLAYER: {
    radius: 0.4,
    height: 1.8,               // capsule total height
    eyeY: 1.65,
    moveSpeed: 4.5,            // m/s
    sprintMult: 1.6,
    jumpVel: 5.5,
    hp: 100,
    respawnMs: 3000,
    spawnInvulnMs: 1500,
    accel: 28,                 // m/s² horizontal locomotion responsiveness
    // Stamina.
    stamina: 100,
    staminaRegen: 22,          // /sec while idle/walking
    staminaRegenBlocking: 6,
    staminaSprintCost: 28,     // /sec while sprinting
    staminaBlockCost: 8,       // /sec while blocking
    staminaSwingCost: 14,      // per qualifying-fast-swing event (server gates by speed)
    staminaJumpCost: 18,       // each jump
    minStaminaToSprint: 10,
    minStaminaToBlock: 6,
    minStaminaToSwing: 0,      // exhausted swings still possible but reduced damage
    exhaustedDamageMul: 0.5,   // damage scale when stamina <= 5
  },
  // Default weapon when one isn't specified.
  DEFAULT_WEAPON: "arming",
  // Per-weapon stats. Damage = clamp((tipSpeed - minSpeed) * speedScale * (0.6 + mass*0.4), minDmg, maxDmg).
  WEAPONS: {
    arming: {
      key: "arming", name: "arming sword", grip: "one-hand",
      length: 1.10, mass: 1.10, edgeHalfWidth: 0.04,
      minSpeed: 4.0, speedScale: 4.0, maxDmg: 45, minDmg: 6,
      hitCooldownMs: 350, swingMass: 1.0, // 1.0 = neutral feel
    },
    longsword: {
      key: "longsword", name: "longsword", grip: "two-hand",
      length: 1.30, mass: 1.50, edgeHalfWidth: 0.045,
      minSpeed: 3.5, speedScale: 4.5, maxDmg: 60, minDmg: 9,
      hitCooldownMs: 450, swingMass: 1.4,
    },
    mace: {
      key: "mace", name: "mace", grip: "one-hand",
      length: 0.80, mass: 1.40, edgeHalfWidth: 0.07,
      minSpeed: 3.0, speedScale: 5.5, maxDmg: 70, minDmg: 12,
      hitCooldownMs: 500, swingMass: 1.5,
      blunt: true,             // bypasses some block reduction
    },
    spear: {
      key: "spear", name: "spear", grip: "two-hand",
      length: 2.10, mass: 1.20, edgeHalfWidth: 0.035,
      minSpeed: 5.0, speedScale: 5.5, maxDmg: 55, minDmg: 8,
      hitCooldownMs: 400, swingMass: 1.2,
      thrustBonus: true,       // bonus damage on tip motion that's mostly forward
    },
  },
  // Match/round.
  MATCH: {
    scoreToWin: Number(process.env.SCORE_TO_WIN) || 5,
    intermissionMs: Number(process.env.INTERMISSION_MS) || 6000,
    countdownMs: Number(process.env.COUNTDOWN_MS) || 3000,   // input frozen during this
    roundTimeMs: Number(process.env.ROUND_TIME_MS) || 180000, // 3 minutes; 0 disables
    minPlayersToStart: 1,
  },
  // Common combat tunables.
  COMBAT: {
    blockReductionFront: 0.85, // facing attacker
    blockReductionSide:  0.40,
    bluntBlockPenalty:   0.30, // mace ignores 30% of block reduction
    parrySpeedMin:       6.0,  // both swords moving fast → clash, no damage
    parryRadius:         0.30, // segments closer than this with both swinging fast
    // Body-part hit-zone multipliers (server-derived from hit Y on the capsule).
    zone: {
      headDamageMul: 1.8,
      torsoDamageMul: 1.0,
      legsDamageMul:  0.7,
      // Headshot threshold: hit Y >= eyeY - margin.
    },
  },
  PHYSICS: {
    gravity: -18,
  },
};

// Backwards-compat shim used in older modules: WEAPON = default weapon stats + common combat.
const _w = (key) => CONFIG.WEAPONS[key] ?? CONFIG.WEAPONS.arming;
Object.defineProperty(CONFIG, "WEAPON", {
  get() {
    const w = _w(CONFIG.DEFAULT_WEAPON);
    return {
      ...w,
      blockReductionFront: CONFIG.COMBAT.blockReductionFront,
      blockReductionSide:  CONFIG.COMBAT.blockReductionSide,
    };
  },
});
