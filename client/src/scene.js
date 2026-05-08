import * as THREE from "three";
import { RUNTIME } from "./config.js";

// Build static arena scene + sky/lights.
export function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14110d);
  scene.fog = new THREE.Fog(0x14110d, 25, 70);

  // Sun.
  const sun = new THREE.DirectionalLight(0xffe1b0, 1.4);
  sun.position.set(20, 30, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -25; sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;   sun.shadow.camera.bottom = -25;
  sun.shadow.camera.near = 1;   sun.shadow.camera.far = 80;
  scene.add(sun);

  scene.add(new THREE.HemisphereLight(0x556677, 0x2a1f15, 0.45));
  scene.add(new THREE.AmbientLight(0x111111, 0.4));

  // Ground.
  const size = RUNTIME.arena.size;
  const groundGeo = new THREE.PlaneGeometry(size, size, 16, 16);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x6a5536, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Outer wall (4 segments).
  const wallH = RUNTIME.arena.wallH;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.95 });
  const wallThick = 0.5;
  const halfS = size / 2;
  const wallSpecs = [
    { x: 0, z: -halfS, sx: size + wallThick * 2, sz: wallThick },
    { x: 0, z:  halfS, sx: size + wallThick * 2, sz: wallThick },
    { x: -halfS, z: 0, sx: wallThick, sz: size },
    { x:  halfS, z: 0, sx: wallThick, sz: size },
  ];
  for (const w of wallSpecs) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.sx, wallH, w.sz), wallMat);
    m.position.set(w.x, wallH / 2, w.z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }

  // Pillars.
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x55483a, roughness: 1 });
  for (const o of RUNTIME.arena.obstacles) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.hx * 2, wallH * 0.9, o.hz * 2), pillarMat);
    m.position.set(o.x, wallH * 0.45, o.z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }

  // Floor texture-ish — quad grid lines.
  const grid = new THREE.GridHelper(size, size / 2, 0x2a1f12, 0x2a1f12);
  grid.position.y = 0.01;
  scene.add(grid);

  // Spawn ring decals (4 corners).
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xc8a97e, transparent: true, opacity: 0.25 });
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 32);
  const r = halfS - 2;
  for (const [x, z] of [[-r,-r],[r,-r],[r,r],[-r,r]]) {
    const m = new THREE.Mesh(ringGeo, ringMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    scene.add(m);
  }

  // Weapon racks: a small post + glowing ring marker + a stylized weapon hovering over.
  const rackPostMat = new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.9 });
  const rackRingMat = new THREE.MeshBasicMaterial({ color: 0x9adfff, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const bladeMat   = new THREE.MeshStandardMaterial({ color: 0xdfe5ee, metalness: 0.85, roughness: 0.25 });
  const gripMat    = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95 });
  const guardMat   = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, metalness: 0.7, roughness: 0.4 });
  for (const rk of (RUNTIME.arena.racks || [])) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.10, 1.2, 6), rackPostMat);
    post.position.set(rk.x, 0.6, rk.z);
    post.castShadow = true;
    scene.add(post);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32), rackRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(rk.x, 0.05, rk.z);
    scene.add(ring);
    // Weapon mesh stuck on top of post.
    const wgrp = new THREE.Group();
    wgrp.position.set(rk.x, 1.30, rk.z);
    wgrp.rotation.z = Math.PI;          // blade up by flipping
    if (rk.weapon === "mace") {
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 8), gripMat);
      grip.position.y = 0.275;
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 1), guardMat);
      ball.position.y = 0.55 + 0.10;
      wgrp.add(grip); wgrp.add(ball);
    } else if (rk.weapon === "spear") {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.85, 8), gripMat);
      shaft.position.y = 0.925;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.25, 8), bladeMat);
      tip.position.y = 1.85 + 0.125;
      wgrp.add(shaft); wgrp.add(tip);
    } else {
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, rk.weapon === "longsword" ? 0.30 : 0.20, 8), gripMat);
      grip.position.y = (rk.weapon === "longsword" ? 0.30 : 0.20) / 2;
      const guard = new THREE.Mesh(new THREE.BoxGeometry(rk.weapon === "longsword" ? 0.26 : 0.22, 0.025, 0.04), guardMat);
      guard.position.y = (rk.weapon === "longsword" ? 0.30 : 0.20);
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, rk.weapon === "longsword" ? 1.00 : 0.92, 0.012),
        bladeMat,
      );
      blade.position.y = (rk.weapon === "longsword" ? 0.30 : 0.20) + (rk.weapon === "longsword" ? 1.00 : 0.92) / 2;
      wgrp.add(grip); wgrp.add(guard); wgrp.add(blade);
    }
    scene.add(wgrp);
  }

  return { scene, sun };
}
