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

// Static AABB obstacles (pillars) — server clamps players against these.
export function obstacles() {
  // Four pillars near center for cover.
  const r = 0.6;
  return [
    { x: -4, z: -4, hx: r, hz: r },
    { x:  4, z: -4, hx: r, hz: r },
    { x:  4, z:  4, hx: r, hz: r },
    { x: -4, z:  4, hx: r, hz: r },
  ];
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
