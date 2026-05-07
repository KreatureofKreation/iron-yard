import * as THREE from "three";
import { RUNTIME } from "./config.js";

// Stylized humanoid. Right arm is `weaponRig` and is what we orient toward weapon tip.
// Includes legs/arms that we bob during walk + idle sway.
export function buildCharacter({ color = 0x9aa0a8, accent = 0xc8a97e, isLocal = false, weaponKey = "arming" } = {}) {
  const root = new THREE.Group();
  root.name = "character";

  const skinMat  = new THREE.MeshStandardMaterial({ color: 0xc8997a, roughness: 0.9 });
  const armorMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.4 });
  const cloakMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.85 });
  const gripMat  = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95 });

  const radius = RUNTIME.player.radius;
  const height = RUNTIME.player.height;

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.85, radius * 0.7, height * 0.42, 12), armorMat);
  torso.position.y = height * 0.55; torso.castShadow = true; root.add(torso);

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, 0.06, 16), gripMat);
  belt.position.y = height * 0.40; root.add(belt);

  const hips = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.7, radius * 0.6, height * 0.18, 10), armorMat);
  hips.position.y = height * 0.31; hips.castShadow = true; root.add(hips);

  const cloak = new THREE.Mesh(new THREE.ConeGeometry(radius * 1.1, height * 0.45, 8, 1, true), cloakMat);
  cloak.position.y = height * 0.42; cloak.material.side = THREE.DoubleSide; root.add(cloak);

  const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.55, 14, 12), skinMat);
  head.position.y = height * 0.86; head.castShadow = true; root.add(head);

  const helm = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.6, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), armorMat);
  helm.position.y = height * 0.92; root.add(helm);

  // Legs — pivoted at hips for swing.
  const legPivotY = height * 0.39;
  const legGeo = new THREE.CylinderGeometry(radius * 0.28, radius * 0.22, height * 0.42, 10);
  const legL = new THREE.Group(); legL.position.set(-radius * 0.32, legPivotY, 0);
  const legR = new THREE.Group(); legR.position.set( radius * 0.32, legPivotY, 0);
  const legLMesh = new THREE.Mesh(legGeo, gripMat); legLMesh.position.y = -height * 0.21; legLMesh.castShadow = true;
  const legRMesh = new THREE.Mesh(legGeo, gripMat); legRMesh.position.y = -height * 0.21; legRMesh.castShadow = true;
  legL.add(legLMesh); legR.add(legRMesh);
  root.add(legL, legR);

  // Left arm pivoted at shoulder.
  const armPivotY = height * 0.78;
  const armGeo = new THREE.CylinderGeometry(radius * 0.22, radius * 0.20, height * 0.4, 10);
  const armL = new THREE.Group(); armL.position.set(-radius * 0.85, armPivotY, 0);
  const armLMesh = new THREE.Mesh(armGeo, armorMat); armLMesh.position.y = -height * 0.20; armLMesh.castShadow = true;
  armL.add(armLMesh);
  root.add(armL);

  // Right arm: shoulder pivot → upper-arm → elbow pivot → forearm → hand → sword.
  // We orient the SHOULDER (weaponRig) toward the world-space tip (poseRig handles that)
  // and the elbow bends procedurally based on chain length so the limb looks alive.
  const weaponRig = new THREE.Group();
  weaponRig.name = "weaponRig";
  weaponRig.position.set(radius * 0.85, armPivotY, 0);
  root.add(weaponRig);

  // Upper arm — shorter than before; positioned to extend down from the shoulder.
  const upperArmLen = height * 0.20;
  const upperArmGeo = new THREE.CylinderGeometry(radius * 0.22, radius * 0.20, upperArmLen, 10);
  const upperArm = new THREE.Mesh(upperArmGeo, armorMat);
  upperArm.position.set(0, -upperArmLen / 2, 0);
  upperArm.castShadow = true;
  weaponRig.add(upperArm);

  // Elbow pivot at end of upper arm. Forearm extends from here.
  const elbow = new THREE.Group();
  elbow.position.set(0, -upperArmLen, 0);
  weaponRig.add(elbow);

  const forearmLen = height * 0.22;
  const forearmGeo = new THREE.CylinderGeometry(radius * 0.20, radius * 0.18, forearmLen, 10);
  const forearm = new THREE.Mesh(forearmGeo, armorMat);
  forearm.position.set(0, -forearmLen / 2, 0);
  forearm.castShadow = true;
  elbow.add(forearm);

  // Hand at the end of the forearm.
  const hand = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.32, radius * 0.22, radius * 0.32), skinMat);
  hand.position.set(0, -forearmLen, 0);
  elbow.add(hand);

  // Static elbow bend so the arm doesn't render as a perfectly straight pole.
  // Rotation around X gives a forward bend (elbow folds the forearm forward).
  elbow.rotation.x = 0.35;

  // Weapon — visual scaled to match weaponKey length and shape. Parented to weaponRig
  // (not the elbow) so the existing poseRig orientation still works; the elbow bend is
  // purely for the forearm cylinder's appearance.
  const sword = buildWeaponMesh(weaponKey);
  sword.position.set(0, -(upperArmLen + forearmLen), 0);
  sword.rotation.x = -Math.PI / 2;
  weaponRig.add(sword);

  // Tip helper.
  const tipNode = new THREE.Object3D();
  const w = WEAPON_VISUAL[weaponKey] ?? WEAPON_VISUAL.arming;
  tipNode.position.y = w.gripLen + w.bladeLen;
  sword.add(tipNode);

  // Trail: ribbon of recent tip world positions (drawn as a Line strip). Color by weapon.
  const TRAIL_COLOR = {
    arming:    0xfff0c0,   // pale gold (slash)
    longsword: 0xfff0c0,   // pale gold (slash)
    mace:      0xff9050,   // orange (blunt)
    spear:     0xa8e6ff,   // pale blue (pierce)
  }[weaponKey] ?? 0xfff0c0;
  const TRAIL_LEN = 14;
  const trailPts = new Float32Array(TRAIL_LEN * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPts, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({ color: TRAIL_COLOR, transparent: true, opacity: 0 });
  const trail = new THREE.Line(trailGeo, trailMat);
  trail.frustumCulled = false;

  if (isLocal) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.7, 32),
      new THREE.MeshBasicMaterial({ color: 0xc8a97e, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
    root.add(ring);
  }

  // Accumulators for procedural anim.
  const anim = { walkPhase: 0, swayPhase: 0, recoilT: 0 };

  // Trail lives in world space (parented to root, but updated per-frame from world tip pos).
  root.add(trail);

  // Trail update buffer state.
  const trailState = { count: 0, idx: 0, lastTipWorld: new THREE.Vector3() };

  return {
    root, weaponRig, sword, tipNode, trail, trailGeo, trailMat, trailPts, trailState,
    parts: { torso, head, helm, legL, legR, armL, weaponRig, hips, cloak },
    /**
     * Per-frame animation update.
     * mvSpeed: 0..~7 (m/s). swinging boolean. dt seconds. blocking boolean.
     */
    animate(dt, { mvSpeed = 0, swinging = false, blocking = false, alive = true, swingLat = 0, swingFwd = 0, crippled = false, stunned = false, verAim = 0, tipDist = 0 } = {}) {
      // Shoulder lift on high stance — raises the arm's anchor when aim points up.
      const lift = Math.max(-0.05, Math.min(0.20, verAim * 0.18));
      weaponRig.position.y = armPivotY + lift;
      // Dynamic elbow bend (two-bone IK approx): the closer the tip is to the shoulder,
      // the more the elbow folds. Static base 0.20 keeps a baseline kink even at full reach.
      const totalReach = upperArmLen + forearmLen;
      const chord = Math.min(Math.max(tipDist || 0, 0.02), totalReach);
      // acos(chord / totalReach) is 0 at full reach, π/2 at zero — gives a natural fold.
      const ratio = chord / totalReach;
      const bend = Math.acos(Math.max(-1, Math.min(1, ratio)));
      elbow.rotation.x = 0.20 + bend * 0.55;
      anim.swayPhase += dt;
      if (alive) {
        const stride = THREE.MathUtils.clamp(mvSpeed / 5, 0, 1);
        anim.walkPhase += dt * (4 + mvSpeed * 1.2) * stride;
        const phase = anim.walkPhase;
        legL.rotation.x =  Math.sin(phase) * 0.7 * stride;
        legR.rotation.x = -Math.sin(phase) * 0.7 * stride;
        armL.rotation.x = -Math.sin(phase) * 0.5 * stride;
        if (crippled) {
          legR.rotation.x = Math.max(-0.2, legR.rotation.x);
          legR.rotation.z = 0.25;
          torso.rotation.z += 0.10;
        } else {
          legR.rotation.z = 0;
        }
        if (stunned) {
          // Wobble: jelly torso, drooped arms, legs spread.
          const wob = Math.sin(anim.swayPhase * 6.0) * 0.18;
          torso.rotation.z += wob;
          torso.rotation.x += Math.sin(anim.swayPhase * 5.0) * 0.10;
          armL.rotation.x = 0;
          legL.rotation.x = 0;
          legR.rotation.x = 0;
          legL.rotation.z = -0.15;
          legR.rotation.z =  0.15;
        } else {
          legL.rotation.z = 0;
        }
        // Idle torso sway + body lean from swing motion (limb weight).
        const idleSway = Math.sin(anim.swayPhase * 1.2) * 0.02;
        // Smooth lean values (state stored in anim).
        anim.leanZ = (anim.leanZ || 0) + (THREE.MathUtils.clamp(swingLat * 0.06, -0.3, 0.3) - (anim.leanZ || 0)) * Math.min(1, dt * 12);
        anim.leanX = (anim.leanX || 0) + (THREE.MathUtils.clamp(swingFwd * 0.04, -0.25, 0.25) - (anim.leanX || 0)) * Math.min(1, dt * 12);
        torso.rotation.z = idleSway + anim.leanZ;
        torso.rotation.x = anim.leanX;
        torso.position.y = height * 0.55 + Math.sin(phase * 2) * 0.02 * stride;
        // Hips counter-rotate slightly for follow-through feel.
        hips.rotation.y = -anim.leanZ * 0.6;
        // Block stance — slight hunch.
        if (blocking) {
          torso.rotation.x += 0.10;
          armL.rotation.x = 0.6;        // shield up
        }
      } else {
        // Death pose — slumped.
        anim.recoilT = Math.min(1, (anim.recoilT || 0) + dt * 4);
        const k = anim.recoilT;
        legL.rotation.x = -1.1 * k;
        legR.rotation.x = -0.9 * k;
        armL.rotation.x =  0.4 * k;
        torso.rotation.x = -0.9 * k;
      }
    },
    setLean(x, z) { torso.rotation.z = x * 0.15; torso.rotation.x = z * 0.15; },
    // Push tip world position into trail. tipSpeed scales opacity.
    pushTrail(tipWorld, tipSpeed = 0) {
      // Convert tip from world to root-local space (root is the character group).
      const local = tipWorld.clone();
      root.worldToLocal(local);
      const len = trailPts.length / 3;
      // Shift all points back by 1 (newest at start).
      for (let i = (trailState.count >= len ? len - 1 : trailState.count); i > 0; i--) {
        trailPts[i*3+0] = trailPts[(i-1)*3+0];
        trailPts[i*3+1] = trailPts[(i-1)*3+1];
        trailPts[i*3+2] = trailPts[(i-1)*3+2];
      }
      trailPts[0] = local.x; trailPts[1] = local.y; trailPts[2] = local.z;
      if (trailState.count < len) trailState.count++;
      trailGeo.setDrawRange(0, trailState.count);
      trailGeo.attributes.position.needsUpdate = true;
      // Opacity from tip speed.
      const o = Math.max(0, Math.min(0.85, (tipSpeed - 4) / 16));
      trailMat.opacity = o;
    },
    // Apply pulsing translucency for spawn invulnerability.
    setInvuln(active, t) {
      const pulse = active ? (0.4 + 0.4 * Math.abs(Math.sin(t * 10))) : 1.0;
      const transparent = active;
      // Note: armL/legL/legR are Groups (pivots) — pass their child Meshes instead.
      for (const m of [torso, head, helm, hips, cloak, armLMesh, upperArm, forearm, legLMesh, legRMesh, hand]) {
        if (!m || !m.material) continue;
        m.material.transparent = transparent;
        m.material.opacity = pulse;
      }
    },
  };
}

