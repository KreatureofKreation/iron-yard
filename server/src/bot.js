// Server-side AI opponent. Generates an "input" message each tick and lets applyInput
// run it through the same pipeline as a human player. Intentionally simple to be readable.

import { CONFIG } from "./config.js";
import { weaponOf } from "./player.js";

const BOT_NAMES = [
  "old gareth", "iron jen", "dunmar", "training dummy",
  "ash-walker", "fenric", "halgrim", "boar of varn",
];
const WEAPONS = ["arming", "longsword", "mace", "spear"];

// Difficulty tunings.
//   aimSlop      — yaw noise; lower = better aim
//   dodgeFactor  — sidestep threshold; higher = more reactive
//   blockChance  — block when low HP
//   attackGapMs  — pause between attack cycles (lower = faster attacker)
//   commitChance — chance the bot commits to its attack rather than feinting at last moment
const BOT_DIFFICULTY = {
  easy:   { aimSlop: 0.55, dodgeFactor: 0.0, blockChance: 0.20, attackGapMs: 1400, commitChance: 0.85 },
  medium: { aimSlop: 0.30, dodgeFactor: 0.3, blockChance: 0.45, attackGapMs:  800, commitChance: 0.92 },
  hard:   { aimSlop: 0.15, dodgeFactor: 0.6, blockChance: 0.70, attackGapMs:  400, commitChance: 0.97 },
};
export function botDifficultyTuning(level = "medium") {
  return BOT_DIFFICULTY[level] || BOT_DIFFICULTY.medium;
}

const BOT_TAUNTS = [
  "yield, dog!", "another for the heap", "again? bring it.",
  "easy meat", "haha — coward!", "to the gibbet with you",
  "for the iron yard!", "stay down", "your bones, my keep",
];
export function pickBotTaunt() { return BOT_TAUNTS[(Math.random() * BOT_TAUNTS.length) | 0]; }

export function pickBotName(existing) {
  const used = new Set([...existing.values()].map(p => p.name));
  for (const n of BOT_NAMES) if (!used.has(`[bot] ${n}`)) return n;
  return BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
}

export function pickBotWeapon() {
  return WEAPONS[(Math.random() * WEAPONS.length) | 0];
}

