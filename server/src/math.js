// Tiny vec3 + segment-vs-capsule helpers. No external dep.

export const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const clone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const lenSq = (a) => dot(a, a);
export const len = (a) => Math.sqrt(lenSq(a));
export const norm = (a) => {
  const l = len(a);
  return l > 1e-8 ? scale(a, 1 / l) : v(0, 0, 0);
};
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Closest distance squared between two 3D segments (p1-q1) and (p2-q2).
// Returns { dSq, s, t } where points are p1+s*(q1-p1), p2+t*(q2-p2).
export function segSegDistSq(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s, t;
  const EPS = 1e-8;
  if (a <= EPS && e <= EPS) {
    return { dSq: lenSq(r), s: 0, t: 0 };
  }
  if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = clamp((b * f - c * e) / denom, 0, 1);
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const c1 = add(p1, scale(d1, s));
  const c2 = add(p2, scale(d2, t));
  return { dSq: lenSq(sub(c1, c2)), s, t };
}

// Segment-vs-capsule intersection test (capsule = segment + radius).
export function segCapsuleHit(segA, segB, capA, capB, capRadius, expand = 0) {
  const r = capRadius + expand;
  const { dSq, s, t } = segSegDistSq(segA, segB, capA, capB);
  return { hit: dSq <= r * r, dSq, s, t };
}

// Yaw (radians) of a direction vec on XZ plane. 0 = +Z, increases CCW toward -X.
// Used for facing checks.
export function yawFromDir(d) {
  return Math.atan2(-d.x, d.z); // matches three.js convention with up=+Y
}
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
