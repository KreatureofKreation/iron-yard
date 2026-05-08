import * as THREE from "three";
import { RUNTIME } from "./config.js";

// Half-Sword-inspired humanoid: realistic proportions with chunky plate armor.
// Limbs are multi-segment (upper + lower + hand/foot) so knees and elbows bend.
//
// External interface (must stay stable for main.js + ragdoll handoff):
//   { root, weaponRig, sword, tipNode, trail, trailGeo, trailMat, trailPts, trailState,
//     parts: { torso, head, helm, legL, legR, armL, weaponRig, hips },
//     animate(...), setLean(...), setSeveredLeg(...), pushTrail(...), setInvuln(...) }
export function buildCharacter({ color = 0x9aa0a8, accent = 0xc8a97e, isLocal = false, weaponKey = "arming", grip = "one-hand" } = {}) {
  const root = new THREE.Group();
  root.name = "character";

  const skinMat   = new THREE.MeshStandardMaterial({ color: 0xc8997a, roughness: 0.9 });
  const plateMat  = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.55 });
  const platePale = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.45 });
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95 });
  const mailMat   = new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.55, metalness: 0.7 });
  const goldMat   = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, metalness: 0.7, roughness: 0.4 });

  const radius = RUNTIME.player.radius;
  const height = RUNTIME.player.height;

  // Anatomical landmarks (in world-Y from feet at y=0).
  const Y_HIP        = height * 0.50;     // pelvis center
  const Y_PELVIS_TOP = height * 0.55;
  const Y_ABDOMEN    = height * 0.62;
  const Y_CHEST      = height * 0.72;
  const Y_SHOULDER   = height * 0.83;
  const Y_NECK       = height * 0.92;
  const Y_HEAD       = height * 0.98;
  // Limb segment lengths.
  const UPPER_ARM_LEN = height * 0.20;
  const FOREARM_LEN   = height * 0.22;
  const THIGH_LEN     = height * 0.25;
  const SHIN_LEN      = height * 0.23;

  // ---------- Pelvis + legs ----------
  const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.78, radius * 0.62, height * 0.13, 14), plateMat);
  pelvis.position.y = Y_PELVIS_TOP - height * 0.065;
  pelvis.castShadow = true; root.add(pelvis);
  // Tassets — small plate skirt
  const tassetMat = plateMat;
  const tassetGeo = new THREE.BoxGeometry(radius * 0.42, height * 0.10, 0.06);
  const tassetF = new THREE.Mesh(tassetGeo, tassetMat); tassetF.position.set(0, Y_PELVIS_TOP - height * 0.10, radius * 0.55); tassetF.castShadow = true; root.add(tassetF);
  const tassetB = new THREE.Mesh(tassetGeo, tassetMat); tassetB.position.set(0, Y_PELVIS_TOP - height * 0.10, -radius * 0.55); tassetB.castShadow = true; root.add(tassetB);
  const tassetL = new THREE.Mesh(new THREE.BoxGeometry(0.06, height * 0.10, radius * 0.42), tassetMat); tassetL.position.set(-radius * 0.55, Y_PELVIS_TOP - height * 0.10, 0); tassetL.castShadow = true; root.add(tassetL);
  const tassetR = new THREE.Mesh(new THREE.BoxGeometry(0.06, height * 0.10, radius * 0.42), tassetMat); tassetR.position.set( radius * 0.55, Y_PELVIS_TOP - height * 0.10, 0); tassetR.castShadow = true; root.add(tassetR);

  function buildLeg(side) {
    const sx = side === "L" ? -1 : 1;
    const thigh = new THREE.Group();
    thigh.position.set(sx * radius * 0.30, Y_HIP - height * 0.02, 0);
    // Thigh mesh — tapered cylinder hanging down from hip pivot.
    const thighMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.28, radius * 0.24, THIGH_LEN, 12),
      mailMat,
    );
    thighMesh.position.y = -THIGH_LEN / 2;
    thighMesh.castShadow = true; thigh.add(thighMesh);
    // Knee cuirass plate (cop)
    const knee = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.25, 1), plateMat);
    knee.position.y = -THIGH_LEN;
    knee.castShadow = true; thigh.add(knee);
    // Shin (group at knee pivot).
    const shin = new THREE.Group();
    shin.position.y = -THIGH_LEN;
    thigh.add(shin);
    const shinMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.22, radius * 0.16, SHIN_LEN, 12),
      plateMat,
    );
    shinMesh.position.y = -SHIN_LEN / 2;
    shinMesh.castShadow = true; shin.add(shinMesh);
    // Foot — boot, slightly forward of shin axis.
    const foot = new THREE.Group();
    foot.position.y = -SHIN_LEN;
    shin.add(foot);
    const footMesh = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 0.42, radius * 0.18, radius * 0.62),
      leatherMat,
    );
    footMesh.position.set(0, -radius * 0.05, radius * 0.10);
    footMesh.castShadow = true; foot.add(footMesh);

    return { thigh, shin, foot };
  }
  const legL = buildLeg("L");
  const legR = buildLeg("R");
  root.add(legL.thigh, legR.thigh);

  // ---------- Torso (chest + abdomen + back) ----------
  const abdomen = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.78, height * 0.12, 14), mailMat);
  abdomen.position.y = Y_ABDOMEN; abdomen.castShadow = true; root.add(abdomen);
  // Chest plate — slightly taller cylinder, wider at top
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.92, radius * 0.74, height * 0.28, 14),
    plateMat,
  );
  torso.position.y = Y_CHEST + height * 0.02;
  torso.castShadow = true; root.add(torso);
  // V-shape gorget detail under neck
  const gorget = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.42, radius * 0.55, height * 0.06, 14), platePale);
  gorget.position.y = Y_SHOULDER - height * 0.03;
  root.add(gorget);

  // (cloak removed — looked like a spike when seen from front)

  // Pauldrons (shoulder caps).
  const pauldronGeo = new THREE.SphereGeometry(radius * 0.42, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const pauldronL = new THREE.Mesh(pauldronGeo, plateMat);
  pauldronL.position.set(-radius * 0.95, Y_SHOULDER + radius * 0.05, 0);
  pauldronL.rotation.z = 0.15; pauldronL.castShadow = true; root.add(pauldronL);
  const pauldronR = new THREE.Mesh(pauldronGeo, plateMat);
  pauldronR.position.set( radius * 0.95, Y_SHOULDER + radius * 0.05, 0);
  pauldronR.rotation.z = -0.15; pauldronR.castShadow = true; root.add(pauldronR);

  // ---------- Head + helm ----------
  // Neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.24, radius * 0.27, height * 0.07, 10), skinMat);
  neck.position.y = Y_NECK - height * 0.025; root.add(neck);
  // Head sphere
  const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.50, 16, 14), skinMat);
  head.position.y = Y_HEAD;
  head.castShadow = true; root.add(head);
  // Helm group — barbute style: dome + visor face plate
  const helm = new THREE.Group();
  helm.position.y = Y_HEAD;
  root.add(helm);
  const helmDome = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.58, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    plateMat,
  );
  helmDome.position.y = 0;
  helmDome.castShadow = true; helm.add(helmDome);
  // Visor / face guard — flat front plate with narrow eye slit
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 0.85, radius * 0.55, radius * 0.05),
    plateMat,
  );
  visor.position.set(0, -radius * 0.05, -radius * 0.45);
  visor.castShadow = true; helm.add(visor);
  // Eye slit (cuts through visor visually — just a darker thin box overlay)
  const slit = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 0.55, radius * 0.06, radius * 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1 }),
  );
  slit.position.set(0, radius * 0.10, -radius * 0.48);
  helm.add(slit);
  // Helm rim trim
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.56, 0.012, 6, 24),
    goldMat,
  );
  rim.rotation.x = Math.PI / 2; rim.position.y = -radius * 0.03;
  helm.add(rim);

  // ---------- Left arm (with shield variant) ----------
  // Two-bone shoulder pivot. The whole assembly is parented to a single group
  // (`armL`) so we can preserve the rig.parts.armL interface for animate().
  const armL = new THREE.Group();
  armL.position.set(-radius * 0.95, Y_SHOULDER, 0);
  root.add(armL);
  const upperArmLMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.22, radius * 0.20, UPPER_ARM_LEN, 10),
    mailMat,
  );
  upperArmLMesh.position.y = -UPPER_ARM_LEN / 2;
  upperArmLMesh.castShadow = true;
  armL.add(upperArmLMesh);
  // Couter / elbow plate
  const couterL = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.22, 1), plateMat);
  couterL.position.y = -UPPER_ARM_LEN;
  armL.add(couterL);
  const elbowL = new THREE.Group();
  elbowL.position.y = -UPPER_ARM_LEN;
  armL.add(elbowL);
  const forearmLMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.20, radius * 0.18, FOREARM_LEN, 10),
    plateMat,
  );
  forearmLMesh.position.y = -FOREARM_LEN / 2;
  forearmLMesh.castShadow = true;
  elbowL.add(forearmLMesh);
  // Gauntlet hand (left)
  const handLMesh = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.30, radius * 0.22, radius * 0.32), plateMat);
  handLMesh.position.y = -FOREARM_LEN - radius * 0.05;
  elbowL.add(handLMesh);
  // Default: slight elbow bend for natural rest pose.
  elbowL.rotation.x = 0.30;

  // Optional shield on left forearm.
  let shieldMesh = null;
  if (grip === "shield") {
    const shMat = new THREE.MeshStandardMaterial({ color: 0x553a22, roughness: 0.85, metalness: 0.2 });
    shieldMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.06, 18), shMat);
    shieldMesh.rotation.x = Math.PI / 2;
    shieldMesh.position.set(-0.05, -FOREARM_LEN, -0.20);
    shieldMesh.castShadow = true;
    elbowL.add(shieldMesh);
    const shRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.36, 0.025, 8, 24),
      goldMat,
    );
    shRim.rotation.x = Math.PI / 2;
    shRim.position.copy(shieldMesh.position);
    elbowL.add(shRim);
    const boss = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.10, 1),
      new THREE.MeshStandardMaterial({ color: 0xbcc1cc, metalness: 0.7, roughness: 0.4 }),
    );
    boss.position.copy(shieldMesh.position);
    boss.position.z -= 0.04;
    elbowL.add(boss);
  }

  // ---------- Right arm (weapon-bearing) ----------
  const weaponRig = new THREE.Group();
  weaponRig.name = "weaponRig";
  weaponRig.position.set(radius * 0.95, Y_SHOULDER, 0);
  root.add(weaponRig);

  const upperArmRMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.22, radius * 0.20, UPPER_ARM_LEN, 10),
    mailMat,
  );
  upperArmRMesh.position.y = -UPPER_ARM_LEN / 2;
  upperArmRMesh.castShadow = true;
  weaponRig.add(upperArmRMesh);
  const couterR = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.22, 1), plateMat);
  couterR.position.y = -UPPER_ARM_LEN;
  weaponRig.add(couterR);

  const elbowR = new THREE.Group();
  elbowR.position.y = -UPPER_ARM_LEN;
  weaponRig.add(elbowR);

  const forearmRMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.20, radius * 0.18, FOREARM_LEN, 10),
    plateMat,
  );
  forearmRMesh.position.y = -FOREARM_LEN / 2;
  forearmRMesh.castShadow = true;
  elbowR.add(forearmRMesh);

  // Gauntlet hand (right) — visible grip on the sword
  const handRMesh = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.32, radius * 0.24, radius * 0.34), plateMat);
  handRMesh.position.y = -FOREARM_LEN - radius * 0.06;
  elbowR.add(handRMesh);

  // Static elbow bend so the arm doesn't render as a perfectly straight pole.
  elbowR.rotation.x = 0.35;

  // Weapon — visual scaled to match weaponKey length and shape. Parented to weaponRig
  // so the existing poseRig orientation still works. Sword tip is along weaponRig's
  // local -Y. Spawn the sword group hanging below the right hand.
  const sword = buildWeaponMesh(weaponKey);
  sword.position.set(0, -(UPPER_ARM_LEN + FOREARM_LEN), 0);
  sword.rotation.x = -Math.PI / 2;
  weaponRig.add(sword);

  // Tip helper.
  const tipNode = new THREE.Object3D();
  const w = WEAPON_VISUAL[weaponKey] ?? WEAPON_VISUAL.arming;
  tipNode.position.y = w.gripLen + w.bladeLen;
  sword.add(tipNode);

  // ---------- Trail ----------
  const TRAIL_COLOR = {
    arming:    0xfff0c0,
    longsword: 0xfff0c0,
    mace:      0xff9050,
    spear:     0xa8e6ff,
    swordshield:0xfff0c0,
  }[weaponKey] ?? 0xfff0c0;
  const TRAIL_LEN = 14;
  const trailPts = new Float32Array(TRAIL_LEN * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPts, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({ color: TRAIL_COLOR, transparent: true, opacity: 0 });
  const trail = new THREE.Line(trailGeo, trailMat);
  trail.frustumCulled = false;
  root.add(trail);

  if (isLocal) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.7, 32),
      new THREE.MeshBasicMaterial({ color: 0xc8a97e, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
    root.add(ring);
  }

  // Animation state.
  const anim = { walkPhase: 0, swayPhase: 0, recoilT: 0 };
  const trailState = { count: 0, idx: 0, lastTipWorld: new THREE.Vector3() };

  // armL/legL/legR aliases — keep external interface stable. Outside callers only need
  // the top-level group to pivot the entire limb.
  const armLGroup = armL;
  const legLGroup = legL.thigh;
  const legRGroup = legR.thigh;

  return {
    root, weaponRig, sword, tipNode, trail, trailGeo, trailMat, trailPts, trailState,
    parts: { torso, head, helm, legL: legLGroup, legR: legRGroup, armL: armLGroup, weaponRig, hips: pelvis },

    animate(dt, { mvSpeed = 0, swinging = false, blocking = false, alive = true, swingLat = 0, swingFwd = 0, crippled = false, stunned = false, verAim = 0, tipDist = 0, torsoRot = null, headRot = null, playerYaw = 0 } = {}) {
      // Shoulder lift on high stance — raises the right shoulder when aim is up.
      const lift = Math.max(-0.05, Math.min(0.20, verAim * 0.18));
      weaponRig.position.y = Y_SHOULDER + lift;
      pauldronR.position.y = Y_SHOULDER + radius * 0.05 + lift;

      // Right elbow IK from tip distance (closer = more fold).
      const totalReach = UPPER_ARM_LEN + FOREARM_LEN;
      const chord = Math.min(Math.max(tipDist || 0, 0.02), totalReach);
      const ratio = chord / totalReach;
      const bend = Math.acos(Math.max(-1, Math.min(1, ratio)));
      elbowR.rotation.x = 0.20 + bend * 0.55;

      anim.swayPhase += dt;

      if (alive) {
        // Idle breathing — chest expands subtly when standing still.
        const breath = (1 - Math.min(1, mvSpeed)) * 0.030 * Math.sin(anim.swayPhase * 1.6);
        torso.scale.y = 1 + breath;

        // Walk cycle — bigger stride, vertical bob, foot lift.
        const stride = THREE.MathUtils.clamp(mvSpeed / 5, 0, 1);
        anim.walkPhase += dt * (4.6 + mvSpeed * 1.0) * stride;
        const phase = anim.walkPhase;

        const lThighSwing =  Math.sin(phase) * 0.95 * stride;
        const rThighSwing = -Math.sin(phase) * 0.95 * stride;
        legL.thigh.rotation.x = lThighSwing;
        legR.thigh.rotation.x = rThighSwing;
        // Knee bend: stronger when leg lifts forward, near-straight when planted.
        legL.shin.rotation.x = Math.max(0.04, lThighSwing * 0.85);
        legR.shin.rotation.x = Math.max(0.04, rThighSwing * 0.85);
        // Foot pitch — toes drop on lift, ankle rolls on plant.
        legL.foot.rotation.x = -lThighSwing * 0.45;
        legR.foot.rotation.x = -rThighSwing * 0.45;
        // Foot lift: lifting leg moves up slightly along Y while planted leg stays.
        legL.foot.position.y = Math.max(0, lThighSwing) * 0.04;
        legR.foot.position.y = Math.max(0, rThighSwing) * 0.04;
        // Whole-body vertical bob (subtle — happens twice per stride). Added on top of
        // whatever poseRig() already set (player's world Y / jump altitude).
        root.position.y += (Math.abs(Math.sin(phase)) - 0.5) * 0.04 * stride;

        // Left arm posing.
        if (grip === "two-hand") {
          armL.rotation.x = -1.0;
          armL.rotation.y =  0.7;
          armL.rotation.z =  0.15;
          elbowL.rotation.x = 0.6;
        } else if (grip === "shield") {
          armL.rotation.x = -0.4;
          armL.rotation.y =  0.0;
          armL.rotation.z = -0.15;
          elbowL.rotation.x = 0.7;
        } else {
          armL.rotation.x = -Math.sin(phase) * 0.5 * stride;
          armL.rotation.y = 0;
          armL.rotation.z = 0;
          elbowL.rotation.x = 0.30 + Math.max(0, -Math.sin(phase) * 0.3 * stride);
        }

        if (crippled) {
          legR.thigh.rotation.x = Math.max(-0.2, legR.thigh.rotation.x);
          legR.thigh.rotation.z = 0.25;
          torso.rotation.z += 0.10;
        } else {
          legR.thigh.rotation.z = 0;
        }

        if (stunned) {
          const wob = Math.sin(anim.swayPhase * 6.0) * 0.18;
          torso.rotation.z += wob;
          torso.rotation.x += Math.sin(anim.swayPhase * 5.0) * 0.10;
          armL.rotation.x = 0;
          legL.thigh.rotation.x = 0; legR.thigh.rotation.x = 0;
          legL.thigh.rotation.z = -0.15; legR.thigh.rotation.z = 0.15;
          legL.shin.rotation.x = 0.2;  legR.shin.rotation.x = 0.2;
        } else {
          legL.thigh.rotation.z = 0;
        }

        // Idle torso sway + lean from swing motion.
        const idleSway = Math.sin(anim.swayPhase * 1.2) * 0.02;
        anim.leanZ = (anim.leanZ || 0) + (THREE.MathUtils.clamp(swingLat * 0.06, -0.3, 0.3) - (anim.leanZ || 0)) * Math.min(1, dt * 12);
        anim.leanX = (anim.leanX || 0) + (THREE.MathUtils.clamp(swingFwd * 0.04, -0.25, 0.25) - (anim.leanX || 0)) * Math.min(1, dt * 12);
        torso.rotation.z = idleSway + anim.leanZ;
        torso.rotation.x = anim.leanX;
        // Active-ragdoll torso wobble layered on top. Clamp tightly so the body never
        // visibly tips over during normal play — wobble is meant to be a subtle hit shake.
        if (torsoRot) {
          const cy = Math.cos(-playerYaw), sy = Math.sin(-playerYaw);
          const lx =  cy * torsoRot.x + sy * torsoRot.z;
          const lz = -sy * torsoRot.x + cy * torsoRot.z;
          const wx = THREE.MathUtils.clamp(lx * 0.7, -0.18, 0.18);
          const wz = THREE.MathUtils.clamp(lz * 0.7, -0.18, 0.18);
          torso.rotation.x += wx;
          torso.rotation.z += wz;
        }
        // Head bob from physics — also tightly clamped.
        if (headRot) {
          const cy = Math.cos(-playerYaw), sy = Math.sin(-playerYaw);
          const lx =  cy * headRot.x + sy * headRot.z;
          const lz = -sy * headRot.x + cy * headRot.z;
          const wx = THREE.MathUtils.clamp(lx * 0.6, -0.20, 0.20);
          const wz = THREE.MathUtils.clamp(lz * 0.6, -0.20, 0.20);
          head.rotation.x = wx; head.rotation.z = wz;
          helm.rotation.x = wx; helm.rotation.z = wz;
        }
        torso.position.y = Y_CHEST + height * 0.02 + Math.sin(phase * 2) * 0.02 * stride;

        // Hip counter-rotation + foot stagger
        pelvis.rotation.y = -anim.leanZ * 1.2;
        pelvis.rotation.x = -anim.leanX * 0.4;
        const stagger = Math.max(-0.2, Math.min(0.2, anim.leanZ * 0.8));
        legL.thigh.position.z = stagger * 0.20;
        legR.thigh.position.z = -stagger * 0.20;

        if (blocking) {
          torso.rotation.x += 0.10;
          armL.rotation.x = 0.6;
          elbowL.rotation.x = 0.9;
        }
      } else {
        // Death pose — slumped.
        anim.recoilT = Math.min(1, (anim.recoilT || 0) + dt * 4);
        const k = anim.recoilT;
        legL.thigh.rotation.x = -1.1 * k;
        legR.thigh.rotation.x = -0.9 * k;
        legL.shin.rotation.x  =  0.6 * k;
        legR.shin.rotation.x  =  0.5 * k;
        armL.rotation.x       =  0.4 * k;
        torso.rotation.x      = -0.9 * k;
      }
    },

    setLean(x, z) { torso.rotation.z = x * 0.15; torso.rotation.x = z * 0.15; },
    setSeveredLeg(severed) { legR.thigh.visible = !severed; },
    // Severed right arm — hide forearm + sword. Upper arm + pauldron remain (severed at elbow).
    setSeveredArm(severed) { elbowR.visible = !severed; },

    pushTrail(tipWorld, tipSpeed = 0) {
      const local = tipWorld.clone();
      root.worldToLocal(local);
      const len = trailPts.length / 3;
      for (let i = (trailState.count >= len ? len - 1 : trailState.count); i > 0; i--) {
        trailPts[i*3+0] = trailPts[(i-1)*3+0];
        trailPts[i*3+1] = trailPts[(i-1)*3+1];
        trailPts[i*3+2] = trailPts[(i-1)*3+2];
      }
      trailPts[0] = local.x; trailPts[1] = local.y; trailPts[2] = local.z;
      if (trailState.count < len) trailState.count++;
      trailGeo.setDrawRange(0, trailState.count);
      trailGeo.attributes.position.needsUpdate = true;
      const o = Math.max(0, Math.min(0.85, (tipSpeed - 4) / 16));
      trailMat.opacity = o;
    },

    setInvuln(active, t) {
      const pulse = active ? (0.4 + 0.4 * Math.abs(Math.sin(t * 10))) : 1.0;
      const transparent = active;
      // Iterate only meshes (skip Groups). Pulse all visible body meshes.
      const meshes = [
        torso, abdomen, pelvis, gorget, neck, head,
        helmDome, visor, slit, rim,
        upperArmLMesh, forearmLMesh, handLMesh, couterL, pauldronL,
        upperArmRMesh, forearmRMesh, handRMesh, couterR, pauldronR,
        legL.thigh.children[0], legR.thigh.children[0],         // thigh meshes
      ];
      for (const m of meshes) {
        if (!m || !m.material) continue;
        m.material.transparent = transparent;
        m.material.opacity = pulse;
      }
    },
  };
}