// Pick the closest alive player that isn't us.
function findTarget(bot, players) {
  let best = null;
  let bestD = Infinity;
  for (const p of players.values()) {
    if (p === bot || !p.alive) continue;
    const d = Math.hypot(p.pos.x - bot.pos.x, p.pos.z - bot.pos.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { p: best, dist: bestD } : null;
}

// Stuck detection: track each bot's recent positions; if not progressing, jitter.
function detectStuck(bot, nowMs) {
  if (!bot._stuckMem) bot._stuckMem = { lastPos: { x: bot.pos.x, z: bot.pos.z }, lastSampleMs: nowMs, stuck: 0 };
  const m = bot._stuckMem;
  if (nowMs - m.lastSampleMs > 250) {
    const dx = bot.pos.x - m.lastPos.x;
    const dz = bot.pos.z - m.lastPos.z;
    const dist = Math.hypot(dx, dz);
    // < 0.15m progress in 250ms while trying to move = stuck.
    if (dist < 0.15) m.stuck++;
    else m.stuck = 0;
    m.lastPos.x = bot.pos.x; m.lastPos.z = bot.pos.z;
    m.lastSampleMs = nowMs;
  }
  return m.stuck;
}

// Find nearest weapon rack (passed in from room). Returns { x, z, dist } or null.
function findNearestRack(bot, racks) {
  if (!racks || !racks.length) return null;
  let best = null, bestD = Infinity;
  for (const r of racks) {
    const dx = r.x - bot.pos.x, dz = r.z - bot.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; best = r; }
  }
  return best ? { x: best.x, z: best.z, dist: Math.sqrt(bestD) } : null;
}

// Generate one tick's input for the bot.
export function botInput(bot, players, nowMs, racks = null) {
  const t = findTarget(bot, players);
  if (!t) {
    return { seq: 0, mv: { x: 0, y: 0 }, yaw: bot.yaw, sprint: false, jump: false,
             blocking: false, swinging: true, weaponTip: bot.weaponTip };
  }
  const target = t.p, dist = t.dist;
  const dx = target.pos.x - bot.pos.x;
  const dz = target.pos.z - bot.pos.z;
  // Yaw to face target. (-sin, -cos) is the forward of yaw=0; we want -dz forward, -dx right.
  const tune = bot.botTuning || botDifficultyTuning("medium");
  const aimSlop = tune.aimSlop;
  const yaw = Math.atan2(-dx, -dz) + (Math.sin(nowMs / 480 + bot.id * 1.3) * aimSlop);

  const w = weaponOf(bot);
  // Bot must be close enough that its weapon tip (~bot + L*forward) overlaps the target's
  // capsule (radius 0.4). Use L + 0.2 as the engagement distance with some margin.
  const engage = w.length + 0.20;
  const tooClose = Math.max(0.6, w.length * 0.5);

  // Threat: target's tip approaching us at speed.
  const tvx = target.weaponTipVel?.x || 0;
  const tvz = target.weaponTipVel?.z || 0;
  const tipSpd = Math.hypot(tvx, tvz);
  const tipToBotX = bot.pos.x - target.weaponTip.x;
  const tipToBotZ = bot.pos.z - target.weaponTip.z;
  const tipDist = Math.hypot(tipToBotX, tipToBotZ);
  // Approach factor: positive when tip moving toward bot.
  const approach = (tvx * (-tipToBotX) + tvz * (-tipToBotZ)) / Math.max(0.01, tipDist);
  const threat = (tune.dodgeFactor > 0) && (tipSpd > (5 / Math.max(0.3, tune.dodgeFactor))) && (tipDist < 2.5) && (approach > 2 / Math.max(0.3, tune.dodgeFactor));

  // Status-aware tweaks: target is helpless if stunned → press the attack hard.
  // If bot is bleeding heavily (hp+bleed-rate suggests it'll die soon), back off.
  // If bot is disarmed/stunned itself, sprint AWAY from target.
  const now = nowMs;
  const targetStunned = (target.stunUntilMs || 0) > now;
  const targetDisarmed = (target.disarmedUntilMs || 0) > now;
  const botBleedingBad = bot.bleedDmgPerSec > 6 && bot.hp < 60 && (bot.bleedUntilMs || 0) > now + 1000;
  const botHelpless = (bot.disarmedUntilMs || 0) > now || (bot.stunUntilMs || 0) > now;

  // Movement decision.
  let mv = { x: 0, y: 0 };
  if (botHelpless) {
    const stunned = (bot.stunUntilMs || 0) > now;
    if (!stunned) {
      // Pick the closer of (nearest rack, nearest unowned dropped sword).
      const rack = findNearestRack(bot, racks);
      let bestX = null, bestZ = null, bestD = Infinity;
      if (rack) { bestX = rack.x; bestZ = rack.z; bestD = rack.dist; }
      for (const q of players.values()) {
        if (q === bot) continue;
        const dropped = !q.alive || (q.stunUntilMs || 0) > now || (q.disarmedUntilMs || 0) > now;
        if (!dropped) continue;
        const dx = (q.pos.x - bot.pos.x), dz = (q.pos.z - bot.pos.z);
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; bestX = q.pos.x; bestZ = q.pos.z; }
      }
      if (bestX != null) {
        const rdx = bestX - bot.pos.x, rdz = bestZ - bot.pos.z;
        bot._rackYaw = Math.atan2(-rdx, -rdz);
        mv.y = 1;
        mv.x = 0;
      } else {
        mv.y = -1;
        mv.x = Math.sin(now / 250 + bot.id) * 0.4;
      }
    } else {
      mv.y = -1;
      mv.x = Math.sin(now / 250 + bot.id) * 0.4;
    }
  } else if (botBleedingBad) {
    // Retreat — try to stay out of reach to let bleed expire.
    mv.y = -1;
    mv.x = Math.sin(now / 350 + bot.id) * 0.6;
  } else if (targetStunned || targetDisarmed) {
    // Press the attack — close in even if "in range" already, no strafe.
    mv.y = dist > engage * 0.7 ? 1 : 0.5;
  } else if (threat) {
    // Sidestep perpendicular to attacker's tip-velocity vector.
    const px = -tvz, pz = tvx;
    const m = Math.hypot(px, pz) || 1;
    // Decide left or right based on bot.id parity for variety.
    const sign = (bot.id % 2) ? 1 : -1;
    // Map world dodge to player-local mv. yaw = atan2(-dx, -dz). Inverse rotate.
    const wx = sign * px / m, wz = sign * pz / m;
    const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
    mv.x = cy * wx + sy * wz;
    mv.y = -(-sy * wx + cy * wz);                       // forward axis flipped (server convention)
  } else if (dist > engage) {
    mv.y = 1;                                          // close in
  } else if (dist < tooClose) {
    mv.y = -0.7;                                        // back off
    mv.x = ((bot.id % 2) ? 1 : -1) * 0.4;
  } else {
    mv.x = Math.sin(nowMs / 700 + bot.id) * 0.6;        // in range — strafe
  }

  // Unstick: if not progressing for several samples, jitter sideways. If VERY stuck,
  // reverse direction and turn ~90° to peel away from a wall/pillar.
  const stuck = detectStuck(bot, nowMs);
  if (stuck >= 2) {
    mv.x = Math.sin(nowMs / 200 + bot.id * 1.7) * (0.7 + (stuck * 0.05));
    mv.y = (stuck > 4 ? 0.5 : 1) * (Math.sign(mv.y || 1));
  }
  if (stuck >= 6) {
    // Heavily stuck: back out and rotate so we don't keep ramming the same wall.
    mv.x = (bot.id % 2 ? 1 : -1) * 0.9;
    mv.y = -0.8;
  }

  // Block when low HP and target is close.
  const blocking = bot.hp < 30 && dist < engage * 1.3 && Math.random() < tune.blockChance;

  // Phase-based attack — same windup/release/recovery model as humans, server-side.
  // Bot state holds the current attack and start time; we generate the tip target
  // each tick based on phase progression.
  const inRange = dist <= engage + 0.5;
  const tip = chooseBotAttackTip(bot, target, yaw, dist, engage, w, tune, nowMs, targetStunned);

  // Jump rarely to dodge.
  const jump = bot.onGround && (
    (Math.random() < 0.005 && dist < engage) ||
    (stuck > 5 && Math.random() < 0.2)
  );

  return {
    seq: (bot.lastInputSeq || 0) + 1,
    mv,
    yaw: (botHelpless && bot._rackYaw != null) ? bot._rackYaw : yaw,
    pitch: 0,
    sprint: botHelpless || (dist > engage * 1.8 && bot.hp > 50),
    jump,
    blocking,
    swinging: true,
    weaponTip: tip,
  };
}

