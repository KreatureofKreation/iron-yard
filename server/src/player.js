import { CONFIG } from "./config.js";
import { v, clone, add, scale, sub, norm, len } from "./math.js";
import { clampToArena } from "./arena.js";

let nextId = 1;

export function makePlayer(name, spawn, weaponKey) {
  const wkey = CONFIG.WEAPONS[weaponKey] ? weaponKey : CONFIG.DEFAULT_WEAPON;
  return {
    id: nextId++,
    name: (name || "knight").slice(0, 16),
    weaponKey: wkey,
    color: 0,
    pos: clone(spawn.pos),
    vel: v(),
    impulse: v(),              // external knockback velocity, decays each tick
    yaw: spawn.yaw,
    pitch: 0,
    onGround: true,
    hp: CONFIG.PLAYER.hp,
    stamina: CONFIG.PLAYER.stamina,
    helmIntact: true,
    alive: true,
    deadAtMs: 0,
    spawnedAtMs: Date.now(),
    // Weapon tip in world space — client sends, server smooths/validates.
    weaponTip: v(0, 1.2, 1.0),
    weaponTipPrev: v(0, 1.2, 1.0),
    weaponTipVel: v(),         // computed from delta / dt
    swinging: false,
    blocking: false,
    // Per-target hit cooldown.
    lastHitAtMs: new Map(),    // targetId -> ms
    parryUntilMs: new Map(),   // targetId -> ms (no damage to that target until this time)
    lastInputSeq: 0,
    rtt: 0,
    socket: null,
    sessionId: null,                  // client-supplied; reconnect identity
    zombieUntilMs: 0,                 // > 0 while disconnected awaiting rejoin
    score: 0,
    deaths: 0,
    roundDamage: 0,
    pendingInput: null,
    killStreak: 0,
    crippledUntilMs: 0,
    stunUntilMs: 0,
    disarmedUntilMs: 0,
    knockedDownUntilMs: 0,
    commitStrikeUntilMs: 0,
    severedLeg: false,
    _lastTipVel: { x: 0, y: 0, z: 0 },
    bleedUntilMs: 0,
    bleedDmgPerSec: 0,
    bleedAccum: 0,
    // Anim hint sent to clients.
    animTick: 0,
  };
}

// Get current weapon stats for player.
export function weaponOf(p) {
  return CONFIG.WEAPONS[p.weaponKey] || CONFIG.WEAPONS[CONFIG.DEFAULT_WEAPON];
}

export function applyInput(p, input, dtMs) {
  const dt = dtMs / 1000;
  if (!p.alive) return;

  // Stunned/knockedDown: drop movement + swing inputs but still tick gravity.
  const nowMs = Date.now();
  if (nowMs < p.stunUntilMs || nowMs < p.knockedDownUntilMs) {
    input = { mv: { x: 0, y: 0 }, yaw: p.yaw, sprint: false, jump: false,
              blocking: false, swinging: false, weaponTip: p.weaponTip };
  }

  // Look — we trust client orientation for view but clamp pitch.
  if (typeof input.yaw === "number")   p.yaw   = input.yaw;
  if (typeof input.pitch === "number") p.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, input.pitch));

  // Movement basis from yaw.
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw); // forward
  const rx =  Math.cos(p.yaw), rz = -Math.sin(p.yaw); // right
  const mv = input.mv || { x: 0, y: 0 };
  let mx = rx * mv.x + fx * mv.y;
  let mz = rz * mv.x + fz * mv.y;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }

  // Stamina gating + drain.
  const STA = CONFIG.PLAYER;
  const wantSprint = !!input.sprint;
  const canSprint = wantSprint && p.stamina >= STA.minStaminaToSprint;
  const wantBlock = !!input.blocking;
  const canBlock = wantBlock && p.stamina >= STA.minStaminaToBlock;
  // Drain.
  if (canSprint) p.stamina -= STA.staminaSprintCost * dt;
  if (canBlock)  p.stamina -= STA.staminaBlockCost  * dt;
  // Regen baseline.
  if (!canSprint && !canBlock) {
    p.stamina += STA.staminaRegen * dt;
  } else if (canBlock && !canSprint) {
    p.stamina += STA.staminaRegenBlocking * dt;
  }
  p.stamina = Math.max(0, Math.min(STA.stamina, p.stamina));

  let speed = CONFIG.PLAYER.moveSpeed * (canSprint ? CONFIG.PLAYER.sprintMult : 1);
  if (canBlock) speed *= 0.55;
  if (p.swinging) speed *= 0.75;
  if (Date.now() < p.crippledUntilMs) speed *= 0.45;   // leg cripple debuff
  if (p.severedLeg) speed *= 0.35;                     // severed leg = permanent crawl this round

  // Smooth acceleration toward target velocity.
  const targetVx = mx * speed;
  const targetVz = mz * speed;
  const accelRate = STA.accel ?? 28;
  const k = Math.min(1, dt * accelRate / Math.max(1, speed));
  p.vel.x += (targetVx - p.vel.x) * k;
  p.vel.z += (targetVz - p.vel.z) * k;

  // Gravity / jump.
  if (p.onGround) {
    if (input.jump && p.stamina >= STA.staminaJumpCost) {
      p.vel.y = CONFIG.PLAYER.jumpVel;
      p.onGround = false;
      p.stamina -= STA.staminaJumpCost;
    }
  } else {
    p.vel.y += CONFIG.PHYSICS.gravity * dt;
  }

  // Apply locomotion + impulse to position. Impulse decays exponentially.
  p.pos.x += (p.vel.x + p.impulse.x) * dt;
  p.pos.y += (p.vel.y) * dt;
  p.pos.z += (p.vel.z + p.impulse.z) * dt;
  const decay = Math.exp(-dt * 6);   // half-life ~115ms
  p.impulse.x *= decay;
  p.impulse.z *= decay;
  if (Math.abs(p.impulse.x) < 0.05) p.impulse.x = 0;
  if (Math.abs(p.impulse.z) < 0.05) p.impulse.z = 0;

  if (p.pos.y <= 0) { p.pos.y = 0; p.vel.y = 0; p.onGround = true; }
  clampToArena(p.pos);

  p.swinging = !!input.swinging;
  p.blocking = canBlock;

  // Weapon tip in world space — client provides world coordinates.
  // Tip velocity for damage purposes EXCLUDES the player's own velocity (translation +
  // jump), so running or jumping doesn't look like a swing. A teleport-sized delta is
  // treated as zero velocity (post-respawn or initial frame).
  // While blocking, override the tip to a high-guard defensive position (arm raised
  // across the body, blade horizontal in front). Combines with sword-physics drag for
  // a visible "guard up" stance.
  if (canBlock && input.weaponTip) {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const rx =  Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    input = {
      ...input,
      weaponTip: {
        x: p.pos.x + fx * 0.7 + rx * 0.25,
        y: p.pos.y + 1.55,
        z: p.pos.z + fz * 0.7 + rz * 0.25,
      },
    };
  }

  if (input.weaponTip) {
    p.weaponTipPrev = p.weaponTip;
    // Clamp tip to plausible reach from player. Max = weapon length + 0.7m arm + 0.5m fudge.
    const w = CONFIG.WEAPONS[p.weaponKey] || CONFIG.WEAPONS[CONFIG.DEFAULT_WEAPON];
    const maxReach = w.length + 1.2;
    const tx = input.weaponTip.x - p.pos.x;
    const ty = input.weaponTip.y - (p.pos.y + 1.4);
    const tz = input.weaponTip.z - p.pos.z;
    const dr = Math.hypot(tx, ty, tz);
    if (dr > maxReach) {
      const k = maxReach / dr;
      p.weaponTip = { x: p.pos.x + tx * k, y: p.pos.y + 1.4 + ty * k, z: p.pos.z + tz * k };
    } else {
      p.weaponTip = { x: input.weaponTip.x, y: input.weaponTip.y, z: input.weaponTip.z };
    }
    const dx = p.weaponTip.x - p.weaponTipPrev.x;
    const dy = p.weaponTip.y - p.weaponTipPrev.y;
    const dz = p.weaponTip.z - p.weaponTipPrev.z;
    const teleport = (dx*dx + dy*dy + dz*dz) > 9;     // > 3m delta in one tick
    if (teleport) {
      p.weaponTipVel = { x: 0, y: 0, z: 0 };
    } else {
      const dtSafe = Math.max(dt, 1 / 240);
      p.weaponTipVel = {
        x: dx / dtSafe - p.vel.x,
        y: dy / dtSafe - p.vel.y,
        z: dz / dtSafe - p.vel.z,
      };
    }
  }

  if (typeof input.seq === "number") p.lastInputSeq = input.seq;
}

