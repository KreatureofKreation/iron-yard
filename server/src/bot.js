// Server-side AI opponent. Generates an "input" message each tick and lets applyInput
// run it through the same pipeline as a human player. Intentionally simple to be readable.

import { CONFIG } from "./config.js";
import { weaponOf } from "./player.js";

const BOT_NAMES = [
  "old gareth", "iron jen", "dunmar", "training dummy",
  "ash-walker", "fenric", "halgrim", "boar of varn",
];
const WEAPONS = ["arming", "longsword", "mace", "spear"];

// Difficulty tunings: hz scales swing rate; aimSlop adds noise to facing; dodgeFactor scales
// the threat-detection threshold (lower = dodges more); strafeBoost when in range.
const BOT_DIFFICULTY = {
  easy:   { swingHz: 2, aimSlop: 0.55, dodgeFactor: 0.0, strafeBoost: 0.25, blockChance: 0.20, hesitationMs: 1100 },
  medium: { swingHz: 3, aimSlop: 0.30, dodgeFactor: 0.3, strafeBoost: 0.40, blockChance: 0.45, hesitationMs: 600 },
  hard:   { swingHz: 5, aimSlop: 0.15, dodgeFactor: 0.6, strafeBoost: 0.60, blockChance: 0.70, hesitationMs: 250 },
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

  // Weapon tip — when in range, swing in an arc; otherwise rest forward.
  const inRange = dist <= engage + 0.5;
  const swingHz = tune.swingHz + (bot.id % 3);
  const swingPhase = nowMs / 1000 * swingHz + bot.id * 0.7;
  // Hesitation gate: bot swings hard for 400ms, then pauses for `hesitationMs` before
  // the next attack. Easy bots are very passive; hard bots barely pause.
  const cycleMs = (tune.hesitationMs ?? 250) + 400;
  const cycleFrac = (nowMs % cycleMs) / cycleMs;
  const swingActive = cycleFrac > (tune.hesitationMs ?? 250) / cycleMs;
  // Stunned target → always swing fully (killshot).
  const fullSwing = swingActive || targetStunned;
  const swingAng = Math.sin(swingPhase) * (fullSwing ? 1.05 : 0.15);
  const heightOsc = 1.5 + Math.cos(swingPhase * 0.5) * 0.25;
  const aimYaw = inRange ? yaw + swingAng : yaw + Math.sin(nowMs / 500 + bot.id) * 0.2;

  const length = w.length;
  const fx = -Math.sin(aimYaw);
  const fz = -Math.cos(aimYaw);
  const tip = {
    x: bot.pos.x + fx * length,
    y: bot.pos.y + heightOsc,
    z: bot.pos.z + fz * length,
  };

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