// Phase-based bot attacks. Picks an attack type when ready, then runs through
// windup → release → recovery, returning the appropriate weaponTip world position
// for each tick. Forces the spring-driven sword body to actually trace the strike.
const BOT_ATTACK_PHASES = {
  swing:    { windup: 380, release: 240, recovery: 320 },
  overhead: { windup: 440, release: 280, recovery: 360 },
  stab:     { windup: 280, release: 180, recovery: 260 },
};
// Local poses (forward-relative; same axes as the human attack waypoints in main.js
// but evaluated server-side from the bot's yaw and position).
const BOT_POSES = {
  swing: {
    chamber: { side: -1.0, up: 0.55,  fwd: -0.30 },     // wind back over off-shoulder
    contact: { side:  0.20, up: 0.45, fwd:  1.40 },     // strike forward
    end:     { side:  1.10, up: -0.20, fwd:  0.30 },    // follow-through past hip
  },
  overhead: {
    chamber: { side:  0.40, up: 1.40, fwd: -0.40 },
    contact: { side:  0.10, up: 0.20, fwd:  1.30 },
    end:     { side: -0.20, up: -0.85, fwd:  0.95 },
  },
  stab: {
    chamber: { side:  0.10, up: 0.05, fwd:  0.05 },
    contact: { side:  0.20, up: 0.20, fwd:  1.00 },
    end:     { side:  0.30, up: 0.30, fwd:  1.90 },
  },
};

function easeInSlow(u) { return u * u; }
function easeOutFast(u) { return 1 - Math.pow(1 - u, 2); }
function easeInOut(u) { return u < 0.5 ? 4*u*u*u : 1 - Math.pow(-2*u+2, 3) / 2; }
function lerp(a, b, t) { return a + (b - a) * t; }

