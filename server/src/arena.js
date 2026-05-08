import { CONFIG } from "./config.js";

// 4 corner spawns inside the arena, facing center.
export function spawnPoints() {
  const s = CONFIG.ARENA.size / 2 - 2;
  return [
    { pos: { x: -s, y: 0, z: -s }, yaw: Math.PI * 0.25 },
    { pos: { x:  s, y: 0, z: -s }, yaw: -Math.PI * 0.25 },
    { pos: { x:  s, y: 0, z:  s }, yaw: -Math.PI * 0.75 },
    { pos: { x: -s, y: 0, z:  s }, yaw:  Math.PI * 0.75 },
  ];
}

// Weapon pickup racks — fixed positions around the arena, one weapon per rack.
// Walking onto a rack swaps the player's current weapon for the rack's, refreshing only
// the weapon's stock (the rack always offers the same weapon at that position).
export function weaponRacks() {
  return [
    { x: -10, z:  0, weapon: "longsword" },
    { x:  10, z:  0, weapon: "mace" },
    { x:  0,  z: -10, weapon: "spear" },
    { x:  0,  z:  10, weapon: "arming" },
  ];
}

// No pillars — open arena. Kept the function for compatibility (callers iterate it).
export function obstacles() {
  return [];
}

// Clamp position to arena floor and walls + push out of pillars.
export function clampToArena(pos) {
  const half = CONFIG.ARENA.size / 2 - CONFIG.PLAYER.radius;
  if (pos.x < -half) pos.x = -half;
  if (pos.x >  half) pos.x =  half;
  if (pos.z < -half) pos.z = -half;
  if (pos.z >  half) pos.z =  half;
  for (const o of obstacles()) {
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;
    const px = o.hx + CONFIG.PLAYER.radius - Math.abs(dx);
    const pz = o.hz + CONFIG.PLAYER.radius - Math.abs(dz);
    if (px > 0 && pz > 0) {
      // Push along smaller penetration axis.
      if (px < pz) pos.x += dx >= 0 ? px : -px;
      else         pos.z += dz >= 0 ? pz : -pz;
    }
  }
  if (pos.y < 0) pos.y = 0;
}
