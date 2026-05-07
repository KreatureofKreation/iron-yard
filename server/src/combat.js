import { CONFIG } from "./config.js";
import { segCapsuleHit, segSegDistSq, sub, len, norm, dot } from "./math.js";
import { playerCapsule, weaponSegment, killPlayer } from "./player.js";
import { weaponOf } from "./player.js";
import { pickBotTaunt } from "./bot.js";

// Resolve combat for the tick: parry/clashes first, then hits. Returns events.
export function resolveHits(players, nowMs) {
  const events = [];
  const arr = [...players.values()];

  // ---- Parry / clash detection ----
  // If two players' weapon segments are close AND both have tip speed > parrySpeedMin,
  // emit a clash event and put both on a brief outgoing cooldown by stamping lastHitAtMs entries.
  const clashCooldownMs = 250;
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (!a.alive) continue;
    const aSpeed = len(a.weaponTipVel);
    if (aSpeed < CONFIG.COMBAT.parrySpeedMin) continue;
    const aSeg = weaponSegment(a);
    for (let j = i + 1; j < arr.length; j++) {
      const b = arr[j];
      if (!b.alive) continue;
      const bSpeed = len(b.weaponTipVel);
      if (bSpeed < CONFIG.COMBAT.parrySpeedMin) continue;
      const bSeg = weaponSegment(b);
      const r = CONFIG.COMBAT.parryRadius;
      const { dSq } = segSegDistSq(aSeg.grip, aSeg.tip, bSeg.grip, bSeg.tip);
      if (dSq <= r * r) {
        // Clash. Both bounce; brief no-damage window (parryUntilMs), independent of weapon hit cooldown.
        const until = nowMs + clashCooldownMs;
        a.parryUntilMs.set(b.id, until);
        b.parryUntilMs.set(a.id, until);
        // Apply small impulse pushback so positions react.
        const ax = (aSeg.tip.x - bSeg.tip.x), az = (aSeg.tip.z - bSeg.tip.z);
        const m = Math.hypot(ax, az) || 1;
        const kb = 2.0;
        a.impulse.x += (ax / m) * kb;
        a.impulse.z += (az / m) * kb;
        b.impulse.x -= (ax / m) * kb;
        b.impulse.z -= (az / m) * kb;
        events.push({
          kind: "clash",
          a: a.id, b: b.id, speed: Math.max(aSpeed, bSpeed),
          at: { x: (aSeg.tip.x + bSeg.tip.x) / 2, y: (aSeg.tip.y + bSeg.tip.y) / 2, z: (aSeg.tip.z + bSeg.tip.z) / 2 },
        });
      }
    }
  }

  // ---- Damage resolution ----
  for (const a of arr) {
    if (!a.alive || a.blocking) continue;
    if (a.zombieUntilMs > nowMs) continue;
    if (nowMs - a.spawnedAtMs < CONFIG.PLAYER.spawnInvulnMs) continue;
    const w = weaponOf(a);
    const seg = weaponSegment(a);
    const tipSpeed = len(a.weaponTipVel);
    if (tipSpeed < w.minSpeed) continue;
    for (const t of arr) {
      if (t === a || !t.alive) continue;
      if (t.zombieUntilMs > nowMs) continue;
      if (nowMs - t.spawnedAtMs < CONFIG.PLAYER.spawnInvulnMs) continue;
      const last = a.lastHitAtMs.get(t.id) || 0;
      if (nowMs - last < w.hitCooldownMs) continue;
      const parryUntil = a.parryUntilMs.get(t.id) || 0;
      if (nowMs < parryUntil) continue;

      const cap = playerCapsule(t);
      const r = cap.r + w.edgeHalfWidth;
      const test = segCapsuleHit(seg.grip, seg.tip, cap.a, cap.b, r);
      if (!test.hit) continue;

      // Hit zone: test.t = parameter along target capsule axis (0 foot, 1 head).
      const segLen = cap.b.y - cap.a.y;
      const hitY = cap.a.y + segLen * test.t;
      let zoneMul = CONFIG.COMBAT.zone.torsoDamageMul;
      let zone = "torso";
      if (test.t > 0.85)      { zoneMul = CONFIG.COMBAT.zone.headDamageMul; zone = "head"; }
      else if (test.t < 0.45) { zoneMul = CONFIG.COMBAT.zone.legsDamageMul; zone = "legs"; }

      // Damage formula.
      const massFactor = 0.6 + w.mass * 0.4;
      let dmg = (tipSpeed - w.minSpeed) * w.speedScale * massFactor;
      // Exhausted attackers swing weakly.
      if (a.stamina <= 5) dmg *= CONFIG.PLAYER.exhaustedDamageMul;
      // Spear thrust bonus: if tip motion direction is mostly along its own segment direction → bonus.
      if (w.thrustBonus) {
        const swordDir = norm(sub(seg.tip, seg.grip));
        const tipVdir  = norm(a.weaponTipVel);
        const align = Math.max(0, dot(swordDir, tipVdir));
        dmg *= (1 + align * 0.4);
      }
      dmg *= zoneMul;
      // Floor only meaningful contacts; tiny brushes deal nothing.
      if (dmg < w.minDmg * 0.5) continue;
      dmg = Math.max(w.minDmg, Math.min(w.maxDmg, dmg));

      // Block reduction.
      if (t.blocking) {
        const toAttacker = norm(sub(a.pos, t.pos));
        const targetForward = { x: -Math.sin(t.yaw), y: 0, z: -Math.cos(t.yaw) };
        const facing = dot(toAttacker, targetForward);
        let red = facing > 0.5 ? CONFIG.COMBAT.blockReductionFront
              : facing > 0    ? CONFIG.COMBAT.blockReductionSide
              : 0;
        if (w.blunt) red = Math.max(0, red - CONFIG.COMBAT.bluntBlockPenalty);
        dmg *= (1 - red);
      }

      dmg = Math.round(dmg);
      if (dmg <= 0) continue;

      // Helmet save: first lethal headshot is reduced to leave the victim alive (HP 5–15)
      // and the helm breaks. Subsequent head hits go through normally.
      let helmBroken = false;
      if (zone === "head" && t.helmIntact && dmg >= t.hp) {
        const survival = 5 + Math.floor(Math.random() * 11);
        dmg = Math.max(1, t.hp - survival);
        t.helmIntact = false;
        helmBroken = true;
      }

      t.hp = Math.max(0, t.hp - dmg);
      a.lastHitAtMs.set(t.id, nowMs);
      // Each successful big-swing event costs stamina.
      a.stamina = Math.max(0, a.stamina - CONFIG.PLAYER.staminaSwingCost);

      // Knockback as external impulse (decays separately so it isn't overwritten by movement).
      const kb = norm(sub(t.pos, a.pos));
      const kbMag = 2.5 + (zone === "head" ? 1.5 : 0.5) + tipSpeed * 0.10;
      t.impulse.x += kb.x * kbMag;
      t.impulse.z += kb.z * kbMag;
      // Leg hit cripples for 3s — slows movement and shows limp.
      if (zone === "legs") {
        t.vel.x *= 0.4; t.vel.z *= 0.4;
        t.crippledUntilMs = nowMs + 3000;
      }

      // Damage-type effects (computed; written into event below after it's built).
      const dmgType = w.damageType || "slash";
      let stunMsApplied = 0, bleedTotalApplied = 0;
      if (dmgType === "blunt") {
        const stunChance = Math.min(0.85, 0.20 + dmg * 0.012);
        if (Math.random() < stunChance) {
          stunMsApplied = (zone === "head" ? 2200 : 1400) + Math.min(600, dmg * 8);
          t.stunUntilMs = Math.max(t.stunUntilMs, nowMs + stunMsApplied);
        }
      } else if (dmgType === "slash" || dmgType === "pierce") {
        bleedTotalApplied = Math.max(3, Math.round(dmg * (dmgType === "pierce" ? 0.55 : 0.35)));
        const durMs = dmgType === "pierce" ? 4500 : 4000;
        t.bleedDmgPerSec = Math.max(t.bleedDmgPerSec, bleedTotalApplied / (durMs / 1000));
        t.bleedUntilMs = Math.max(t.bleedUntilMs, nowMs + durMs);
      }

      const event = {
        kind: "hit",
        from: a.id, to: t.id, dmg, speed: tipSpeed, zone, weapon: w.key,
        damageType: dmgType,
        at: { x: (seg.tip.x + cap.a.x) / 2, y: hitY, z: (seg.tip.z + cap.a.z) / 2 },
      };
      if (helmBroken) event.helmBreak = true;
      if (stunMsApplied)     event.stun  = stunMsApplied;
      if (bleedTotalApplied) event.bleed = bleedTotalApplied;
      if (t.hp <= 0) {
        killPlayer(t, nowMs);
        a.score++;
        a.killStreak = (a.killStreak || 0) + 1;
        t.killStreak = 0;
        event.kill = true;
        event.attackerStreak = a.killStreak;
        if (a.killStreak === 3 || a.killStreak === 5 || a.killStreak === 7 || a.killStreak >= 10) {
          events.push({ kind: "streak", id: a.id, count: a.killStreak });
        }
        // Bot taunt on kill (low chance to avoid spam).
        if (a.bot && Math.random() < 0.5) {
          events.push({ kind: "chat", from: a.id, name: a.name, text: pickBotTaunt() });
        }
      }
      events.push(event);
    }
  }
  return events;
}