// Visual proportions tuned to look chunky/readable at the third-person camera distance.
// blade thickness/width pumped up vs. realism for clarity on screen.
const WEAPON_VISUAL = {
  arming:    { gripLen: 0.20, bladeLen: 0.95, bladeW: 0.075, bladeT: 0.022, guardW: 0.30, head: "blade", color: 0xdfe5ee },
  longsword: { gripLen: 0.34, bladeLen: 1.05, bladeW: 0.075, bladeT: 0.024, guardW: 0.36, head: "blade", color: 0xdfe5ee },
  mace:      { gripLen: 0.60, bladeLen: 0.28, bladeW: 0.14,  bladeT: 0.14,  guardW: 0.12, head: "ball",  color: 0x9a7a3a },
  spear:     { gripLen: 1.90, bladeLen: 0.28, bladeW: 0.05,  bladeT: 0.05,  guardW: 0.0,  head: "spear", color: 0xdfe5ee },
};

function buildWeaponMesh(key) {
  const w = WEAPON_VISUAL[key] ?? WEAPON_VISUAL.arming;
  const sword = new THREE.Group();
  sword.name = key;

  const bladeMat = new THREE.MeshStandardMaterial({ color: w.color, metalness: 0.85, roughness: 0.25 });
  const gripMat  = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95 });
  const guardMat = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, metalness: 0.7, roughness: 0.4 });

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, w.gripLen, 8), gripMat);
  grip.position.y = w.gripLen / 2;
  sword.add(grip);

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), guardMat);
  pommel.position.y = 0;
  sword.add(pommel);

  if (w.guardW > 0) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(w.guardW, 0.025, 0.04), guardMat);
    guard.position.y = w.gripLen;
    sword.add(guard);
  }

  if (w.head === "blade") {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(w.bladeW, w.bladeLen, w.bladeT), bladeMat);
    blade.position.y = w.gripLen + w.bladeLen / 2;
    sword.add(blade);
  } else if (w.head === "ball") {
    const ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(w.bladeW, 1),
      new THREE.MeshStandardMaterial({ color: w.color, metalness: 0.4, roughness: 0.6 }),
    );
    ball.position.y = w.gripLen + w.bladeW;
    sword.add(ball);
    // Spikes.
    const spikeMat = new THREE.MeshStandardMaterial({ color: 0xbcc1cc, metalness: 0.7, roughness: 0.3 });
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 4), spikeMat);
      const a = i / 8 * Math.PI * 2;
      s.position.set(Math.cos(a) * w.bladeW, w.gripLen + w.bladeW, Math.sin(a) * w.bladeW);
      s.lookAt(s.position.x * 2, s.position.y, s.position.z * 2);
      sword.add(s);
    }
  } else if (w.head === "spear") {
    // Long shaft already as "grip"; tip is a cone.
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, w.bladeLen, 8), bladeMat);
    tip.position.y = w.gripLen + w.bladeLen / 2;
    sword.add(tip);
  }

  return sword;
}

export const WEAPON_LIST = ["arming", "longsword", "mace", "spear"];