// Visual proportions tuned to look chunky/readable at the third-person camera distance.
const WEAPON_VISUAL = {
  arming:      { gripLen: 0.20, bladeLen: 0.95, bladeW: 0.075, bladeT: 0.022, guardW: 0.30, head: "blade", color: 0xdfe5ee },
  longsword:   { gripLen: 0.34, bladeLen: 1.05, bladeW: 0.075, bladeT: 0.024, guardW: 0.36, head: "blade", color: 0xdfe5ee },
  mace:        { gripLen: 0.60, bladeLen: 0.28, bladeW: 0.14,  bladeT: 0.14,  guardW: 0.12, head: "ball",  color: 0x9a7a3a },
  spear:       { gripLen: 1.90, bladeLen: 0.28, bladeW: 0.05,  bladeT: 0.05,  guardW: 0.0,  head: "spear", color: 0xdfe5ee },
  swordshield: { gripLen: 0.20, bladeLen: 0.92, bladeW: 0.075, bladeT: 0.022, guardW: 0.30, head: "blade", color: 0xdfe5ee },
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
    // Subtle blade fuller (groove) — thin darker box on each side.
    const fullerMat = new THREE.MeshStandardMaterial({ color: 0x9098a0, metalness: 0.7, roughness: 0.5 });
    const fuller = new THREE.Mesh(new THREE.BoxGeometry(w.bladeW * 0.25, w.bladeLen * 0.85, w.bladeT * 1.05), fullerMat);
    fuller.position.y = w.gripLen + w.bladeLen / 2;
    sword.add(fuller);
  } else if (w.head === "ball") {
    const ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(w.bladeW, 1),
      new THREE.MeshStandardMaterial({ color: w.color, metalness: 0.4, roughness: 0.6 }),
    );
    ball.position.y = w.gripLen + w.bladeW;
    sword.add(ball);
    const spikeMat = new THREE.MeshStandardMaterial({ color: 0xbcc1cc, metalness: 0.7, roughness: 0.3 });
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 4), spikeMat);
      const a = i / 8 * Math.PI * 2;
      s.position.set(Math.cos(a) * w.bladeW, w.gripLen + w.bladeW, Math.sin(a) * w.bladeW);
      s.lookAt(s.position.x * 2, s.position.y, s.position.z * 2);
      sword.add(s);
    }
  } else if (w.head === "spear") {
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, w.bladeLen, 8), bladeMat);
    tip.position.y = w.gripLen + w.bladeLen / 2;
    sword.add(tip);
    // Spear collar where head meets shaft.
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 10), guardMat);
    collar.position.y = w.gripLen;
    sword.add(collar);
  }

  return sword;
}

export const WEAPON_LIST = ["arming", "longsword", "mace", "spear", "swordshield"];
