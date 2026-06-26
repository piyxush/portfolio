(function () {
  'use strict';

  window.ADGame = { init: initGame, start: startGame, stop: stopGame, exit: exitGame };

  const ACC = '#ff4d2e';
  const ROAD_RATIO = 0.52;
  const NLANES = 3;
  const CAR_W = 32, CAR_H = 56;
  const BASE_SCROLL = 200;

  let canvas, ctx, rafId, state;

  // ─── GEOMETRY ─────────────────────────────────────────────────────

  function laneX(l) {
    const rw = canvas.width * ROAD_RATIO;
    const rl = (canvas.width - rw) / 2;
    return rl + (rw / NLANES) * (l + 0.5);
  }

  // ─── INIT ─────────────────────────────────────────────────────────

  function initGame(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize, { passive: true });
    initInput();
  }

  function resize() {
    canvas.width = canvas.offsetWidth || window.innerWidth;
    canvas.height = canvas.offsetHeight || window.innerHeight;
    if (state) {
      state.px = laneX(state.playerLane);
      state.py = canvas.height * 0.78;
    }
  }

  function mkRain() {
    const W = canvas.width || window.innerWidth;
    const H = canvas.height || window.innerHeight;
    const drops = [];
    for (let i = 0; i < 150; i++) {
      drops.push({
        x: Math.random() * W,
        y: Math.random() * H,
        speed: 480 + Math.random() * 520,
        len: 10 + Math.random() * 22,
        a: 0.25 + Math.random() * 0.45,
      });
    }
    return drops;
  }

  function mkState() {
    return {
      px: laneX(1), py: canvas.height * 0.78,
      playerLane: 1,
      speed: 60, roadOff: 0,
      obstacles: [], spawnT: 1.8, spawnInterval: 2.2,
      ap: false, apState: 'CRUISING', apTimer: 0,
      apDetections: [],
      score: 0, dist: 0, t: 0,
      alive: true, dead: false,
      hiScore: +localStorage.getItem('adg-hi') || 0,
      keys: {},
      // Rain
      rain: mkRain(),
      // Powerups / shield
      powerups: [], powerupT: 9,
      shieldActive: false,
      // Particles (death explosion)
      particles: [],
      // Floating score popups
      popups: [],
      // Score multiplier (near-miss streak)
      multiplier: 1, multTimer: 0,
      // Skid marks
      skidMarks: [],
      // Radar sweep angle
      radarAngle: -Math.PI / 2,
      // Near-miss tracking (one popup per obstacle)
      passedIds: new Set(),
      // Spawn ID counter
      nextId: 0,
    };
  }

  // ─── INPUT ────────────────────────────────────────────────────────

  let touchSX = 0, touchSY = 0;
  let prevLeft = false, prevRight = false;

  function initInput() {
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    canvas.addEventListener('touchstart', e => {
      touchSX = e.touches[0].clientX;
      touchSY = e.touches[0].clientY;
    }, { passive: true });
    canvas.addEventListener('touchend', e => {
      if (!state) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchSX, dy = t.clientY - touchSY;
      const z = getBtnZones();
      const inBtnRow = t.clientY > canvas.height - 90 && t.clientY < canvas.height - 20;
      if (inBtnRow) {
        if (t.clientX < z.leftEnd) { changeLane(-1); return; }
        if (t.clientX > z.rStart && t.clientX < z.rEnd) { changeLane(1); return; }
        if (t.clientX > z.apStart) { toggleAP(); return; }
      }
      if (state.dead) { startGame(); return; }
      if (Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy)) changeLane(dx < 0 ? -1 : 1);
    }, { passive: true });
    canvas.addEventListener('click', e => {
      if (!state) return;
      const z = getBtnZones();
      const inBtnRow = e.clientY > canvas.height - 90 && e.clientY < canvas.height - 20;
      if (inBtnRow) {
        if (e.clientX < z.leftEnd) { changeLane(-1); return; }
        if (e.clientX > z.rStart && e.clientX < z.rEnd) { changeLane(1); return; }
        if (e.clientX > z.apStart) { toggleAP(); return; }
      }
      if (state.dead) startGame();
    });
  }

  function onKey(e) {
    if (!state) return;
    const dn = e.type === 'keydown';
    state.keys[e.key] = dn;
    if (!dn) return;
    if (e.key === 'a' || e.key === 'A') toggleAP();
    if ((e.key === 'r' || e.key === 'R') && state.dead) startGame();
    if (e.key === 'Escape') exitGame();
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  }

  function getBtnZones() {
    const bw = 64, bp = 20;
    return {
      leftEnd: bp + bw,
      rStart: canvas.width / 2 - bw - 10,
      rEnd: canvas.width / 2 + 10,
      apStart: canvas.width - bp - bw,
    };
  }

  function changeLane(dir) {
    if (!state || !state.alive || state.ap) return;
    const prev = state.playerLane;
    state.playerLane = Math.max(0, Math.min(NLANES - 1, state.playerLane + dir));
    if (state.playerLane !== prev) mkSkidMarks();
  }

  function toggleAP() {
    if (!state || !state.alive) return;
    state.ap = !state.ap;
    state.apState = 'CRUISING';
    state.apTimer = 0;
  }

  function exitGame() {
    stopGame();
    state = null;
    const ov = document.getElementById('game-overlay');
    if (!ov) return;
    ov.style.transition = 'opacity 0.55s';
    ov.style.opacity = '0';
    setTimeout(() => { ov.style.display = 'none'; ov.style.opacity = ''; ov.style.transition = ''; }, 580);
  }

  // ─── LOOP ─────────────────────────────────────────────────────────

  function startGame() {
    stopGame();
    state = mkState();
    let last = performance.now();
    function loop(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      update(dt);
      render();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
  }

  function stopGame() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // ─── UPDATE ───────────────────────────────────────────────────────

  function update(dt) {
    if (state.dead) {
      updateParticles(dt);
      updatePopups(dt);
      return;
    }
    state.t += dt;

    // Speed ramp — harder over time
    const targetSpeed = Math.min(230, 60 + state.t * 0.75);
    state.speed += (targetSpeed - state.speed) * dt * 1.5;

    const scroll = (state.speed / 60) * BASE_SCROLL;
    state.roadOff = (state.roadOff + scroll * dt) % 80;
    state.dist += scroll * dt * 0.042;
    state.score += dt * state.speed * 0.13 * state.multiplier;

    if (!state.ap) handleManual();
    else updateAP(dt);

    state.px += (laneX(state.playerLane) - state.px) * Math.min(1, dt * 9);

    state.spawnT -= dt;
    if (state.spawnT <= 0) {
      spawnObs();
      state.spawnInterval = Math.max(0.72, state.spawnInterval - 0.022);
      state.spawnT = state.spawnInterval * (0.65 + Math.random() * 0.7);
    }

    state.obstacles.forEach(o => { o.x = laneX(o.lane); o.y += scroll * dt * (1 + o.sf); });

    checkNearMiss();
    state.obstacles = state.obstacles.filter(o => o.y < canvas.height + 130);

    checkCollision();
    if (state.ap) updateConf();

    updatePowerups(dt, scroll);
    updateRain(dt, scroll);
    updateParticles(dt);
    updatePopups(dt);

    if (state.multiplier > 1) {
      state.multTimer -= dt;
      if (state.multTimer <= 0) { state.multiplier = 1; state.multTimer = 0; }
    }

    state.skidMarks.forEach(m => { m.a -= dt * 0.55; });
    state.skidMarks = state.skidMarks.filter(m => m.a > 0);

    state.radarAngle += dt * 2.6;
    if (state.radarAngle > Math.PI * 1.5) state.radarAngle -= Math.PI * 2;
  }

  function handleManual() {
    const k = state.keys;
    const left = !!(k['ArrowLeft'] || k['a']);
    const right = !!(k['ArrowRight'] || k['d']);
    if (left && !prevLeft) changeLane(-1);
    if (right && !prevRight) changeLane(1);
    prevLeft = left;
    prevRight = right;
  }

  function updateAP(dt) {
    state.apTimer -= dt;
    const sr = canvas.height * 0.44;
    const threats = state.obstacles.filter(o => o.y < state.py && o.y > state.py - sr);
    state.apDetections = threats;

    if (threats.length === 0) {
      state.apState = 'CRUISING';
      if (state.apTimer <= 0 && state.playerLane !== 1) {
        state.playerLane = 1;
        state.apTimer = 1.8;
      }
      return;
    }

    const nearest = threats.reduce((a, b) => (state.py - a.y) < (state.py - b.y) ? a : b);
    const dist = state.py - nearest.y;

    if (dist > sr * 0.6) {
      state.apState = 'DETECTING';
    } else if (state.apTimer <= 0) {
      state.apState = 'PLANNING';
      const danger = [0, 0, 0];
      threats.forEach(o => { danger[o.lane] += 120 / Math.max(5, state.py - o.y); });
      let best = state.playerLane, bestS = Infinity;
      for (let l = 0; l < NLANES; l++) {
        const s = danger[l] + Math.abs(l - 1) * 0.4;
        if (s < bestS) { bestS = s; best = l; }
      }
      if (best !== state.playerLane) mkSkidMarks();
      state.playerLane = best;
      state.apTimer = 0.7;
      setTimeout(() => { if (state && state.ap) state.apState = 'EXECUTING'; }, 250);
    }
  }

  function updateConf() {
    state.apDetections.forEach(o => {
      if (o.conf == null) o.conf = 0.74 + Math.random() * 0.23;
      o.conf = Math.max(0.55, Math.min(0.99, o.conf + (Math.random() - 0.5) * 0.016));
    });
  }

  function checkNearMiss() {
    const collThreshX = (CAR_W + 30) * 0.36;
    const nearThreshX = (CAR_W + 30) * 0.78;
    state.obstacles.forEach(o => {
      if (state.passedIds.has(o.id)) return;
      const yDist = Math.abs(o.y - state.py);
      const xDist = Math.abs(o.x - state.px);
      if (yDist < (CAR_H + o.h) * 0.52) {
        if (xDist < nearThreshX && xDist >= collThreshX) {
          state.passedIds.add(o.id);
          const bonus = Math.round(120 * state.multiplier);
          state.score += bonus;
          state.multiplier = Math.min(6, state.multiplier + 1);
          state.multTimer = 3.8;
          addPopup(`+${bonus}  NEAR MISS`, state.px, state.py - 70, '#f5a623');
          if (state.multiplier > 1) addPopup(`x${state.multiplier} STREAK`, state.px, state.py - 90, '#4ade80');
        }
      }
    });
  }

  function spawnObs() {
    const lane = Math.floor(Math.random() * NLANES);
    const truck = Math.random() < 0.24;
    state.obstacles.push({
      id: state.nextId++,
      lane, x: laneX(lane), y: -120,
      sf: -0.18 + Math.random() * 0.36,
      truck,
      w: truck ? 34 : 28,
      h: truck ? 84 : 52,
      clr: ['#4a90d9', '#7ed321', '#f5a623', '#9b9b9b'][0 | Math.random() * 4],
      conf: null,
    });
  }

  function updatePowerups(dt, scroll) {
    state.powerupT -= dt;
    if (state.powerupT <= 0 && !state.shieldActive) {
      state.powerups.push({ lane: Math.floor(Math.random() * NLANES), y: -60, angle: 0 });
      state.powerupT = 12 + Math.random() * 8;
    }
    state.powerups.forEach(p => {
      p.y += scroll * dt;
      p.angle += dt * 1.8;
      p.x = laneX(p.lane);
    });
    state.powerups = state.powerups.filter(p => {
      if (Math.abs(p.x - state.px) < 26 && Math.abs(p.y - state.py) < 28) {
        state.shieldActive = true;
        addPopup('SHIELD ACTIVE', state.px, state.py - 65, '#4ade80');
        return false;
      }
      return p.y < canvas.height + 60;
    });
  }

  function updateRain(dt) {
    const W = canvas.width, H = canvas.height;
    state.rain.forEach(d => {
      d.y += d.speed * dt;
      d.x -= dt * 55;
      if (d.y > H + 20) { d.y = -20; d.x = Math.random() * W; }
      if (d.x < -10) d.x = W + 10;
    });
  }

  function updateParticles(dt) {
    state.particles.forEach(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 380 * dt;
      p.a -= dt * 1.7;
    });
    state.particles = state.particles.filter(p => p.a > 0);
  }

  function updatePopups(dt) {
    state.popups.forEach(p => { p.y += p.vy * dt; p.a -= dt * 1.1; });
    state.popups = state.popups.filter(p => p.a > 0);
  }

  function addPopup(text, x, y, color) {
    state.popups.push({ text, x, y, vy: -48, a: 1.2, color });
  }

  function mkSkidMarks() {
    const { px, py } = state;
    state.skidMarks.push({ x: px - CAR_W / 2 + 5, y: py + CAR_H / 2 - 5, len: 22, a: 0.55 });
    state.skidMarks.push({ x: px + CAR_W / 2 - 9, y: py + CAR_H / 2 - 5, len: 22, a: 0.55 });
  }

  function spawnExplosion(x, y) {
    const colors = [ACC, '#f5a623', '#ffffffcc', '#ff8c00', '#ffd700'];
    for (let i = 0; i < 44; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 70 + Math.random() * 300;
      state.particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 90,
        a: 1,
        color: colors[0 | Math.random() * colors.length],
        sz: 2 + Math.random() * 5,
      });
    }
  }

  function checkCollision() {
    for (const o of state.obstacles) {
      if (
        Math.abs(o.x - state.px) < (CAR_W + o.w) * 0.36 &&
        Math.abs(o.y - state.py) < (CAR_H + o.h) * 0.36
      ) {
        if (state.shieldActive) {
          state.shieldActive = false;
          addPopup('SHIELD ABSORBED HIT!', state.px, state.py - 60, '#4ade80');
          state.obstacles = state.obstacles.filter(ob => ob !== o);
          return;
        }
        state.alive = false;
        state.dead = true;
        spawnExplosion(state.px, state.py);
        const sc = Math.floor(state.score);
        if (sc > state.hiScore) { state.hiScore = sc; localStorage.setItem('adg-hi', sc); }
        return;
      }
    }
  }

  // ─── RENDER ───────────────────────────────────────────────────────

  function render() {
    const W = canvas.width, H = canvas.height;
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = dark ? '#08090b' : '#eeeff2';
    ctx.fillRect(0, 0, W, H);

    drawRoad(W, H, dark);
    drawSkidMarks();
    if (state.ap) drawSensors(H, dark);
    if (state.ap) drawPredictionTrails();
    drawPowerups();
    drawObstacles(dark);
    if (state.ap) drawDetections(dark);
    if (state.ap) drawAPPath();
    drawPlayerCar();
    drawRain(W, H, dark);
    if (state.speed > 115 && !state.dead) drawSpeedLines(W, H);
    drawParticles();
    drawPopups();
    drawHUD(W, H, dark);
    if (state.dead) drawGameOver(W, H, dark);
  }

  function drawRoad(W, H, dark) {
    const rw = W * ROAD_RATIO, rl = (W - rw) / 2, rr = rl + rw;
    const lw = rw / NLANES;

    ctx.fillStyle = dark ? '#0a0c0f' : '#d2d5dd';
    ctx.fillRect(0, 0, rl, H);
    ctx.fillRect(rr, 0, W - rr, H);

    ctx.fillStyle = dark ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.045)';
    const g = 48;
    const offY = (-state.roadOff * 0.4) % g;
    for (let x = 0; x < W; x += g) {
      for (let y = offY - g; y < H; y += g) {
        if (x + 4 < rl || x - 4 > rr) ctx.fillRect(x, y, 2.5, 2.5);
      }
    }

    ctx.fillStyle = dark ? '#0f121a' : '#bec3ce';
    ctx.fillRect(rl, 0, rw, H);

    // Wet road reflection when rain has started
    const rainMix = Math.min(1, state.t * 0.04);
    if (dark && rainMix > 0.15) {
      const grad = ctx.createLinearGradient(0, state.py - 10, 0, H);
      grad.addColorStop(0, `rgba(255,77,46,${rainMix * 0.05})`);
      grad.addColorStop(1, `rgba(255,77,46,${rainMix * 0.11})`);
      ctx.fillStyle = grad;
      ctx.fillRect(rl, state.py - 10, rw, H - state.py + 10);
    }

    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 3;
    ln(rl, 0, rl, H); ln(rr, 0, rr, H);

    ctx.strokeStyle = dark ? '#2e3540' : '#8a919e';
    ctx.lineWidth = 2;
    ctx.setLineDash([38, 40]);
    ctx.lineDashOffset = -state.roadOff;
    for (let l = 1; l < NLANES; l++) ln(rl + lw * l, 0, rl + lw * l, H);
    ctx.setLineDash([]);

    const tl = laneX(state.playerLane);
    const gradHL = ctx.createLinearGradient(tl, state.py, tl, state.py - H * 0.35);
    gradHL.addColorStop(0, 'rgba(255,77,46,0.07)');
    gradHL.addColorStop(1, 'rgba(255,77,46,0)');
    ctx.fillStyle = gradHL;
    ctx.fillRect(tl - lw / 2, state.py - H * 0.35, lw, H * 0.35);
  }

  function drawSkidMarks() {
    state.skidMarks.forEach(m => {
      ctx.fillStyle = `rgba(35,35,45,${m.a})`;
      ctx.fillRect(m.x, m.y, 5, m.len);
    });
  }

  function drawRain(W, H, dark) {
    const alpha = Math.min(0.75, state.t * 0.028);
    if (alpha < 0.01) return;
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(170,195,230,1)' : 'rgba(90,120,170,1)';
    ctx.lineWidth = 1;
    state.rain.forEach(d => {
      ctx.globalAlpha = d.a * alpha;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 3, d.y + d.len);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawSpeedLines(W, H) {
    const intensity = Math.min(1, (state.speed - 115) / 115);
    const cx = W / 2, cy = H * 0.5;
    ctx.save();
    for (let i = 0; i < 20; i++) {
      const ang = (i / 20) * Math.PI * 2;
      const len = (50 + Math.random() * 90) * intensity;
      const d0 = W * 0.34, d1 = d0 + len;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * d0, cy + Math.sin(ang) * d0);
      ctx.lineTo(cx + Math.cos(ang) * d1, cy + Math.sin(ang) * d1);
      ctx.strokeStyle = `rgba(255,255,255,${0.05 * intensity})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPredictionTrails() {
    const scroll = (state.speed / 60) * BASE_SCROLL;
    ctx.setLineDash([4, 9]);
    ctx.strokeStyle = 'rgba(255,200,60,0.22)';
    ctx.lineWidth = 1;
    state.obstacles.forEach(o => {
      if (o.y >= state.py || o.y <= state.py - canvas.height * 0.5) return;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      for (let s = 1; s <= 7; s++) {
        ctx.lineTo(o.x, o.y + scroll * (s * 0.13) * (1 + o.sf));
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  function drawPowerups() {
    state.powerups.forEach(p => {
      const pulse = (Math.sin(state.t * 4) + 1) / 2;
      ctx.save();
      ctx.translate(p.x, p.y);

      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 24);
      grd.addColorStop(0, `rgba(74,222,128,${0.28 + pulse * 0.18})`);
      grd.addColorStop(1, 'rgba(74,222,128,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();

      // Hexagon shield icon
      ctx.strokeStyle = `rgba(74,222,128,${0.65 + pulse * 0.3})`;
      ctx.fillStyle = 'rgba(74,222,128,0.14)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 6 + p.angle * 0.25;
        i === 0 ? ctx.moveTo(Math.cos(a) * 12, Math.sin(a) * 12) : ctx.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.font = `bold 7px 'JetBrains Mono', monospace`;
      ctx.fillStyle = 'rgba(74,222,128,0.9)';
      ctx.textAlign = 'center';
      ctx.fillText('SHIELD', 0, 26);
      ctx.textAlign = 'left';
      ctx.restore();
    });
  }

  function drawSensors(H, dark) {
    const { px, py } = state;
    const sr = H * 0.44;

    // Range rings
    [0.33, 0.66, 1].forEach((f, i) => {
      ctx.beginPath(); ctx.arc(px, py, sr * f, -Math.PI, 0);
      ctx.strokeStyle = `rgba(255,77,46,${0.06 + i * 0.03})`;
      ctx.lineWidth = 1;
      ctx.setLineDash(i < 2 ? [4, 8] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Range labels
    ctx.font = `8px 'JetBrains Mono', monospace`;
    ctx.fillStyle = 'rgba(255,77,46,0.45)';
    ctx.textAlign = 'right';
    [0.33, 0.66, 1].forEach(f => {
      ctx.fillText(`${Math.round(sr * f * 0.3)}m`, px - 6, py - sr * f + 10);
    });
    ctx.textAlign = 'left';

    // LiDAR rays
    const NR = 36;
    for (let i = 0; i <= NR; i++) {
      const ang = -Math.PI + (Math.PI / NR) * i;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let hitD = sr;
      state.obstacles.forEach(o => {
        const dx = o.x - px, dy = o.y - py;
        const dot = dx * ca + dy * sa;
        if (dot > 15 && dot < sr) {
          const perp = Math.abs(-dx * sa + dy * ca);
          if (perp < o.w * 0.6) hitD = Math.min(hitD, dot - o.w * 0.45);
        }
      });
      const hit = hitD < sr - 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + ca * hitD, py + sa * hitD);
      ctx.strokeStyle = hit ? 'rgba(255,77,46,0.6)' : 'rgba(255,77,46,0.06)';
      ctx.lineWidth = hit ? 1.5 : 0.5;
      ctx.stroke();
      if (hit) {
        ctx.fillStyle = ACC;
        ctx.fillRect(px + ca * hitD - 2, py + sa * hitD - 2, 4, 4);
      }
    }

    // Camera frustum
    const fov = Math.PI / 4.2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(-Math.PI / 2 - fov) * sr * 0.7, py + Math.sin(-Math.PI / 2 - fov) * sr * 0.7);
    ctx.arc(px, py, sr * 0.7, -Math.PI / 2 - fov, -Math.PI / 2 + fov);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,222,128,0.04)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(74,222,128,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // RADAR sweep overlay on inner half
    const radarR = sr * 0.42;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, radarR, -Math.PI, 0);
    ctx.closePath();
    ctx.clip();
    const sw = state.radarAngle;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, radarR, sw - 0.7, sw);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,222,200,0.13)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(sw) * radarR, py + Math.sin(sw) * radarR);
    ctx.strokeStyle = 'rgba(74,222,200,0.65)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Sensor labels
    ctx.font = `8px 'JetBrains Mono', monospace`;
    ctx.fillStyle = 'rgba(255,77,46,0.5)';
    ctx.fillText('LiDAR', px - sr - 2, py - 4);
    ctx.fillStyle = 'rgba(74,222,128,0.5)';
    ctx.fillText('CAM', px + 8, py - sr * 0.7 - 6);
    ctx.fillStyle = 'rgba(74,222,200,0.5)';
    ctx.fillText('RADAR', px - radarR - 32, py - radarR * 0.55);
  }

  function drawObstacles(dark) {
    state.obstacles.forEach(o => {
      const { x, y, w, h, clr, truck } = o;
      ctx.save();
      ctx.translate(x, y);

      ctx.fillStyle = dark ? 'rgba(24,28,38,0.97)' : 'rgba(175,180,192,0.97)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = clr;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-w / 2, -h / 2, w, h);

      if (truck) {
        ctx.fillStyle = dark ? 'rgba(16,20,28,0.9)' : 'rgba(155,160,172,0.9)';
        ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w - 4, h * 0.28);
        ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h * 0.28);
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 3, -h / 2 + h * 0.3);
        ctx.lineTo(w / 2 - 3, -h / 2 + h * 0.3);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(100,160,220,0.32)';
        ctx.fillRect(-w / 2 + 3, -h / 2 + 4, w - 6, h * 0.27);
      }

      ctx.fillStyle = '#cc2222';
      ctx.fillRect(-w / 2 + 1, h / 2 - 6, 6, 4);
      ctx.fillRect(w / 2 - 7, h / 2 - 6, 6, 4);

      ctx.restore();
    });
  }

  function drawDetections(dark) {
    state.apDetections.forEach(o => {
      if (o.conf == null) return;
      const pad = 10;
      const bx = o.x - o.w / 2 - pad, by = o.y - o.h / 2 - pad;
      const bw = o.w + pad * 2, bh = o.h + pad * 2;
      const c = o.conf > 0.85 ? '#ff4d2e' : o.conf > 0.70 ? '#f5a623' : '#4ade80';
      const cs = 9;

      ctx.strokeStyle = c; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);

      ctx.lineWidth = 2.5;
      [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]].forEach(([cx, cy, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * cs); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * cs, cy);
        ctx.stroke();
      });

      const label = `${o.truck ? 'TRUCK' : 'VEHICLE'} ${Math.round(o.conf * 100)}%`;
      const distM = Math.round((state.py - o.y) * 0.3);
      ctx.font = `bold 9px 'JetBrains Mono', monospace`;
      ctx.fillStyle = c;
      ctx.fillText(label, bx, by - 13);
      ctx.font = `9px 'JetBrains Mono', monospace`;
      ctx.fillStyle = dark ? 'rgba(200,205,218,0.65)' : 'rgba(50,55,68,0.65)';
      ctx.fillText(`${distM}m ahead`, bx, by - 3);
    });
  }

  function drawAPPath() {
    if (state.apState !== 'PLANNING' && state.apState !== 'EXECUTING') return;
    const tx = laneX(state.playerLane);
    ctx.beginPath();
    ctx.moveTo(state.px, state.py - CAR_H / 2);
    ctx.bezierCurveTo(state.px, state.py - 90, tx, state.py - 180, tx, state.py - 250);
    ctx.strokeStyle = 'rgba(255,77,46,0.45)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 7]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawPlayerCar() {
    const { px, py } = state;
    const w = CAR_W, h = CAR_H;
    ctx.save();
    ctx.translate(px, py);

    // Shield aura
    if (state.shieldActive) {
      const pulse = (Math.sin(state.t * 5) + 1) / 2;
      ctx.beginPath(); ctx.arc(0, 0, w * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(74,222,128,${0.5 + pulse * 0.35})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = `rgba(74,222,128,0.06)`;
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(6,8,11,0.97)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = ACC; ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = ACC; ctx.lineWidth = 1.5;
    ctx.strokeRect(-w / 2 + 4, -h / 2 + 10, w - 8, h * 0.37);

    ctx.fillStyle = '#fff5b0';
    ctx.fillRect(-w / 2 + 1, -h / 2 + 1, 7, 4);
    ctx.fillRect(w / 2 - 8, -h / 2 + 1, 7, 4);

    ctx.beginPath(); ctx.arc(0, -3, 6, 0, Math.PI * 2);
    ctx.fillStyle = ACC; ctx.fill();

    const pulse = (state.t * 1.6) % 1;
    ctx.beginPath(); ctx.arc(0, -3, 6 + pulse * 16, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,77,46,${0.65 * (1 - pulse)})`;
    ctx.lineWidth = 1.5; ctx.stroke();

    ctx.restore();
  }

  function drawParticles() {
    state.particles.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.a);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz);
    });
    ctx.globalAlpha = 1;
  }

  function drawPopups() {
    state.popups.forEach(p => {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.a));
      ctx.textAlign = 'center';
      ctx.font = `bold 12px 'JetBrains Mono', monospace`;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    });
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  function drawHUD(W, H, dark) {
    const pad = 16;
    const bg = dark ? 'rgba(8,9,11,0.86)' : 'rgba(238,239,242,0.92)';
    const bd = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.14)';
    const fg = dark ? 'rgba(242,243,245,0.93)' : 'rgba(13,15,19,0.93)';
    const mu = dark ? 'rgba(170,176,184,0.72)' : 'rgba(80,87,106,0.72)';

    // Left panel
    const lpH = 108;
    rrect(pad, pad, 192, lpH, 4, bg, bd);
    ctx.font = `700 9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = state.ap ? '#4ade80' : mu;
    ctx.fillText(state.ap ? '● AUTOPILOT ON' : '○ MANUAL', pad + 12, pad + 22);
    if (state.ap) {
      ctx.fillStyle = ACC;
      ctx.fillText(state.apState, pad + 12, pad + 35);
    }
    if (state.shieldActive) {
      ctx.fillStyle = '#4ade80';
      ctx.font = `700 8px 'JetBrains Mono', monospace`;
      ctx.fillText('⬡ SHIELD', pad + 120, pad + 22);
    }
    // Speed
    ctx.font = `700 32px 'JetBrains Mono', monospace`;
    ctx.fillStyle = fg;
    ctx.fillText(Math.round(state.speed), pad + 12, pad + 90);
    ctx.font = `9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = mu;
    ctx.fillText('km/h', pad + 68, pad + 90);
    // Speed arc gauge
    drawSpeedGauge(pad + 155, pad + lpH / 2 + 4, 28, dark, fg);

    // Right panel
    const rx = W - pad - 192;
    rrect(rx, pad, 192, lpH, 4, bg, bd);
    ctx.font = `700 9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = mu;
    ctx.fillText('SCORE', rx + 12, pad + 22);

    // Multiplier badge
    if (state.multiplier > 1) {
      const mc = state.multiplier >= 4 ? ACC : '#f5a623';
      rrect(rx + 100, pad + 9, 52, 17, 3, mc, null);
      ctx.font = `700 8px 'JetBrains Mono', monospace`;
      ctx.fillStyle = '#08090b';
      ctx.textAlign = 'center';
      ctx.fillText(`x${state.multiplier} STREAK`, rx + 126, pad + 21);
      ctx.textAlign = 'left';
    }

    ctx.font = `700 22px 'JetBrains Mono', monospace`;
    ctx.fillStyle = ACC;
    ctx.fillText(String(Math.floor(state.score)).padStart(6, '0'), rx + 12, pad + 54);
    ctx.font = `9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = mu;
    ctx.fillText(`${Math.round(state.dist)}m`, rx + 12, pad + 70);
    ctx.fillText(`HI: ${state.hiScore}`, rx + 90, pad + 70);

    // Mini radar in top center (AP mode)
    if (state.ap) drawMiniRadar(W, bg, bd, dark);

    ctx.textAlign = 'right';
    ctx.font = `9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = mu;
    ctx.fillText('[ESC] EXIT', W - pad, pad + 12);
    ctx.textAlign = 'left';

    if (state.t < 8 && !state.dead) {
      const hint = state.ap
        ? '[A] manual  ·  autopilot active'
        : '[←][→] steer  ·  [A] autopilot  ·  [ESC] exit';
      ctx.textAlign = 'center';
      ctx.font = `9px 'JetBrains Mono', monospace`;
      ctx.fillStyle = mu;
      ctx.fillText(hint, W / 2, H - 22);
      ctx.textAlign = 'left';
    }

    if (W < 1000) drawMobileBtns(W, H, bg, bd, fg, mu);
  }

  function drawSpeedGauge(cx, cy, r, dark, fg) {
    const maxSpd = 230;
    const ratio = Math.min(1, state.speed / maxSpd);
    const startA = Math.PI * 0.75;
    const endA = startA + ratio * Math.PI * 1.5;

    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (ratio > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, startA, endA);
      ctx.strokeStyle = ratio > 0.8 ? ACC : ratio > 0.5 ? '#f5a623' : '#4ade80';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  function drawMiniRadar(W, bg, bd, dark) {
    const r = 40;
    const cx = W / 2;
    const cy = 16 + 12 + r;

    rrect(cx - r - 12, 16, (r + 12) * 2, r * 2 + 24, 4, bg, bd);

    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = dark ? 'rgba(0,25,15,0.55)' : 'rgba(190,240,210,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(74,222,128,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    [0.33, 0.66, 1].forEach(f => {
      ctx.beginPath(); ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(74,222,128,0.1)';
      ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(74,222,128,0.13)';
    ln(cx - r, cy, cx + r, cy);
    ln(cx, cy - r, cx, cy + r);

    // Radar sweep
    const sw = state.radarAngle;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, sw - 0.75, sw);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,222,128,0.16)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sw) * r, cy + Math.sin(sw) * r);
    ctx.strokeStyle = 'rgba(74,222,128,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Player dot
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = ACC; ctx.fill();

    // Obstacle blips
    const sensorR = canvas.height * 0.44;
    state.obstacles.forEach(o => {
      const rx = (o.x - state.px) / (canvas.width * ROAD_RATIO) * r * 0.85;
      const ry = (o.y - state.py) / sensorR * r;
      if (Math.hypot(rx, ry) > r) return;
      ctx.beginPath(); ctx.arc(cx + rx, cy + ry, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = o.conf != null && o.conf > 0.85 ? ACC : '#f5a623';
      ctx.fill();
    });

    ctx.font = `7px 'JetBrains Mono', monospace`;
    ctx.fillStyle = 'rgba(74,222,128,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('RADAR', cx, 16 + r * 2 + 22);
    ctx.textAlign = 'left';
  }

  function drawMobileBtns(W, H, bg, bd, fg) {
    const bw = 64, bh = 50, by = H - 78, bp = 20;
    const z = getBtnZones();

    rrect(bp, by, bw, bh, 8, bg, bd);
    rrect(z.rStart, by, bw, bh, 8, bg, bd);
    rrect(W - bp - bw, by, bw, bh, 8, state.ap ? ACC : bg, bd);

    ctx.textAlign = 'center';
    ctx.font = `bold 20px sans-serif`;
    ctx.fillStyle = fg;
    ctx.fillText('◀', bp + bw / 2, by + bh / 2 + 7);
    ctx.fillText('▶', z.rStart + bw / 2, by + bh / 2 + 7);
    ctx.font = `bold 9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = state.ap ? '#08090b' : fg;
    ctx.fillText('AUTO', W - bp - bw / 2, by + bh / 2 + 3);
    ctx.textAlign = 'left';
  }

  function drawGameOver(W, H, dark) {
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    ctx.font = `800 60px 'Saira Condensed', sans-serif`;
    ctx.fillStyle = ACC;
    ctx.fillText('COLLISION', W / 2, H / 2 - 60);

    ctx.font = `600 32px 'Saira Condensed', sans-serif`;
    ctx.fillStyle = dark ? '#f2f3f5' : '#0d0f13';
    ctx.fillText(`SCORE  ${String(Math.floor(state.score)).padStart(6, '0')}`, W / 2, H / 2 - 10);

    ctx.font = `10px 'JetBrains Mono', monospace`;
    ctx.fillStyle = dark ? 'rgba(170,176,184,0.85)' : 'rgba(80,87,106,0.85)';
    ctx.fillText(`${Math.round(state.dist)}m driven  ·  HI: ${state.hiScore}`, W / 2, H / 2 + 22);

    ctx.font = `bold 11px 'JetBrains Mono', monospace`;
    ctx.fillStyle = ACC;
    ctx.fillText('[R] RESTART  ·  [ESC] EXIT TO PORTFOLIO', W / 2, H / 2 + 64);

    if (W < 900) {
      ctx.font = `10px 'JetBrains Mono', monospace`;
      ctx.fillStyle = 'rgba(170,176,184,0.6)';
      ctx.fillText('tap screen to restart', W / 2, H / 2 + 86);
    }

    ctx.textAlign = 'left';
  }

  // ─── UTILS ────────────────────────────────────────────────────────

  function ln(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

  function rrect(x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

})();
