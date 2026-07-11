(function () {
  'use strict';

  window.RoboArm = { init: init, open: openGame, close: closeGame };

  var FLOOR_HALF = 8;
  var PICK_RADIUS = 0.85;
  var PAD_RADIUS = 0.9;
  var L1 = 1.15;   // upper-arm length
  var L2 = 1.05;   // forearm length
  var GRIP_CLOSED = 0.05;
  var GRIP_OPEN = 0.22;

  var overlay, canvas, renderer, scene, camera;
  var chassis, turret, upperArmPivot, elbowPivot, gripperPivot, fingerL, fingerR;
  var wheelsFL, wheelsFR, wheelsBL, wheelsBR;
  var crate, pad;
  var keys = {};
  var raf = null;
  var initialized = false;
  var running = false;
  var holding = false;
  var score = 0;
  var lastTime = 0;
  var flashTimer = 0;
  var camOffset;

  var robot = { x: 0, z: 3.2, heading: Math.PI };
  var arm = { base: 0, shoulder: 0.31, elbow: -0.07, gripOpen: 1, gripTarget: 1 };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // ─── BUILD ──────────────────────────────────────────────────────────

  function metal(hex, rough, met) {
    return new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: met });
  }
  function glow(hex, intensity) {
    return new THREE.MeshStandardMaterial({ color: 0x101318, emissive: hex, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.2 });
  }

  function buildWheel() {
    var g = new THREE.Group();
    var tire = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.18, 20), metal(0x0e0f12, 0.9, 0.0));
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    var rim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 12), metal(0x5a6068, 0.5, 0.4));
    rim.rotation.z = Math.PI / 2;
    g.add(tire, rim);
    return g;
  }

  function buildRobot() {
    var THREE_ACCENT = 0x38bdf8;

    chassis = new THREE.Group();
    chassis.position.set(robot.x, 0, robot.z);

    var bodyMat = metal(0x2b3038, 0.5, 0.3);
    var body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.9), bodyMat);
    body.position.y = 0.42;
    body.castShadow = true; body.receiveShadow = true;
    var trim = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.08, 1.94), glow(THREE_ACCENT, 0.7));
    trim.position.y = 0.17;
    chassis.add(body, trim);

    var wheelGeomOffsets = [
      [-0.72, 0.18, 0.62], [0.72, 0.18, 0.62],
      [-0.72, 0.18, -0.62], [0.72, 0.18, -0.62],
    ];
    var wheels = wheelGeomOffsets.map(function (o) {
      var w = buildWheel();
      w.position.set(o[0], o[1], o[2]);
      chassis.add(w);
      return w;
    });
    wheelsFL = wheels[0]; wheelsFR = wheels[1]; wheelsBL = wheels[2]; wheelsBR = wheels[3];

    // turret (rotates around Y - "base" joint)
    turret = new THREE.Group();
    turret.position.set(0, 0.67, 0);
    chassis.add(turret);
    var turretBase = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.22, 20), metal(0x333944, 0.45, 0.35));
    turretBase.position.y = 0.11;
    turretBase.castShadow = true;
    turret.add(turretBase);

    // upper arm (shoulder joint - pivots at turret; rest pose extends along
    // +Z, the chassis's own drive-forward direction, so shoulder=0/elbow=0
    // reads as "arm reaching straight out" rather than "pole standing up")
    upperArmPivot = new THREE.Group();
    upperArmPivot.position.set(0, 0.22, 0);
    turret.add(upperArmPivot);
    var upperArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, L1), bodyMat);
    upperArmMesh.position.z = L1 / 2;
    upperArmMesh.castShadow = true;
    var shoulderJoint = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), glow(THREE_ACCENT, 0.55));
    upperArmPivot.add(upperArmMesh, shoulderJoint);

    // forearm (elbow joint - child of upper arm, pivots at its tip)
    elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, 0, L1);
    upperArmPivot.add(elbowPivot);
    var foreArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, L2), metal(0x353b45, 0.45, 0.3));
    foreArmMesh.position.z = L2 / 2;
    foreArmMesh.castShadow = true;
    var elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), glow(THREE_ACCENT, 0.55));
    elbowPivot.add(foreArmMesh, elbowJoint);

    // gripper (wrist - child of forearm tip)
    gripperPivot = new THREE.Group();
    gripperPivot.position.set(0, 0, L2);
    elbowPivot.add(gripperPivot);
    var gripBase = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.14), metal(0x3f4650, 0.4, 0.4));
    gripBase.position.z = 0.07;
    gripBase.castShadow = true;
    var fingerMat = metal(0x9aa1ab, 0.4, 0.45);
    fingerL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.32), fingerMat);
    fingerR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.32), fingerMat);
    fingerL.position.set(-GRIP_OPEN, 0, 0.16 + 0.14);
    fingerR.position.set(GRIP_OPEN, 0, 0.16 + 0.14);
    fingerL.castShadow = true; fingerR.castShadow = true;
    gripperPivot.add(gripBase, fingerL, fingerR);

    scene.add(chassis);
  }

  function buildCrateAndPad() {
    var padMat = glow(0x38bdf8, 0.85);
    pad = new THREE.Mesh(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS, 0.02, 32), padMat);
    pad.position.set(-4.2, 0.011, -3.6);
    pad.receiveShadow = true;
    scene.add(pad);

    var crateMat = metal(0xf5a531, 0.55, 0.08);
    crate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), crateMat);
    crate.castShadow = true; crate.receiveShadow = true;
    scene.add(crate);
    placeCrate(3.6, -2.4);
  }

  function placeCrate(x, z) {
    crate.position.set(x, 0.21, z);
    crate.rotation.set(0, rand(0, Math.PI * 2), 0);
    crate.userData.held = false;
  }

  function respawnCrate() {
    var x, z;
    do {
      x = rand(-FLOOR_HALF + 1.2, FLOOR_HALF - 1.2);
      z = rand(-FLOOR_HALF + 1.2, FLOOR_HALF - 1.2);
    } while (Math.hypot(x - pad.position.x, z - pad.position.z) < 3.5);
    placeCrate(x, z);
  }

  function setupScene() {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x08090c);
    scene.fog = new THREE.Fog(0x08090c, 14, 30);

    camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    camOffset = new THREE.Vector3(5.2, 5.6, 5.2);

    var hemi = new THREE.HemisphereLight(0x5d7ba8, 0x0a0b0e, 0.35);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xfff2e0, 1.5);
    key.position.set(7, 11, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -13; key.shadow.camera.right = 13;
    key.shadow.camera.top = 13; key.shadow.camera.bottom = -13;
    key.shadow.camera.far = 32;
    key.shadow.bias = -0.0028;
    scene.add(key);
    var fill = new THREE.DirectionalLight(0x38bdf8, 0.4);
    fill.position.set(-8, 5, -6);
    scene.add(fill);

    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_HALF * 2, FLOOR_HALF * 2),
      metal(0x181b21, 0.9, 0.05)
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    var grid = new THREE.GridHelper(FLOOR_HALF * 2, 16, 0x2b6f96, 0x1c2027);
    grid.position.y = 0.005;
    scene.add(grid);

    buildRobot();
    buildCrateAndPad();
    resize();
  }

  // ─── INPUT ──────────────────────────────────────────────────────────

  function onKeyDown(e) {
    if (!running) return;
    var handled = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'Space', 'Escape'];
    if (handled.indexOf(e.code) !== -1) e.preventDefault();
    if (e.code === 'Escape') { closeGame(); return; }
    if (e.code === 'Space' && !keys.Space) { arm.gripTarget = arm.gripTarget > 0.5 ? 0 : 1; }
    keys[e.code] = true;
  }
  function onKeyUp(e) { keys[e.code] = false; }

  // ─── UPDATE ─────────────────────────────────────────────────────────

  function update(dt) {
    var driveSpeed = 2.6, turnSpeed = 1.9;
    var fwd = (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0);
    var turn = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);

    robot.heading += turn * turnSpeed * dt;
    if (fwd !== 0) {
      var vx = Math.sin(robot.heading), vz = Math.cos(robot.heading);
      robot.x = clamp(robot.x + vx * fwd * driveSpeed * dt, -FLOOR_HALF + 0.9, FLOOR_HALF - 0.9);
      robot.z = clamp(robot.z + vz * fwd * driveSpeed * dt, -FLOOR_HALF + 0.9, FLOOR_HALF - 0.9);
    }
    var wheelSpin = fwd * driveSpeed * dt / 0.26;
    [wheelsFL, wheelsFR, wheelsBL, wheelsBR].forEach(function (w) { w.rotation.x += wheelSpin; });

    chassis.position.set(robot.x, 0, robot.z);
    chassis.rotation.y = robot.heading;

    var armSpeed = 1.6;
    arm.base += ((keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0)) * armSpeed * dt;
    arm.shoulder = clamp(arm.shoulder + ((keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0)) * armSpeed * dt, -0.4, 0.9);
    arm.elbow = clamp(arm.elbow + ((keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0)) * armSpeed * dt, -1.8, 1.1);
    arm.gripOpen += (arm.gripTarget - arm.gripOpen) * Math.min(1, dt * 7);

    turret.rotation.y = arm.base;
    upperArmPivot.rotation.x = arm.shoulder;
    elbowPivot.rotation.x = arm.elbow;
    var gOff = GRIP_CLOSED + arm.gripOpen * (GRIP_OPEN - GRIP_CLOSED);
    fingerL.position.x = -gOff;
    fingerR.position.x = gOff;

    handlePickPlace();
    updateCamera(dt);

    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) setStatus('');
    }
  }

  var _gripWorld = new THREE.Vector3();
  function handlePickPlace() {
    gripperPivot.getWorldPosition(_gripWorld);
    if (!holding) {
      if (arm.gripTarget === 0 && arm.gripOpen < 0.3) {
        var d = _gripWorld.distanceTo(crate.position);
        if (d < PICK_RADIUS) {
          gripperPivot.attach(crate);
          holding = true;
        }
      }
    } else {
      if (arm.gripTarget === 1 && arm.gripOpen > 0.65) {
        scene.attach(crate);
        holding = false;
        var dx = crate.position.x - pad.position.x, dz = crate.position.z - pad.position.z;
        if (Math.hypot(dx, dz) < PAD_RADIUS && crate.position.y < 0.7) {
          score++;
          updateScore();
          setStatus('DELIVERED ✓', 1.6);
          respawnCrate();
        }
      }
    }
    updateHoldLabel();
  }

  function updateCamera(dt) {
    var rotated = camOffset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), robot.heading);
    var targetPos = new THREE.Vector3(robot.x, 0, robot.z).add(rotated);
    camera.position.lerp(targetPos, 1 - Math.pow(0.001, dt));
    camera.lookAt(robot.x, 1.1, robot.z);
  }

  // ─── LOOP ───────────────────────────────────────────────────────────

  function tick(t) {
    var dt = Math.min((t - lastTime) / 1000, 0.05);
    lastTime = t;
    update(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }

  function resize() {
    if (!renderer) return;
    var w = overlay.clientWidth, h = overlay.clientHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  // ─── HUD ────────────────────────────────────────────────────────────

  function updateScore() {
    var el = overlay.querySelector('#ra-score');
    if (el) el.textContent = score;
  }
  function updateHoldLabel() {
    var el = overlay.querySelector('#ra-hold');
    if (el) el.textContent = holding ? 'HOLDING CRATE' : 'GRIPPER EMPTY';
  }
  function setStatus(text, seconds) {
    var el = overlay.querySelector('#ra-status');
    if (el) el.textContent = text;
    flashTimer = seconds || 0;
  }

  function buildDOM() {
    overlay.innerHTML =
      '<canvas id="ra-canvas" style="display:block; width:100%; height:100%;"></canvas>' +
      '<div style="position:absolute; top:20px; left:24px; font-family:\'JetBrains Mono\',monospace; color:#e7eaee; pointer-events:none;">' +
      '<div style="font-size:10px; letter-spacing:.18em; text-transform:uppercase; opacity:.6;">Crates Delivered</div>' +
      '<div id="ra-score" style="font-family:\'Saira Condensed\',sans-serif; font-weight:800; font-size:34px; color:#38bdf8;">0</div>' +
      '<div id="ra-hold" style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; opacity:.55; margin-top:4px;">Gripper Empty</div>' +
      '</div>' +
      '<div id="ra-status" style="position:absolute; top:24px; left:50%; transform:translateX(-50%); font-family:\'JetBrains Mono\',monospace; font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:#4ade80; pointer-events:none;"></div>' +
      '<button id="ra-exit" style="position:absolute; top:20px; right:24px; font-family:\'JetBrains Mono\',monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; padding:10px 18px; background:rgba(8,9,11,0.85); color:rgba(231,234,238,0.7); border:1px solid rgba(255,255,255,0.14); border-radius:2px; cursor:pointer;">ESC — Exit</button>' +
      '<div style="position:absolute; bottom:22px; left:50%; transform:translateX(-50%); display:flex; gap:22px; font-family:\'JetBrains Mono\',monospace; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:rgba(231,234,238,0.55); pointer-events:none; text-align:center;">' +
      '<span>◄▲▼► DRIVE</span><span>A / D BASE</span><span>W / S SHOULDER</span><span>Q / E ELBOW</span><span>SPACE GRIP</span>' +
      '</div>';
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────

  function init(container) {
    overlay = container;
    buildDOM();
    canvas = overlay.querySelector('#ra-canvas');
    overlay.querySelector('#ra-exit').addEventListener('click', closeGame);
    if (!window.THREE) {
      // The CDN <script> for three.js lives in the same async-rendered
      // markup the theme/badge scripts elsewhere in this file have to work
      // around - it may not have finished loading yet on a slow connection.
      setTimeout(function () { init(container); }, 120);
      return;
    }
    setupScene();
    window.addEventListener('resize', resize, { passive: true });
    initialized = true;
  }

  function openGame() {
    if (!initialized) return;
    overlay.style.display = 'block';
    resize(); // overlay was display:none (clientWidth/Height 0) during init()
    requestAnimationFrame(function () { overlay.style.opacity = '1'; });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    keys = {};
    running = true;
    lastTime = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function closeGame() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    overlay.style.opacity = '0';
    setTimeout(function () { overlay.style.display = 'none'; }, 300);
  }
})();