function chooseBotAttackTip(bot, target, yaw, dist, engage, w, tune, nowMs, targetStunned) {
  const inRange = dist <= engage + 0.4;

  // State machine for bot attack cycle.
  if (!bot._atk) bot._atk = { phase: "idle", start: 0, type: null, nextAtMs: 0 };
  const atk = bot._atk;

  // If idle and ready + in range, start a new attack.
  if (atk.phase === "idle" && nowMs >= atk.nextAtMs) {
    if (inRange || targetStunned) {
      // Pick attack type weighted by weapon class.
      const r = Math.random();
      if (w.key === "spear") {
        atk.type = r < 0.65 ? "stab" : r < 0.85 ? "swing" : "overhead";
      } else if (w.key === "mace") {
        atk.type = r < 0.45 ? "swing" : r < 0.85 ? "overhead" : "stab";
      } else if (w.key === "longsword") {
        atk.type = r < 0.40 ? "swing" : r < 0.75 ? "overhead" : "stab";
      } else {
        atk.type = r < 0.55 ? "swing" : r < 0.85 ? "overhead" : "stab";
      }
      // Hard bots commit; easy bots may feint (start then bail out into recovery).
      if (Math.random() > tune.commitChance) atk.type = "feint";
      atk.start = nowMs;
      atk.phase = "windup";
    }
  }

  // Compute current tip target.
  const elapsed = nowMs - atk.start;
  const type = atk.type === "feint" ? "swing" : atk.type;
  const phases = type ? BOT_ATTACK_PHASES[type] : null;
  let pose = null;     // {side, up, fwd}

  if (atk.phase === "windup" && phases) {
    const u = elapsed / phases.windup;
    if (u >= 1) {
      // Feint exits HERE — skip release, jump straight into recovery.
      if (atk.type === "feint") { atk.phase = "recovery"; atk.start = nowMs; }
      else { atk.phase = "release"; atk.start = nowMs; }
    } else {
      const ue = easeInSlow(u);
      pose = poseLerp(REST_POSE, BOT_POSES[type].chamber, ue);
    }
  }
  if (atk.phase === "release" && phases) {
    const re = nowMs - atk.start;
    if (re >= phases.release) {
      atk.phase = "recovery";
      atk.start = nowMs;
    } else {
      const u = re / phases.release;
      const ue = easeOutFast(u);
      // chamber → contact → end via two-segment lerp.
      const a = BOT_POSES[type].chamber, b = BOT_POSES[type].contact, c = BOT_POSES[type].end;
      if (ue < 0.5) pose = poseLerp(a, b, ue / 0.5);
      else          pose = poseLerp(b, c, (ue - 0.5) / 0.5);
    }
  }
  if (atk.phase === "recovery" && phases) {
    const rc = nowMs - atk.start;
    if (rc >= phases.recovery) {
      atk.phase = "idle";
      atk.type = null;
      atk.nextAtMs = nowMs + tune.attackGapMs + ((bot.id * 73) % 200);
    } else {
      const u = rc / phases.recovery;
      const ue = easeInOut(u);
      const last = atk.type === "feint" ? BOT_POSES[type].chamber : BOT_POSES[type].end;
      pose = poseLerp(last, REST_POSE, ue);
    }
  }

  // No active attack → idle ready stance.
  if (!pose) pose = REST_POSE;

  // Scale by weapon length so heavier/longer weapons reach further.
  const reach = w.length;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx =  Math.cos(yaw), rz = -Math.sin(yaw);
  return {
    x: bot.pos.x + rx * (pose.side * 0.6) + fx * (pose.fwd * reach),
    y: bot.pos.y + 1.40 + pose.up * 0.6,
    z: bot.pos.z + rz * (pose.side * 0.6) + fz * (pose.fwd * reach),
  };
}

const REST_POSE = { side: 0.30, up: -0.10, fwd: 0.55 };
function poseLerp(a, b, t) {
  return { side: lerp(a.side, b.side, t), up: lerp(a.up, b.up, t), fwd: lerp(a.fwd, b.fwd, t) };
}