// Capsule endpoints for hit-testing.
export function playerCapsule(p) {
  const half = CONFIG.PLAYER.height / 2;
  const r = CONFIG.PLAYER.radius;
  const a = { x: p.pos.x, y: p.pos.y + r,            z: p.pos.z };
  const b = { x: p.pos.x, y: p.pos.y + 2 * half - r, z: p.pos.z };
  return { a, b, r };
}

// Weapon segment in world space: shoulder → tip.
export function weaponSegment(p) {
  // Shoulder approx: above pos by ~1.4m, slight right offset rotated by yaw.
  const sy = 1.4;
  const sx = 0.25 * Math.cos(p.yaw);
  const sz = -0.25 * Math.sin(p.yaw);
  const grip = { x: p.pos.x + sx, y: p.pos.y + sy, z: p.pos.z + sz };
  return { grip, tip: clone(p.weaponTip) };
}

export function killPlayer(p, nowMs) {
  p.alive = false;
  p.hp = 0;
  p.deadAtMs = nowMs;
  p.deaths++;
}

export function maybeRespawn(p, spawn, nowMs) {
  if (p.alive) return false;
  if (nowMs - p.deadAtMs < CONFIG.PLAYER.respawnMs) return false;
  p.pos = clone(spawn.pos);
  p.yaw = spawn.yaw;
  p.vel = v();
  p.impulse = v();
  p.hp = CONFIG.PLAYER.hp;
  p.stamina = CONFIG.PLAYER.stamina;
  p.helmIntact = true;
  p.crippledUntilMs = 0;
  p.stunUntilMs = 0;
  p.disarmedUntilMs = 0;
  p.knockedDownUntilMs = 0;
  p.severedLeg = false;
  p.bleedUntilMs = 0;
  p.bleedDmgPerSec = 0;
  p.bleedAccum = 0;
  p.alive = true;
  // Anti-spawn-camp: if we died very quickly after our last respawn, extend invuln by
  // 1.5s. Setting spawnedAtMs into the future stretches the (now - spawnedAtMs < window)
  // check, giving 3s effective invuln total.
  const justSpawnedRecently = p._lastSpawnedRealMs && (nowMs - p._lastSpawnedRealMs) < 3000;
  p._lastSpawnedRealMs = nowMs;
  p.spawnedAtMs = justSpawnedRecently ? (nowMs + 1500) : nowMs;
  p.lastHitAtMs.clear();
  p.parryUntilMs.clear();
  return true;
}
