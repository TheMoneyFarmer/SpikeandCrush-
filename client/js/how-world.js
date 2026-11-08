'use strict';
// "How a match works": one continuous 3D flight, scrubbed by scrolling, through
// three small worlds joined by a giant price chart. It's a real example round:
// trades open and close, rivals trade the same market, and the finish is earned,
// including last place with no coins. Rules are in how-match.js. Only the visitor
// trades for the visitor: rivals keep playing, but nothing presses their buttons.
//
// All reading text and every button is ordinary HTML over the canvas. The page's
// default markup is the static version (three pictures with text), so reduced
// motion, Save-Data, no WebGL or a failed download simply stay on that.
(function () {
  // ADJUST HERE ----------------------------------------------------------------
  const TUNE = {
    flightSmoothing: 5,     // how quickly the camera catches the scroll position
    sfxVolume: 0.55,
    maxPixelRatioDesktop: 2,
    maxPixelRatioPhone: 1.5,
  };
  // Scroll stops: [scroll position, camera stop]. Equal stops in a row are the
  // places where the camera holds so visitors can play.
  const STOPS = [[0, 0], [0.05, 0], [0.2, 2], [0.36, 2], [0.5, 4], [0.66, 4], [0.8, 6], [1, 6]];
  const CHAPTERS = [[0.12, -1], [0.43, 0], [0.73, 1], [2, 2]]; // chapter until this scroll position
  const THREE_URL = '/vendor/three-0.187.0/three-lite.min.js';
  // ----------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const track = $('howTrack'), stage = $('howStage');
  if (!track || !stage) return;
  const qa = new URLSearchParams(location.search).has('qa');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = navigator.connection && navigator.connection.saveData;
  const webgl = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })();
  if (reduced.matches || saveData || !webgl || !window.SCCardArt || !window.SCHowMatch) return; // the static version stays

  const root = document.documentElement;
  root.classList.add('how-3d');
  let world = null, dead = false;
  function goStatic() {
    if (dead) return;
    dead = true;
    root.classList.remove('how-3d');
    if (world) world.destroy();
  }
  reduced.addEventListener('change', () => { if (reduced.matches) goStatic(); });

  const isPhone = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const damp = (k, dt) => 1 - Math.exp(-k * dt);
  const easeOutBack = (t) => { const c = 1.70158; const x = t - 1; return 1 + (c + 1) * x * x * x + c * x * x; };
  const easeInCubic = (t) => t * t * t;
  function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const rng = mulberry(20261108);

  // ---- sound: the game's own recordings; silent until the visitor touches the section ----
  const Sfx = (function () {
    const cache = {}; let engaged = false, on = true;
    try { const s = JSON.parse(localStorage.getItem('tw_audio_settings') || '{}'); if (s.muted) on = false; } catch (e) {}
    const btn = $('howSound');
    const label = () => { btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? 'Sound on' : 'Sound off'; };
    label();
    btn.addEventListener('click', () => {
      on = !on; label();
      try { const s = JSON.parse(localStorage.getItem('tw_audio_settings') || '{}'); s.muted = !on; localStorage.setItem('tw_audio_settings', JSON.stringify(s)); } catch (e) {}
    });
    stage.addEventListener('pointerdown', () => { engaged = true; });
    stage.addEventListener('keydown', () => { engaged = true; });
    return function play(name, vol = 1) {
      if (!engaged || !on) return;
      let base = cache[name];
      if (!base) { base = new Audio(`/assets/sounds/sfx/${name}.mp3`); base.preload = 'auto'; cache[name] = base; }
      const a = base.cloneNode();
      a.volume = clamp(TUNE.sfxVolume * vol, 0, 1);
      a.playbackRate = 0.97 + rng() * 0.06;
      a.play().catch(() => {});
    };
  })();

  async function start() {
    const THREE = await import(THREE_URL);
    await window.SCCardArt.fontsReady();
    if (dead) return;
    world = build(THREE);
    window.__howReady = true;
  }

  // ==========================================================================
  function build(THREE) {
    const renderer = new THREE.WebGLRenderer({ antialias: !isPhone, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    let ratioCap = isPhone ? TUNE.maxPixelRatioPhone : TUNE.maxPixelRatioDesktop;
    let pixelRatio = Math.min(devicePixelRatio || 1, ratioCap);
    renderer.setPixelRatio(pixelRatio);
    const canvas = renderer.domElement;
    canvas.className = 'how-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    stage.prepend(canvas);

    const scene = new THREE.Scene();
    const SKY = new THREE.Color('#0a1226');
    scene.background = SKY;
    scene.fog = new THREE.Fog(SKY, 140, 340);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x10182e, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(14, 26, 18); scene.add(sun);
    const flash = new THREE.PointLight(0xffffff, 0, 34, 1.6); scene.add(flash); // impacts light their surroundings

    const COLORS = { spike: 0x1fd38a, crush: 0xff4d6a, blue: 0x2d7ff9, gold: 0xf5b83d, slate: 0x3b4d78, ice: 0x8cc4ff };
    const col = (h) => new THREE.Color(h);
    const v = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
    const dummy = new THREE.Object3D();

    // ---- shared textures ----
    function softDot() {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    }
    const dotTex = softDot();
    function gridTexture() {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const x = c.getContext('2d');
      x.fillStyle = '#101a33'; x.fillRect(0, 0, 512, 512);
      x.strokeStyle = 'rgba(108,178,255,.28)'; x.lineWidth = 2;
      for (let i = 0; i <= 512; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.moveTo(0, i); x.lineTo(512, i); x.stroke(); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3);
      t.anisotropy = Math.min(6, renderer.capabilities.getMaxAnisotropy());
      return t;
    }
    const floorTex = gridTexture();
    function textSprite(text, { size = 64, weight = 600, color = '#f2f5fa', scale = 1, pad = 24 } = {}) {
      const c = document.createElement('canvas'); let x = c.getContext('2d');
      const font = `${weight} ${size}px Inter, system-ui, sans-serif`;
      x.font = font; const w = Math.ceil(x.measureText(text).width) + pad * 2;
      c.width = w; c.height = Math.ceil(size * 1.5);
      x = c.getContext('2d'); x.font = font; x.textBaseline = 'middle'; x.textAlign = 'center';
      x.shadowColor = 'rgba(5,10,24,.9)'; x.shadowBlur = size * 0.2;
      x.fillStyle = color; x.fillText(text, w / 2, c.height / 2);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
      s.scale.set((w / size) * scale, (c.height / size) * scale, 1);
      return s;
    }

    // ---- platforms ----
    function platform(r, pos) {
      const g = new THREE.Group(); g.position.copy(pos);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.74, 1.6, 6), new THREE.MeshStandardMaterial({ color: 0x18264a, roughness: 0.8, metalness: 0.2, flatShading: true }));
      body.position.y = -0.8; g.add(body);
      const under = new THREE.Mesh(new THREE.ConeGeometry(r * 0.74, r * 0.8, 6), new THREE.MeshStandardMaterial({ color: 0x0f1a36, roughness: 0.9, flatShading: true }));
      under.rotation.x = Math.PI; under.position.y = -1.6 - r * 0.4; g.add(under);
      const top = new THREE.Mesh(new THREE.CircleGeometry(r * 0.995, 6), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, opacity: 0.86, fog: true }));
      top.rotation.x = -Math.PI / 2; top.rotation.z = Math.PI / 6; top.position.y = 0.01; g.add(top);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.03, r + 0.03, 0.14, 6, 1, true), new THREE.MeshBasicMaterial({ color: COLORS.blue, side: THREE.DoubleSide }));
      rim.position.y = -0.04; g.add(rim);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: COLORS.blue, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
      halo.scale.set(r * 3.4, r * 2.4, 1); halo.position.y = -1; g.add(halo);
      scene.add(g);
      return g;
    }
    const A = new THREE.Vector3(0, 0, 0), B = new THREE.Vector3(46, -5, -26), C = new THREE.Vector3(94, 3, -10);
    const floorA = platform(13.5, A), floorB = platform(13, B), floorC = platform(11.5, C);

    // ---- the connecting ribbon: a price chart you could walk on ----
    let brandUp, brandNot;
    const ribbonPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(11, 0.5, -8), new THREE.Vector3(20, 6, -14), new THREE.Vector3(29, 13, -22),
      new THREE.Vector3(36, 0, -42), new THREE.Vector3(47, -11, -56), new THREE.Vector3(62, -9, -52),
      new THREE.Vector3(77, -1, -38), new THREE.Vector3(88, 5, -24),
    ]);
    {
      const n = isPhone ? 95 : 190;
      const bodyGeo = new THREE.BoxGeometry(0.46, 1, 0.46), wickGeo = new THREE.BoxGeometry(0.08, 1, 0.08);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const bodies = new THREE.InstancedMesh(bodyGeo, mat, n), wicks = new THREE.InstancedMesh(wickGeo, mat, n);
      const green = col(COLORS.spike), red = col(COLORS.crush);
      let prevY = ribbonPath.getPoint(0).y;
      for (let i = 0; i < n; i++) {
        ribbonPath.getPoint(i / (n - 1), v);
        const jitter = (rng() - 0.5) * 0.7, y = v.y + jitter, up = y >= prevY;
        const h = Math.max(0.25, Math.abs(y - prevY) * 1.4 + 0.3);
        dummy.position.set(v.x, (y + prevY) / 2, v.z); dummy.scale.set(1, h, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix); bodies.setColorAt(i, up ? green : red);
        dummy.scale.set(1, h + 0.8 + rng() * 0.7, 1); dummy.updateMatrix();
        wicks.setMatrixAt(i, dummy.matrix); wicks.setColorAt(i, up ? green : red);
        prevY = y;
      }
      bodies.frustumCulled = wicks.frustumCulled = false;
      scene.add(bodies, wicks);
      brandUp = textSprite('Up.', { size: 120, weight: 300, color: '#1fd38a', scale: 3.4 }); brandUp.position.set(18, 15.5, -14); scene.add(brandUp);
      brandNot = textSprite('Then not.', { size: 120, weight: 300, color: '#ff4d6a', scale: 3.4 }); brandNot.position.set(45, 8.5, -44); scene.add(brandNot);
    }

    // ---- soft colour behind each world ----
    [[A, COLORS.spike, 62], [B, COLORS.crush, 62], [C, COLORS.gold, 52]].forEach(([at, colour, size]) => {
      const n = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: colour, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false }));
      n.scale.set(size * 1.5, size, 1); n.position.set(at.x, at.y + 4, at.z - 24); n.renderOrder = -2; scene.add(n);
    });

    // ---- dust ----
    {
      const n = isPhone ? 180 : 520, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pos[i * 3] = -40 + rng() * 180; pos[i * 3 + 1] = -22 + rng() * 60; pos[i * 3 + 2] = -80 + rng() * 110; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const dust = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex, color: 0x9cc4ff, size: 0.34, transparent: true, opacity: 0.62, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      scene.add(dust); var dustField = dust;
    }

    // ---- TRADING FLOOR: live candles with a mirror-floor reflection ----
    const N = isPhone ? 26 : 38;
    const chart = {
      prices: [], opens: [], candleT: 0, mid: 100, scale: 0.42, price: 100,
      span: 18.5, base: 4.5, z: -4,
      bodies: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff }), N),
      wicks: new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 1, 0.07), new THREE.MeshBasicMaterial({ color: 0xffffff }), N),
    };
    chart.bodies.frustumCulled = chart.wicks.frustumCulled = false;
    const chartGroup = new THREE.Group(); chartGroup.position.set(A.x, A.y, A.z + chart.z); scene.add(chartGroup);
    chartGroup.add(chart.bodies, chart.wicks);
    {
      // quiet history that ends exactly where the round's first price begins
      let p = 100 - N * 0.04;
      for (let i = 0; i < N; i++) { const o = p; p = i === N - 1 ? 100 : p + (rng() - 0.46) * 0.9; chart.opens.push(o); chart.prices.push(p); }
      chart.price = 100; chart.mid = 100; chart.bodies.setColorAt(0, col(COLORS.spike)); chart.wicks.setColorAt(0, col(COLORS.spike));
    }
    let mirrorMats = [];
    if (!isPhone) {
      [chart.bodies, chart.wicks].forEach((m) => {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
        const mirror = new THREE.InstancedMesh(m.geometry, mat, N);
        mirror.instanceMatrix = m.instanceMatrix; mirror.instanceColor = m.instanceColor;
        mirror.scale.y = -1; mirror.position.y = -0.02; mirror.frustumCulled = false; mirror.renderOrder = -1;
        chartGroup.add(mirror); mirrorMats.push(mat);
      });
    }
    const headGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: COLORS.spike, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    headGlow.scale.set(3.4, 3.4, 1); chartGroup.add(headGlow);
    const entryLine = new THREE.Mesh(new THREE.BoxGeometry(chart.span, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: COLORS.blue }));
    entryLine.visible = false; chartGroup.add(entryLine);
    const pnlFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: COLORS.spike, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    pnlFill.visible = false; pnlFill.position.z = -0.3; chartGroup.add(pnlFill);
    // desks: small rivals at their screens, so the floor reads as a place
    {
      const deskGeo = new THREE.BoxGeometry(2, 0.7, 1), screenGeo = new THREE.BoxGeometry(1.3, 0.78, 0.05);
      const sc = document.createElement('canvas'); sc.width = 128; sc.height = 76;
      const sx = sc.getContext('2d');
      sx.fillStyle = '#0b1428'; sx.fillRect(0, 0, 128, 76);
      sx.strokeStyle = '#ffffff'; sx.lineWidth = 4; sx.lineJoin = 'round'; sx.beginPath();
      [[8, 58], [28, 46], [44, 52], [64, 30], [82, 38], [100, 18], [120, 26]].forEach(([x, y], i) => (i ? sx.lineTo(x, y) : sx.moveTo(x, y)));
      sx.stroke();
      const screenTex = new THREE.CanvasTexture(sc); screenTex.colorSpace = THREE.SRGBColorSpace;
      const desks = new THREE.InstancedMesh(deskGeo, new THREE.MeshStandardMaterial({ color: 0x2c3f6e, roughness: 0.55 }), 5);
      const screens = new THREE.InstancedMesh(screenGeo, new THREE.MeshBasicMaterial({ map: screenTex }), 5);
      const spots = [[-9.4, 1.2], [-5, 4.2], [0, 5.2], [5, 4.2], [9.4, 1.2]];
      const palette = [COLORS.spike, COLORS.crush, COLORS.ice, COLORS.spike, COLORS.crush];
      spots.forEach(([x, z], i) => {
        dummy.position.set(x, 0.35, z); dummy.rotation.set(0, x * 0.045, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); desks.setMatrixAt(i, dummy.matrix);
        dummy.position.set(x, 1.15, z - 0.28); dummy.rotation.x = -0.14; dummy.updateMatrix(); screens.setMatrixAt(i, dummy.matrix); screens.setColorAt(i, col(palette[i]));
      });
      scene.add(desks, screens);
    }

    // ---- ARENA: one tower per player, height follows their balance ----
    const towerGeo = new THREE.CylinderGeometry(1.34, 1.34, 1, 6).toNonIndexed(); towerGeo.translate(0, 0.5, 0); towerGeo.computeVertexNormals();
    const capGeo = new THREE.CylinderGeometry(1.42, 1.42, 0.14, 6);
    const shellGeo = new THREE.CylinderGeometry(1.8, 1.8, 1, 6); shellGeo.translate(0, 0.5, 0);
    const plateGeo = new THREE.CylinderGeometry(1.38, 1.38, 0.06, 6);
    const MAX_PLATES = 12;
    const glowGeo = new THREE.CircleGeometry(3.4, 24);
    function makeTower(name, colour, parent, x, z) {
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const bodyMat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.62, metalness: 0, emissive: colour, emissiveIntensity: 0.22 });
      const body = new THREE.Mesh(towerGeo, bodyMat); g.add(body);
      const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: colour })); g.add(cap);
      const plates = new THREE.InstancedMesh(plateGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).lerp(new THREE.Color(0xffffff), 0.22) }), MAX_PLATES);
      plates.frustumCulled = false; g.add(plates);
      const label = textSprite(name, { size: 72, weight: 600, scale: 0.82 }); g.add(label);
      // contact glow: lies flat on the floor, so it can't slice through the tower
      const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ map: dotTex, color: colour, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = 0.03; g.add(glow);
      parent.add(g);
      const t = { name, g, body, bodyMat, cap, label, plates, shownPlates: -1, h: 3, target: 3, vel: 0, x, z, colour, punch: 0, flash: 0 };
      return t;
    }
    const arena = new THREE.Group(); arena.position.copy(B); scene.add(arena);
    const layout = [[-7.5, 1.6], [-2.5, -2.2], [2.5, -2.2], [7.5, 1.6]];
    const targetRing = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.45, 6), new THREE.MeshBasicMaterial({ color: COLORS.crush, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
    targetRing.rotation.x = -Math.PI / 2; targetRing.rotation.z = Math.PI / 6; targetRing.position.y = 0.06; arena.add(targetRing);
    const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.8, 4), new THREE.MeshBasicMaterial({ color: COLORS.crush })); chevron.rotation.x = Math.PI; arena.add(chevron);

    // ---- FINAL BELL: podium pillars, the bell, the coins ----
    const podiumDefs = [[0, -1], [-4.6, 0.6], [4.6, 0.6], [8.1, 3.2]]; // 1st, 2nd, 3rd, last
    const podium = new THREE.Group(); podium.position.copy(C); scene.add(podium);
    const pillars = podiumDefs.map(([x, z]) => {
      const t = makeTower('You', COLORS.slate, podium, x, z);
      t.h = 0.4; t.target = 0.4; t.label.visible = false; t.names = {};
      ['You', 'Rival', 'Player 3', 'Player 4'].forEach((n) => { const l = textSprite(n, { size: 72, weight: 600, scale: 0.82 }); l.visible = false; t.g.add(l); t.names[n] = l; });
      return t;
    });
    const crown = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.05, 6), new THREE.MeshBasicMaterial({ color: COLORS.gold, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false }));
    crown.rotation.x = -Math.PI / 2; crown.rotation.z = Math.PI / 6; crown.position.set(0, 0.07, -1); podium.add(crown);
    const bellPts = [[0, 1.5], [0.2, 1.48], [0.48, 1.25], [0.62, 0.8], [0.72, 0.35], [0.95, 0.03], [1.1, 0]].map(([x, y]) => new THREE.Vector2(x * 1.5, y * 1.5));
    const bell = new THREE.Group(); bell.position.set(0, 12.8, -3.4); podium.add(bell);
    {
      const body = new THREE.Mesh(new THREE.LatheGeometry(bellPts, 22), new THREE.MeshStandardMaterial({ color: 0xa8c0e8, metalness: 0.35, roughness: 0.32, side: THREE.DoubleSide, emissive: 0x2a3d66, emissiveIntensity: 0.5 }));
      body.position.y = -2.25; bell.add(body);
      const clapper = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshStandardMaterial({ color: 0x55688f })); clapper.position.y = -2.3; bell.add(clapper);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0x2c3c63 })); podium.add(arm); arm.position.set(0, 13, -3.4);
      [-2.75, 2.75].forEach((x) => { const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 13, 0.3), new THREE.MeshStandardMaterial({ color: 0x2c3c63 })); post.position.set(x, 6.5, -3.4); podium.add(post); });
    }
    const COIN_N = isPhone ? 42 : 90;
    const coins = {
      mesh: new THREE.InstancedMesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 14), new THREE.MeshStandardMaterial({ color: COLORS.gold, metalness: 0.15, roughness: 0.38, emissive: 0xa86f0c, emissiveIntensity: 0.85 }), COIN_N),
      list: [], active: false,
    };
    coins.mesh.frustumCulled = false; coins.mesh.visible = false; podium.add(coins.mesh);
    for (let i = 0; i < COIN_N; i++) {
      coins.list.push({ x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, sx: 0, sz: 0, delay: 0, rest: true });
      dummy.position.set(0, -50, 0); dummy.scale.setScalar(1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); coins.mesh.setMatrixAt(i, dummy.matrix);
    }

    // ---- effects, all pooled ----
    const fxN = isPhone ? 90 : 180;
    const fx = { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), fxN), items: [], next: 0 };
    fx.mesh.frustumCulled = false; scene.add(fx.mesh);
    for (let i = 0; i < fxN; i++) { fx.items.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, floor: -99, g: 18, s: 1 }); fx.mesh.setMatrixAt(i, new THREE.Object3D().matrix); fx.mesh.setColorAt(i, col(0xffffff)); }
    const hideMatrix = (() => { dummy.position.set(0, -500, 0); dummy.scale.setScalar(0.001); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); return dummy.matrix.clone(); })();
    for (let i = 0; i < fxN; i++) fx.mesh.setMatrixAt(i, hideMatrix);
    const tmpColor = new THREE.Color();
    function burst(x, y, z, colour, count, speed = 7, opts = {}) {
      tmpColor.set(colour);
      for (let k = 0; k < count; k++) {
        const it = fx.items[fx.next], a = rng() * Math.PI * 2, e = rng() * 1.1;
        it.life = it.max = 0.5 + rng() * 0.6; it.x = x; it.y = y; it.z = z;
        const sp = speed * (0.45 + rng() * 0.75);
        it.vx = Math.cos(a) * Math.cos(e) * sp; it.vz = Math.sin(a) * Math.cos(e) * sp; it.vy = Math.sin(e) * sp + (opts.up || 1.5);
        it.floor = opts.floor ?? -99; it.g = opts.g ?? 18; it.s = 0.6 + rng() * 1.1;
        fx.mesh.setColorAt(fx.next, tmpColor);
        fx.next = (fx.next + 1) % fxN;
      }
      fx.mesh.instanceColor.needsUpdate = true;
    }
    const rings = [0, 1, 2, 3].map(() => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      m.visible = false; scene.add(m); return { m, t: 0, dur: 1, size: 1 };
    });
    let ringNext = 0;
    function ring(pos, colour, size, dur = 0.55, flat = true) {
      const r = rings[ringNext = (ringNext + 1) % rings.length];
      r.m.position.copy(pos); r.m.material.color.set(colour); r.size = size; r.t = 0; r.dur = dur; r.m.visible = true;
      if (flat) r.m.rotation.set(-Math.PI / 2, 0, 0); else r.m.rotation.set(0, 0, 0);
    }
    // stream particles (Pip Theft): travel an arc from one tower to another
    const streamN = 26;
    const stream = { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshBasicMaterial({ color: COLORS.spike, fog: false }), streamN), items: [], from: new THREE.Vector3(), to: new THREE.Vector3(), running: false };
    stream.mesh.frustumCulled = false; scene.add(stream.mesh);
    for (let i = 0; i < streamN; i++) { stream.items.push({ t: -1 }); stream.mesh.setMatrixAt(i, hideMatrix); }

    // flying cards: two slabs with pre-drawn faces, so playing one never hitches
    const cardFaces = {};
    const cardGeo = new THREE.PlaneGeometry(2.2, 3.1);
    function faceTex(id) {
      if (cardFaces[id]) return cardFaces[id];
      const c = document.createElement('canvas'); c.width = isPhone ? 300 : 512; c.height = Math.round(c.width * 3.1 / 2.2);
      window.SCCardArt.drawFace(c, window.SCCardArt.byId(id));
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      return (cardFaces[id] = t);
    }
    ['chart-ghost', 'force-close', 'pip-theft', 'news-bomb'].forEach(faceTex);
    const flyers = [0, 1].map(() => {
      const m = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: cardFaces['chart-ghost'], side: THREE.DoubleSide, fog: false, transparent: true }));
      m.visible = false; scene.add(m); return { m, t: 0, dur: 0.5, from: new THREE.Vector3(), to: new THREE.Vector3(), done: null, active: false };
    });

    // ---- camera path ----
    const camPts = [
      [52, 82, 118], [12, 26, 38], [0, 8.2, 24],
      [24, 19, 2], [46, 8.5, 2.5],
      [70, 15, -3], [94, 10.5, 15.5],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const lookPts = [
      [52, -6, -24], [4, 3, -3], [0, 4.7, -3.2],
      [30, 7, -26], [46, 0.8, -28],
      [78, 4, -18], [94, 7.3, -11],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const camCurve = new THREE.CatmullRomCurve3(camPts, false, 'centripetal');
    const lookCurve = new THREE.CatmullRomCurve3(lookPts, false, 'centripetal');
    const cam = { u: 0, target: 0, trauma: 0, fovKick: 0, kick: new THREE.Vector3(), pos: new THREE.Vector3(), look: new THREE.Vector3(), mx: 0, my: 0, pmx: 0, pmy: 0, speed: 0, shake: 0, offX: 0, offY: 0, framed: false };
    const addTrauma = (a) => { cam.trauma = Math.max(cam.trauma, a); };
    let hitStop = 0;

    function uFor(p) {
      for (let i = 1; i < STOPS.length; i++) {
        if (p <= STOPS[i][0]) {
          const [p0, s0] = STOPS[i - 1], [p1, s1] = STOPS[i];
          const t = p1 === p0 ? 1 : (p - p0) / (p1 - p0);
          return lerp(s0, s1, s0 === s1 ? t : smooth(t)) / 6;
        }
      }
      return 1;
    }

    // ---- sizing, with its own framing for tall screens ----
    let W = 0, H = 0, aspect = 1, pull = 1, overPull = 1;
    function fit() {
      W = stage.clientWidth; H = stage.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H, false);
      aspect = W / H;
      camera.aspect = aspect;
      pull = aspect < 0.7 ? 1.95 : aspect < 1.1 ? 1.45 : aspect < 1.5 ? 1.12 : 1;
      overPull = aspect < 0.7 ? 2.3 : aspect < 1.1 ? 1.5 : 1;
      scene.fog.far = 340 * overPull; scene.fog.near = 140 * overPull;
      camera.updateProjectionMatrix();
    }
    fit();
    new ResizeObserver(() => { fit(); renderFrame(); }).observe(stage);
    if (!isPhone) stage.addEventListener('pointermove', (e) => { const r = stage.getBoundingClientRect(); cam.pmx = (e.clientX - r.left) / r.width - 0.5; cam.pmy = (e.clientY - r.top) / r.height - 0.5; }, { passive: true });

    // ---- the match: rules live in how-match.js; everything below draws and reacts ----
    const M = window.SCHowMatch;
    const seedParam = Number(new URLSearchParams(location.search).get('seed'));
    const newSeed = () => (seedParam && qa ? seedParam : (Date.now() ^ (performance.now() * 1000)) >>> 0);
    let match = M.create(newSeed());
    const players = match.players.map((p) => ({ model: p }));
    const nameOf = (i) => match.players[i].name;

    players.forEach((p, i) => {
      p.name = p.model.name; p.me = p.model.me;
      p.tower = makeTower(p.name, p.me ? COLORS.blue : COLORS.slate, arena, layout[i][0], layout[i][1]);
      p.shown = 0;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 12, 6), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 6; hit.userData.player = i; p.tower.g.add(hit); p.hit = hit;
    });
    const hitTargets = players.filter((p) => !p.me).map((p) => p.hit);
    const pnlToH = (pnl) => clamp(3.2 + (pnl + 260) / 620 * 6.5, 1, 11.5);
    const shells = players.map((p) => {
      const s = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({ color: COLORS.ice, transparent: true, opacity: 0.34, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.visible = false; p.tower.g.add(s); return s;
    });

    // ---- HUD (real HTML) ----
    const hudRows = $('howRows'), timerEl = $('howTimer'), toastEl = $('howToast'), popWrap = $('howPops');
    const rowEls = players.map((p, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'how-row' + (p.me ? ' me' : ''); b.dataset.player = i;
      b.innerHTML = `<span class="rk"></span><span class="nm">${p.name}</span><span class="tag"></span><span class="pn"></span>`;
      if (p.me) b.tabIndex = -1;
      b.addEventListener('click', () => { if (!p.me && state.chapter === 1) setTarget(i, true); });
      hudRows.appendChild(b);
      return { b, rk: b.querySelector('.rk'), pn: b.querySelector('.pn'), tag: b.querySelector('.tag'), last: null, lastTag: null };
    });
    const fmt = (n) => { n = Math.round(n); return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-US'); };
    const fmtClock = (s) => { s = Math.max(0, Math.ceil(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    function paintBoard() {
      players.forEach((p, i) => {
        const row = rowEls[i], text = fmt(p.shown);
        if (row.last !== text) { row.pn.textContent = text; row.pn.className = 'pn ' + (p.shown >= 0 ? 'up' : 'dn'); row.last = text; }
        const mp = match.players[i];
        const tag = mp.frozen > 0 ? `Frozen ${Math.ceil(mp.frozen)}s` : mp.pos ? (mp.pos.dir > 0 ? 'Long' : 'Short') : '';
        if (row.lastTag !== tag) { row.tag.textContent = tag; row.tag.className = 'tag' + (mp.frozen > 0 ? ' ice' : mp.pos ? (mp.pos.dir > 0 ? ' long' : ' short') : ''); row.lastTag = tag; }
      });
    }
    function rerank() {
      M.standings(match).forEach((s, rank) => { rowEls[s.i].b.style.transform = `translateY(${rank * 100}%)`; rowEls[s.i].rk.textContent = rank + 1; });
    }
    let toastTimer = 0;
    function toast(html, secs = 3) { toastEl.innerHTML = html; toastEl.classList.add('show'); toastTimer = secs; }
    const pops = [0, 1, 2, 3, 4, 5].map(() => { const s = document.createElement('span'); s.className = 'how-pop'; popWrap.appendChild(s); return { s, t: 0, active: false, p: new THREE.Vector3() }; });
    let popNext = 0;
    function popNumber(worldPos, text, kind) {
      const it = pops[popNext = (popNext + 1) % pops.length];
      it.p.copy(worldPos); it.t = 0; it.active = true;
      it.s.textContent = text; it.s.className = 'how-pop ' + kind;
    }
    function bumpRow(i) { rowEls[i].b.classList.remove('bump'); void rowEls[i].b.offsetWidth; rowEls[i].b.classList.add('bump'); }
    function towerPop(i, delta) {
      const t = players[i].tower; t.g.getWorldPosition(v3); v3.y += t.h + 2.2;
      popNumber(v3, fmt(delta), delta >= 0 ? 'up' : 'dn'); bumpRow(i);
    }

    // ---- view state ----
    const state = {
      chapter: -2, lots: 1, target: 1, finished: false, bellRung: false, collected: false, tick: -1,
      acc: 0, lastTradeText: '',
    };
    const closeBtns = [$('howClose'), $('howDockClose')];
    const tradeBtns = $('howTradeBtns'), tradeMsg = $('howTradeMsg'), posLine = $('howPos'), sizeRow = $('howSizes');
    const dock = $('howDock'), dockTrade = $('howDockTrade'), dockPrice = $('howPrice'), spark = $('howSpark');
    const sparkCtx = spark.getContext('2d'), sparkData = [];
    const seeBtn = $('howSeeResult');

    function humanOpen(dir) {
      if (M.open(match, 0, dir, state.lots)) handleEvents();
    }
    function humanClose() {
      if (M.close(match, 0) !== null) handleEvents(); // a close at exactly 0 still counts
    }
    $('howBuy').addEventListener('click', () => humanOpen(1));
    $('howSell').addEventListener('click', () => humanOpen(-1));
    $('howDockBuy').addEventListener('click', () => humanOpen(1));
    $('howDockSell').addEventListener('click', () => humanOpen(-1));
    closeBtns.forEach((b) => b.addEventListener('click', humanClose));
    [...sizeRow.querySelectorAll('button')].forEach((b) => b.addEventListener('click', () => {
      state.lots = Number(b.dataset.lots);
      sizeRow.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      Sfx('click', 0.5);
    }));
    function syncTradeUi() {
      const pos = match.players[0].pos, over = match.ended;
      tradeBtns.hidden = !!pos || over; sizeRow.hidden = !!pos || over;
      const you = match.players[0], banked = you.stats.trades > 0 || you.bank !== 0;
      closeBtns[0].hidden = !pos; posLine.hidden = !pos && !banked;
      closeBtns[1].hidden = !pos || state.chapter === 0; dockTrade.hidden = !!pos || over || state.chapter === 0;
      seeBtn.hidden = !(over && state.chapter !== 2);
      if (pos) posLine.textContent = `EURUSD · ${pos.dir > 0 ? 'Buy' : 'Sell'} ${pos.lots} lot at ${pos.entry.toFixed(2)}${banked && you.bank !== 0 ? ` · Banked ${fmt(you.bank)}` : ''}`;
      else if (banked) posLine.textContent = `Banked so far ${fmt(you.bank)}`;
    }
    seeBtn.addEventListener('click', () => goTo(0.9));

    // ---- world chart ----
    function chartY(price) { return chart.base + (price - chart.mid) * chart.scale * 2.2; }
    function drawChart() {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < N; i++) { lo = Math.min(lo, chart.prices[i], chart.opens[i]); hi = Math.max(hi, chart.prices[i], chart.opens[i]); }
      return { lo, hi };
    }
    function stepChart(dt) {
      const you = match.players[0], frozen = you.frozen > 0;
      if (match.started && !match.ended && !frozen) {
        chart.price = match.price; chart.candleT += dt;
        chart.prices[N - 1] = chart.price;
        if (chart.candleT >= M.RULES.candleSeconds) {
          chart.candleT = 0;
          chart.opens.shift(); chart.prices.shift();
          chart.opens.push(chart.price); chart.prices.push(chart.price);
          sparkData.push(chart.price); if (sparkData.length > 60) sparkData.shift();
          drawSpark();
        }
      }
      const { lo, hi } = drawChart();
      chart.mid += ((lo + hi) / 2 - chart.mid) * damp(3, dt);
      const fitScale = clamp(6.6 / Math.max(hi - lo, 4) / 2.2, 0.08, 0.6);
      chart.scale += (fitScale - chart.scale) * damp(3, dt);
      const cw = chart.span / N;
      for (let i = 0; i < N; i++) {
        const o = chart.opens[i], c = chart.prices[i], yo = chartY(o), yc = chartY(c), up = c >= o;
        const x = -chart.span / 2 + (i + 0.5) * cw;
        dummy.position.set(x, (yo + yc) / 2, 0); dummy.scale.set(cw * 0.66, Math.max(0.09, Math.abs(yc - yo)), 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
        chart.bodies.setMatrixAt(i, dummy.matrix); chart.bodies.setColorAt(i, frozen ? tmpIce : up ? tmpGreen : tmpRed);
        dummy.scale.set(1, Math.max(0.12, Math.abs(yc - yo)) + 0.42 + ((i * 7) % 5) * 0.08, 1); dummy.updateMatrix();
        chart.wicks.setMatrixAt(i, dummy.matrix); chart.wicks.setColorAt(i, frozen ? tmpIce : up ? tmpGreen : tmpRed);
      }
      chart.bodies.instanceMatrix.needsUpdate = chart.wicks.instanceMatrix.needsUpdate = true;
      chart.bodies.instanceColor.needsUpdate = chart.wicks.instanceColor.needsUpdate = true;
      const yNow = chartY(chart.price);
      headGlow.position.set(chart.span / 2 - cw / 2, yNow, 0.4);
      headGlow.material.color.set(frozen ? COLORS.ice : chart.prices[N - 1] >= chart.opens[N - 1] ? COLORS.spike : COLORS.crush);
      const pos = you.pos;
      entryLine.visible = pnlFill.visible = !!pos;
      if (pos) {
        const yE = chartY(pos.entry), live = chart.price - pos.entry >= 0 === pos.dir > 0;
        entryLine.material.color.set(pos.dir > 0 ? COLORS.spike : COLORS.crush);
        entryLine.position.set(0, yE, 0.3);
        pnlFill.scale.set(chart.span, Math.max(0.01, Math.abs(yNow - yE)), 1);
        pnlFill.position.y = (yNow + yE) / 2;
        pnlFill.material.color.set(live ? COLORS.spike : COLORS.crush);
      }
    }
    const tmpGreen = col(COLORS.spike), tmpRed = col(COLORS.crush), tmpIce = col(COLORS.ice);
    function drawSpark() {
      const w = spark.width, h = spark.height;
      sparkCtx.clearRect(0, 0, w, h);
      if (sparkData.length < 2) return;
      let lo = Infinity, hi = -Infinity;
      sparkData.forEach((p) => { lo = Math.min(lo, p); hi = Math.max(hi, p); });
      const up = sparkData[sparkData.length - 1] >= sparkData[0];
      sparkCtx.strokeStyle = up ? '#1fd38a' : '#ff4d6a'; sparkCtx.lineWidth = 2; sparkCtx.lineJoin = 'round';
      sparkCtx.beginPath();
      sparkData.forEach((p, i) => { const x = (i / Math.max(sparkData.length - 1, 1)) * w, y = h - 2 - ((p - lo) / Math.max(hi - lo, 0.5)) * (h - 4); if (i) sparkCtx.lineTo(x, y); else sparkCtx.moveTo(x, y); });
      sparkCtx.stroke();
    }

    // ---- sabotage ----
    const handBtns = [...document.querySelectorAll('[data-how-card]')];
    const HAND = M.HAND;
    const targetLabel = $('howTarget'), playHint = $('howPlayHint');
    function setTarget(i, byUser) {
      state.target = i;
      if (byUser) Sfx('click', 0.6);
      rowEls.forEach((r, k) => { r.b.classList.toggle('target', state.chapter === 1 && k === i); r.b.setAttribute('aria-pressed', String(k === i)); });
      targetLabel.textContent = nameOf(i);
    }
    function launch(id, fromPos, toPos, dur, onHit) {
      const f = flyers.find((x) => !x.active) || flyers[0];
      f.m.material.map = faceTex(id); f.m.material.needsUpdate = true;
      f.from.copy(fromPos); f.to.copy(toPos); f.t = 0; f.dur = dur; f.done = onHit; f.active = true; f.m.visible = true;
      Sfx('whoosh');
    }
    function towerTop(p, out) { p.tower.g.getWorldPosition(out); out.y += p.tower.h; return out; }
    function humanCard(slot) {
      const id = HAND[slot], you = match.players[0], tIndex = state.target, target = match.players[tIndex];
      if (match.ended || !you.hand.includes(id) || state.chapter !== 1) return;
      if (id === 'force-close' && !target.pos) { // the real game refuses this and keeps the card
        playHint.textContent = `${target.name} has no open trade. You keep the card.`; const b = handBtns[slot]; b.classList.remove('deny'); void b.offsetWidth; b.classList.add('deny'); Sfx('click', 0.4);
        return;
      }
      const btn = handBtns[slot]; btn.disabled = true; btn.classList.add('played');
      playHint.textContent = '';
      v.copy(camera.position); camera.getWorldDirection(v2); v.addScaledVector(v2, 5); v.y -= 2.2;
      towerTop(players[tIndex], v3); v3.y += 0.6;
      cam.fovKick = -1.2;
      launch(id, v, v3, 0.42, () => { M.play(match, 0, id, tIndex); });
    }
    handBtns.forEach((b, i) => b.addEventListener('click', () => humanCard(i)));
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    canvas.addEventListener('click', (e) => {
      if (state.chapter !== 1) return;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(hitTargets, false);
      if (hits.length) setTarget(hits[0].object.userData.player, true);
    });
    function impact(ev) {
      const target = players[ev.to], t = target.tower, id = ev.id, onYou = ev.to === 0;
      t.g.getWorldPosition(v); const baseY = v.y, topY = baseY + t.h, x = v.x, z = v.z;
      t.flash = 1; flash.position.set(x, topY + 1, z + 2);
      const by = nameOf(ev.from);
      if (id === 'force-close') {
        hitStop = 0.11; addTrauma(onYou ? 0.7 : 0.62); cam.fovKick = 2.2;
        flash.color.set(COLORS.crush); flash.intensity = 240;
        burst(x, topY, z, COLORS.crush, 46, 11, { floor: baseY + 0.1 });
        burst(x, topY, z, 0xffffff, 12, 13, { floor: baseY + 0.1 });
        v2.set(x, baseY + 0.1, z); ring(v2, COLORS.crush, 8, 0.6);
        Sfx('hit');
        if (onYou) { toast(`<b>${by}</b> played Force Close. Your trade was shut at ${fmt(ev.pnl)}.`, 4); tradeMsg.textContent = `Force closed at ${fmt(ev.pnl)}. Open another.`; }
        else toast(`<b>Force Close</b> shut ${target.name}’s trade at ${fmt(ev.pnl)}.`);
      } else if (id === 'chart-ghost') {
        hitStop = 0.05; addTrauma(0.3);
        flash.color.set(COLORS.ice); flash.intensity = 170;
        burst(x, topY, z, COLORS.ice, 26, 5, { g: 3 });
        v2.set(x, baseY + 0.1, z); ring(v2, COLORS.ice, 6, 0.7);
        const sh = shells[ev.to]; sh.visible = true; sh.scale.set(0.2, 0.2, 0.2);
        tween(0.32, (k) => { const s = easeOutBack(k); sh.scale.set(s, s * (t.h + 0.6), s); });
        Sfx('card_place');
        if (onYou) { toast(`<b>${by}</b> played Chart Ghost. Your chart is frozen for 10 seconds.`, 4); tradeMsg.textContent = 'Chart frozen. You’re trading blind.'; }
        else toast(`<b>Chart Ghost</b> froze ${target.name}. They can’t react for 10 seconds.`);
      } else if (id === 'pip-theft') {
        hitStop = 0.06; addTrauma(0.26);
        flash.color.set(COLORS.spike); flash.intensity = 140;
        towerTop(target, stream.from); towerTop(players[ev.from], stream.to);
        stream.running = true; stream.items.forEach((it, i) => { it.t = -i * 0.028; });
        Sfx('card_place');
        towerPop(ev.to, -ev.amount);
        wait(0.55, () => { towerPop(ev.from, ev.amount); players[ev.from].tower.punch = 1; Sfx('notify', 0.7); });
        if (onYou) toast(`<b>${by}</b> stole ${ev.amount} from you with Pip Theft.`, 4);
        else toast(`<b>Pip Theft</b> took ${ev.amount} from ${target.name}.`);
      }
      rerank();
    }

    // ---- what the rules report, turned into sight and sound ----
    function handleEvents() {
      const evs = M.drain(match);
      for (let k = 0; k < evs.length; k++) {
        const ev = evs[k];
        if (ev.type === 'open' && ev.i === 0) {
          cam.fovKick = -1.6; addTrauma(0.16); Sfx('click');
          const colour = ev.dir > 0 ? COLORS.spike : COLORS.crush;
          v.set(A.x + chart.span / 2, chartY(chart.price), A.z + chart.z);
          if (state.chapter === 0) { ring(v, colour, 3, 0.45, false); burst(v.x, v.y, v.z, colour, 12, 5, { g: 4 }); }
          tradeMsg.textContent = ev.dir > 0 ? 'You’re long. Close before the market turns.' : 'You’re short. You win when it falls.';
          syncTradeUi();
        } else if (ev.type === 'close' && ev.i === 0) {
          const pnl = ev.pnl;
          state.lastTradeText = fmt(pnl);
          if (ev.why === 'stop') {
            tradeMsg.textContent = `Stopped out at ${fmt(pnl)}. Too big, held too long.`;
            flash.color.set(COLORS.crush); flash.intensity = 200; flash.position.set(A.x, A.y + 8, A.z + 4);
            addTrauma(0.6); Sfx('margin'); toast(`Your trade was <b>stopped out</b> at ${fmt(pnl)}.`, 4);
          } else if (ev.why === 'manual') {
            tradeMsg.textContent = pnl >= 0 ? `Banked ${fmt(pnl)}. Profit taken.` : `Closed at ${fmt(pnl)}. Better than holding.`;
            if (pnl >= 0) { addTrauma(0.1); Sfx('notify', 0.8); } else { addTrauma(0.24); Sfx('hit', 0.6); }
            if (state.chapter !== 0) { toast(pnl >= 0 ? `<b>Banked ${fmt(pnl)}.</b> Profit taken.` : `Closed at <b>${fmt(pnl)}</b>.`, 2.5); towerPop(0, pnl); }
          }
          if (state.chapter === 0 && ev.why !== 'forced') { v.set(A.x + chart.span / 2 - 2, chartY(chart.price) + 1, A.z + chart.z); popNumber(v, fmt(pnl), pnl >= 0 ? 'up' : 'dn'); }
          bumpRow(0); rerank(); syncTradeUi();
        } else if (ev.type === 'close') {
          rerank();
        } else if (ev.type === 'crash' && state.chapter === 0) {
          addTrauma(0.34); cam.fovKick = 1.2;
          v.set(A.x + chart.span / 2, chartY(chart.price), A.z + chart.z);
          burst(v.x, v.y, v.z, COLORS.crush, 18, 7, { g: 8 });
          const pos = match.players[0].pos;
          if (pos && pos.dir > 0) { tradeMsg.textContent = 'Up. Then not. Get out.'; Sfx('margin', 0.6); }
          else if (pos) { tradeMsg.textContent = 'There it goes. Close and bank it.'; Sfx('notify', 0.6); }
          else tradeMsg.textContent = 'Up. Then not. A Sell would pay here.';
        } else if (ev.type === 'warn') {
          const f = players[ev.from], to = players[ev.to];
          towerTop(f, v); v.y += 1; towerTop(to, v3); v3.y += 0.6;
          launch(ev.id, v, v3, 1, null);
          if (ev.to === 0) { warnYou = 1; toast(`<b>${f.name}</b> is playing a card on you.`, 1.4); Sfx('margin', 0.5); }
        } else if (ev.type === 'card') {
          impact(ev); syncTradeUi();
        } else if (ev.type === 'unfreeze') {
          const sh = shells[ev.i];
          tween(0.2, (k) => { sh.scale.x = sh.scale.z = 1 - k; }, () => { sh.visible = false; });
          if (ev.i === 0) tradeMsg.textContent = 'Chart back. Check your trade.';
        } else if (ev.type === 'end') {
          state.finished = true; syncTradeUi();
          if (state.chapter !== 2) tradeMsg.textContent = 'Round over. See how you finished.';
          if (state.chapter === 2) ringBell();
          else { toast('The bell rang. <b>See how you finished.</b>', 8); navBtns[2].classList.add('pulse'); }
        }
      }
    }
    let warnYou = 0;

    // ---- the bell, and a podium that shows what really happened ----
    const resultEl = $('howResult'), storyEl = $('howStory'), tipEl = $('howTip'), statsEl = $('howStats');
    const finishHeading = document.querySelectorAll('.how-step h3')[2], finishHeadingText = finishHeading.textContent;
    const collectBtn = $('howCollect'), againBtn = $('howAgain'), fineEl = $('howFine');
    const PLACE_H = [6.4, 4.4, 2.8, 1.2];
    function hideCoins() {
      coins.active = false; coins.mesh.visible = false;
      coins.list.forEach((c, i) => { c.rest = true; c.y = -50; c.leave = false; dummy.position.set(0, -50, 0); dummy.scale.setScalar(1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); coins.mesh.setMatrixAt(i, dummy.matrix); });
      coins.mesh.instanceMatrix.needsUpdate = true;
    }
    function placePodium(order) {
      order.forEach((o, place) => {
        const t = pillars[place];
        Object.keys(t.names).forEach((n) => { t.names[n].visible = false; });
        t.label = t.names[o.name]; t.label.visible = true;
        const colour = o.i === 0 ? COLORS.blue : COLORS.slate;
        t.bodyMat.color.set(colour); t.bodyMat.emissive.set(colour); t.cap.material.color.set(colour);
      });
    }
    function resetPodium() {
      pillars.forEach((p) => { p.target = 0.4; });
      placePodium(M.standings(match));
      crown.material.opacity = 0; hideCoins();
    }
    function resetResultUi() {
      collectBtn.hidden = true; againBtn.hidden = true; storyEl.hidden = true; tipEl.hidden = true; statsEl.hidden = true;
      resultEl.textContent = 'Reach the bell and the final seconds begin. Highest balance wins.';
      finishHeading.textContent = finishHeadingText; stage.classList.remove('has-result');
      fineEl.textContent = 'Example match, sped up. Coins have no cash value.';
      $('howCtaFinal').classList.remove('pulse');
    }
    function ringBell() {
      if (state.bellRung) return;
      state.bellRung = true; syncTradeUi(); navBtns[2].classList.remove('pulse');
      const r = match.result, you = pillars[r.rank - 1];
      placePodium(r.order);
      bellSwing = 0.62; hitStop = 0.14; addTrauma(r.rank === 4 ? 0.34 : 0.72); cam.fovKick = r.rank === 1 ? 3 : 1;
      Sfx('bell', 0.9);
      podium.getWorldPosition(v); v.y += 11; v.z -= 3.4;
      flash.color.set(0xffffff); flash.intensity = r.rank === 1 ? 320 : 140; flash.position.copy(v);
      ring(v, 0xffffff, 11, 0.7, false);
      pillars.forEach((p, i) => wait(0.05 + i * 0.1, () => { p.target = PLACE_H[i]; }));
      rerank();
      wait(0.5, () => {
        if (r.rank === 1) { Sfx('coin_big', 0.9); Sfx('win', 0.6); } else if (r.coins > 0) Sfx('coin1');
        crown.material.opacity = 0.95;
        v2.copy(C); v2.y += 0.1; v2.z -= 1; ring(v2, COLORS.gold, 11, 0.9);
        coins.active = true; coins.mesh.visible = true;
        // the pot lands on the winner; how much of it reaches you is the point
        const share = r.rank === 1 ? 1 : r.coins > 0 ? 0.45 : 0.3;
        coins.list.forEach((c, i) => {
          if (i > COIN_N * share) { c.rest = true; return; }
          const a = rng() * Math.PI * 2, s = 1 + rng() * 3.4;
          c.x = Math.cos(a) * 0.5; c.z = -1 + Math.sin(a) * 0.5; c.y = 7.4;
          c.vx = Math.cos(a) * s; c.vz = Math.sin(a) * s; c.vy = 7 + rng() * 6;
          c.rx = rng() * 6; c.rz = rng() * 6; c.sx = -7 + rng() * 14; c.sz = -7 + rng() * 14;
          c.delay = i * 0.012; c.rest = false; c.leave = false;
        });
        if (r.rank === 4) { // last place: you get debris, not coins
          you.g.getWorldPosition(v3); const y = v3.y + you.h;
          Sfx('hit', 0.8); you.flash = 1; addTrauma(0.44);
          burst(v3.x, y + 0.6, v3.z, COLORS.crush, 30, 7, { floor: v3.y + 0.1 });
        } else if (r.rank > 1) {
          you.g.getWorldPosition(v3); burst(v3.x, v3.y + you.h + 0.4, v3.z, COLORS.gold, 16, 5, { floor: v3.y + 0.1 });
        }
      });
      const coinText = r.coins > 0 ? `<b>+${r.coins} coins.</b>` : '<b class="none">No coins.</b>';
      resultEl.innerHTML = coinText;
      finishHeading.textContent = r.story.place; stage.classList.add('has-result');
      storyEl.textContent = r.story.line; storyEl.hidden = false;
      tipEl.textContent = r.story.tip; tipEl.hidden = false;
      statsEl.innerHTML = [['Final P&L', fmt(r.pnl)], ['Best trade', r.stats.best === null ? '—' : fmt(r.stats.best)], ['Trades', r.stats.trades], ['Cards', r.stats.played]].map(([a, b]) => `<span><i>${a}</i>${b}</span>`).join('');
      statsEl.hidden = false;
      collectBtn.textContent = `Collect ${r.coins} coins`; collectBtn.hidden = r.coins <= 0;
      againBtn.hidden = false;
      if (r.coins <= 0) $('howCtaFinal').classList.add('pulse');
    }
    let bellSwing = 0, bellAngle = 0, bellVel = 0;
    function collect() {
      if (state.collected || !match.result || match.result.coins <= 0) return;
      state.collected = true; collectBtn.hidden = true;
      const amount = match.result.coins;
      coins.list.forEach((c) => { if (c.y > -40) { c.rest = false; c.vy = 9 + rng() * 9; c.vx *= 0.3; c.vz *= 0.3; c.delay = rng() * 0.3; c.leave = true; } });
      Sfx('coin1');
      const st = performance.now();
      const tick = (n) => {
        if (state.collected !== true || dead) return;
        const k = Math.min(1, (n - st) / 800);
        resultEl.innerHTML = `<b>${Math.round((1 - Math.pow(1 - k, 3)) * amount)} coins</b> collected.`;
        if (k < 1) requestAnimationFrame(tick);
        else { resultEl.innerHTML = 'That was practice. <b>Your account starts with 500 free coins.</b>'; $('howCtaFinal').classList.add('pulse'); }
      };
      requestAnimationFrame(tick);
      fineEl.textContent = 'Coins have no cash value and can’t be withdrawn.';
    }
    collectBtn.addEventListener('click', collect);
    againBtn.addEventListener('click', () => { newRound(); goTo(0.28); });

    function newRound(seed) {
      match = M.create(seed || newSeed());
      players.forEach((p, i) => { p.model = match.players[i]; p.shown = 0; shells[i].visible = false; });
      Object.assign(state, { finished: false, bellRung: false, collected: false, tick: -1, acc: 0, target: 1 });
      chart.price = match.price;
      sparkData.length = 0; drawSpark();
      handBtns.forEach((b, i) => { b.disabled = false; b.classList.remove('played'); b.style.animationDelay = `${i * 45}ms`; b.classList.remove('dealt'); void b.offsetWidth; b.classList.add('dealt'); });
      playHint.textContent = '';
      tradeMsg.textContent = 'Try it: Buy or Sell. Watch for the turn.';
      navBtns[2].classList.remove('pulse');
      resetPodium(); resetResultUi(); syncTradeUi(); rerank(); setTarget(1, false);
      timerEl.textContent = fmtClock(match.duration);
      if (state.chapter >= 0) M.start(match);
    }

    // ---- small timeline helpers ----
    const tweens = [];
    function tween(dur, fn, done) { tweens.push({ t: 0, dur, fn, done }); }
    function wait(dur, done) { tweens.push({ t: 0, dur, fn: null, done }); }

    // ---- chapters ----
    const articles = [...document.querySelectorAll('.how-step')], head = $('howHead');
    const navBtns = [...document.querySelectorAll('[data-how-go]')];
    function setChapter(i) {
      if (i === state.chapter) return;
      state.chapter = i;
      head.classList.toggle('on', i === -1);
      head.inert = i !== -1;
      articles.forEach((a, k) => { const on = k === i; a.classList.toggle('on', on); a.inert = !on; });
      navBtns.forEach((b, k) => { if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
      stage.dataset.chapter = i;
      rowEls.forEach((r, k) => { r.b.disabled = i !== 1 || match.players[k].me; r.b.classList.toggle('target', i === 1 && k === state.target); });
      // back at the Trade stop after a finished round: deal a fresh one, so Buy and Sell always work
      if (i === 0 && match.ended && state.bellRung) newRound();
      if (i >= 0 && !match.started) M.start(match);
      if (i === 1) {
        const lead = M.standings(match).filter((s) => s.i !== 0)[0];
        setTarget(lead.i, false);
      }
      if (i === 2) {
        if (!match.ended) M.hurry(match); else if (!state.bellRung) ringBell();
      }
      syncTradeUi();
    }
    navBtns.forEach((b, i) => b.addEventListener('click', () => goTo([0.28, 0.58, 0.9][i])));
    function goTo(p) {
      const range = track.offsetHeight - stage.offsetHeight;
      window.scrollTo({ top: track.getBoundingClientRect().top + scrollY - stickyTop() + range * p + 1, behavior: 'smooth' });
    }
    function stickyTop() { return parseFloat(getComputedStyle(stage).top) || 0; }
    function scrollP() {
      const range = track.offsetHeight - stage.offsetHeight;
      return range > 0 ? clamp((stickyTop() - track.getBoundingClientRect().top) / range, 0, 1) : 0;
    }

    resetPodium(); resetResultUi(); rerank(); paintBoard(); setTarget(1, false); syncTradeUi();
    timerEl.textContent = fmtClock(match.duration);

    // ---- frame ----
    function renderFrame() { renderer.render(scene, camera); }
    let frameCost = 0, frames = 0;
    const SIM_STEP = 0.05;
    function update(realDt) {
      // UI and rules run on real time; hit-stop only slows what's drawn
      let dt = realDt;
      if (hitStop > 0) { hitStop -= realDt; dt = realDt * 0.06; }

      const p = scrollP();
      cam.target = uFor(p);
      const before = cam.u;
      cam.u += (cam.target - cam.u) * damp(TUNE.flightSmoothing, realDt);
      cam.speed += (Math.abs(cam.u - before) / Math.max(realDt, 0.001) - cam.speed) * damp(6, realDt);

      let ch = -1;
      for (let i = 0; i < CHAPTERS.length; i++) { if (p < CHAPTERS[i][0]) { ch = CHAPTERS[i][1]; break; } }
      setChapter(ch);

      // the rules: fixed steps, paused on the opening view
      if (state.chapter >= 0) {
        state.acc += realDt; let n = 0;
        while (state.acc >= SIM_STEP && n++ < 5) { state.acc -= SIM_STEP; M.step(match, SIM_STEP); handleEvents(); }
        if (n >= 5) state.acc = 0;
      }
      stepChart(dt);

      // live trade read-outs, hidden when your chart is frozen
      const youM = match.players[0], blind = youM.frozen > 0;
      if (youM.pos) {
        const l = M.live(match, youM), text = blind ? 'Close trade' : `Close trade ${fmt(l)}`, cls = 'how-trade close' + (blind ? '' : l >= 0 ? ' in-profit' : ' in-loss');
        if (closeBtns[0].textContent !== text) closeBtns[0].textContent = text;
        if (closeBtns[0].className !== cls) closeBtns[0].className = cls;
        const dockText = blind ? 'Close' : `Close ${fmt(l)}`;
        if (closeBtns[1].textContent !== dockText) closeBtns[1].textContent = dockText;
        const dockCls = 'how-mini close' + (blind ? '' : l >= 0 ? ' in-profit' : ' in-loss');
        if (closeBtns[1].className !== dockCls) closeBtns[1].className = dockCls;
      }
      const priceText = blind ? `Frozen ${Math.ceil(youM.frozen)}s` : `EURUSD ${chart.price.toFixed(2)}`;
      if (dockPrice.textContent !== priceText) { dockPrice.textContent = priceText; dockPrice.classList.toggle('ice', blind); }
      players.forEach((pl, i) => {
        const total = M.total(match, match.players[i]);
        pl.pnl = total; pl.shown += ((blind && i === 0 ? pl.shown : total) - pl.shown) * damp(9, realDt);
      });
      // clock and final seconds
      if (!match.ended) {
        const rem = match.duration - match.t, whole = Math.ceil(rem);
        if (whole !== state.tick) {
          state.tick = whole; timerEl.textContent = fmtClock(rem);
          if (match.started && rem <= 5 && whole > 0) { Sfx('tick', 0.6); timerEl.classList.remove('tock'); void timerEl.offsetWidth; timerEl.classList.add('tock'); }
          rerank();
          if (state.chapter === 2) resultEl.textContent = `${whole} second${whole === 1 ? '' : 's'} left. Highest balance wins.`;
        }
      } else if (timerEl.textContent !== '00:00') timerEl.textContent = '00:00';

      if (state.chapter === 2 || bellAngle) {
        bellVel += (-bellAngle * 26 - bellVel * 1.3) * dt;
        if (bellSwing) { bellVel += bellSwing * 9; bellSwing = 0; }
        bellAngle += bellVel * dt;
        bell.rotation.z = bellAngle;
      }
      paintBoard();
      if (toastTimer > 0) { toastTimer -= realDt; if (toastTimer <= 0) toastEl.classList.remove('show'); }

      // towers spring toward each balance
      players.forEach((pl) => { pl.tower.target = pnlToH(pl.pnl); });
      const springs = players.map((pl) => pl.tower).concat(pillars);
      for (let i = 0; i < springs.length; i++) {
        const t = springs[i];
        t.vel += ((t.target - t.h) * 46 - t.vel * 8) * dt;
        t.h = Math.max(0.3, t.h + t.vel * dt);
        t.body.scale.y = t.h; t.cap.position.y = t.h; t.label.position.y = t.h + 1.05;
        const plateCount = Math.min(MAX_PLATES, Math.floor(t.h));
        if (plateCount !== t.shownPlates) {
          t.shownPlates = plateCount;
          for (let k = 0; k < MAX_PLATES; k++) {
            if (k < plateCount) { dummy.position.set(0, k + 1 > t.h - 0.2 ? -500 : k + 1, 0); dummy.scale.setScalar(1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); t.plates.setMatrixAt(k, dummy.matrix); }
            else t.plates.setMatrixAt(k, hideMatrix);
          }
          t.plates.instanceMatrix.needsUpdate = true;
        }
        if (t.punch > 0) { t.punch = Math.max(0, t.punch - dt * 4); const s = 1 + t.punch * 0.16; t.body.scale.x = t.body.scale.z = s; } else t.body.scale.x = t.body.scale.z = 1;
        if (t.flash > 0) { t.flash = Math.max(0, t.flash - dt * 3.2); t.bodyMat.emissiveIntensity = 0.22 + t.flash * 1.4; } else if (t.bodyMat.emissiveIntensity !== 0.22) t.bodyMat.emissiveIntensity = 0.22;
      }
      shells.forEach((s, i) => { if (s.visible && s.scale.x > 0.95) s.scale.y = players[i].tower.h + 0.6; });
      // target marker
      const tgt = players[state.target].tower;
      const show = state.chapter === 1 && !match.ended && match.players[0].hand.length > 0;
      targetRing.visible = chevron.visible = show;
      if (show) {
        targetRing.position.x += (tgt.x - targetRing.position.x) * damp(14, realDt);
        targetRing.position.z += (tgt.z - targetRing.position.z) * damp(14, realDt);
        targetRing.rotation.z += realDt * 0.5;
        chevron.position.set(targetRing.position.x, tgt.h + 2.5 + Math.sin(performance.now() / 260) * 0.2, targetRing.position.z);
      }
      if (warnYou > 0) { warnYou -= realDt; const me = players[0].tower; me.flash = Math.max(me.flash, 0.4 + Math.sin(warnYou * 22) * 0.4); }

      // flying cards
      for (let i = 0; i < flyers.length; i++) {
        const f = flyers[i]; if (!f.active) continue;
        f.t += dt / f.dur; const k = Math.min(1, f.t), e = easeInCubic(k);
        f.m.position.lerpVectors(f.from, f.to, e);
        f.m.position.y += Math.sin(k * Math.PI) * 2.6;
        const sc = lerp(1, 0.55, e); f.m.scale.setScalar(sc);
        f.m.lookAt(camera.position); f.m.rotateZ(k * 5.2);
        if (k >= 1) { f.active = false; f.m.visible = false; const cb = f.done; f.done = null; if (cb) { cb(); handleEvents(); } }
      }
      // pip stream
      if (stream.running) {
        let alive = false;
        for (let i = 0; i < streamN; i++) {
          const it = stream.items[i]; it.t += dt * 1.8;
          if (it.t > 1) { stream.mesh.setMatrixAt(i, hideMatrix); continue; }
          if (it.t < 0) { alive = true; continue; }
          alive = true;
          const k = smooth(it.t);
          dummy.position.lerpVectors(stream.from, stream.to, k);
          dummy.position.y += Math.sin(k * Math.PI) * 4.4 + Math.sin(i * 2.1 + it.t * 8) * 0.25;
          dummy.position.x += Math.cos(i * 1.7 + it.t * 6) * 0.25;
          dummy.scale.setScalar(0.7 + Math.sin(k * Math.PI) * 0.7); dummy.rotation.set(it.t * 9, i, it.t * 7); dummy.updateMatrix();
          stream.mesh.setMatrixAt(i, dummy.matrix);
        }
        stream.mesh.instanceMatrix.needsUpdate = true;
        if (!alive) stream.running = false;
      }
      // debris
      let anyFx = false;
      for (let i = 0; i < fxN; i++) {
        const it = fx.items[i]; if (it.life <= 0) continue;
        anyFx = true; it.life -= dt;
        if (it.life <= 0) { fx.mesh.setMatrixAt(i, hideMatrix); continue; }
        it.vy -= it.g * dt; it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
        if (it.y < it.floor) { it.y = it.floor; it.vy *= -0.38; it.vx *= 0.6; it.vz *= 0.6; }
        dummy.position.set(it.x, it.y, it.z);
        dummy.scale.setScalar(it.s * clamp(it.life / it.max * 1.6, 0, 1));
        dummy.rotation.set(it.life * 9, it.life * 7, 0); dummy.updateMatrix();
        fx.mesh.setMatrixAt(i, dummy.matrix);
      }
      if (anyFx) fx.mesh.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i]; if (!r.m.visible) continue;
        r.t += dt / r.dur; const k = Math.min(1, r.t);
        const s = lerp(0.2, r.size, 1 - Math.pow(1 - k, 3)); r.m.scale.set(s, s, s); r.m.material.opacity = (1 - k) * (1 - k) * 0.85;
        if (k >= 1) r.m.visible = false;
      }
      if (flash.intensity > 0.5) flash.intensity *= Math.exp(-7 * realDt); else flash.intensity = 0;
      // coins: real bounces, then they stay where they land
      if (coins.active) {
        let moved = false;
        const floorY = 0.05;
        for (let i = 0; i < COIN_N; i++) {
          const c = coins.list[i]; if (c.rest) continue;
          if (c.delay > 0) { c.delay -= dt; continue; }
          moved = true;
          c.vy -= (c.leave ? -6 : 16) * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
          c.rx += c.sx * dt; c.rz += c.sz * dt;
          if (!c.leave && c.y < floorY && Math.hypot(c.x, c.z) < 10.4) {
            c.y = floorY; c.vy *= -0.32; c.vx *= 0.68; c.vz *= 0.68; c.sx *= 0.5; c.sz *= 0.5;
            if (Math.abs(c.vy) < 0.8) { c.rest = true; c.rx = 0; c.rz = 0; }
          }
          if (c.y < -40 || c.y > 60) { c.rest = true; c.y = -50; }
          dummy.position.set(c.x, c.y, c.z); dummy.rotation.set(c.rx, 0, c.rz); dummy.scale.setScalar(1); dummy.updateMatrix();
          coins.mesh.setMatrixAt(i, dummy.matrix);
        }
        if (moved) coins.mesh.instanceMatrix.needsUpdate = true;
      }
      for (let i = tweens.length - 1; i >= 0; i--) {
        const t = tweens[i]; t.t += realDt;
        const k = Math.min(1, t.t / t.dur);
        if (t.fn) t.fn(k);
        if (k >= 1) { tweens.splice(i, 1); if (t.done) t.done(); }
      }

      // ---- camera ----
      const u = clamp(cam.u, 0, 1);
      camCurve.getPoint(u, cam.pos); lookCurve.getPoint(u, cam.look);
      // tall screens pull back along the view line; the overview needs less of that
      const pullNow = lerp(overPull, pull, smooth(clamp(u * 3, 0, 1)));
      v.copy(cam.pos).sub(cam.look).multiplyScalar(pullNow).add(cam.look);
      cam.mx += (cam.pmx - cam.mx) * damp(4, realDt); cam.my += (cam.pmy - cam.my) * damp(4, realDt);
      v.x += cam.mx * 1.5; v.y += -cam.my * 0.9;
      // trauma shake, on the camera only; the HUD never moves
      if (cam.trauma > 0) {
        cam.trauma = Math.max(0, cam.trauma - realDt * 1.5);
        const s = cam.trauma * cam.trauma; cam.shake += realDt * 34;
        v.x += s * 1.1 * Math.sin(cam.shake * 1.7); v.y += s * 0.8 * Math.sin(cam.shake * 2.3);
        camera.up.set(s * 0.05 * Math.sin(cam.shake * 1.1), 1, 0);
      } else camera.up.set(0, 1, 0);
      camera.position.copy(v); camera.lookAt(cam.look);
      cam.fovKick += (0 - cam.fovKick) * damp(7, realDt);
      const fov = 42 + clamp(cam.speed * 26, 0, 7) + cam.fovKick;
      if (Math.abs(fov - camera.fov) > 0.01) { camera.fov = fov; }
      // framing: push the action clear of the reading panel
      const wantX = aspect >= 1.1 ? -W * 0.15 : 0;
      const wantY = aspect < 1.1 ? H * 0.13 : 0;
      cam.offX += (wantX - cam.offX) * damp(4, realDt); cam.offY += (wantY - cam.offY) * damp(4, realDt);
      camera.setViewOffset(W, H, cam.offX, cam.offY, W, H);
      camera.updateMatrixWorld();

      const flightA = 1 - smooth(clamp((u - 0.18) / 0.08, 0, 1)) + smooth(clamp((u - 0.36) / 0.05, 0, 1)) * (1 - smooth(clamp((u - 0.5) / 0.08, 0, 1)));
      const flightB = 1 - smooth(clamp((u - 0.12) / 0.08, 0, 1)) + smooth(clamp((u - 0.42) / 0.06, 0, 1)) * (1 - smooth(clamp((u - 0.58) / 0.06, 0, 1)));
      brandUp.material.opacity = clamp(flightA, 0, 1); brandNot.material.opacity = clamp(flightB, 0, 1);
      brandUp.visible = brandUp.material.opacity > 0.01; brandNot.visible = brandNot.material.opacity > 0.01;
      dustField.rotation.y = Math.sin(performance.now() / 40000) * 0.04;

      // floating numbers follow the world, on real time
      for (let i = 0; i < pops.length; i++) {
        const it = pops[i]; if (!it.active) continue;
        it.t += realDt / 1.05;
        if (it.t >= 1) { it.active = false; it.s.style.opacity = 0; continue; }
        v3.copy(it.p).project(camera);
        const px = (v3.x * 0.5 + 0.5) * W, py = (-v3.y * 0.5 + 0.5) * H - it.t * 46;
        const pop = it.t < 0.16 ? 0.6 + easeOutBack(it.t / 0.16) * 0.4 : 1;
        it.s.style.opacity = it.t > 0.72 ? (1 - it.t) / 0.28 : 1;
        it.s.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${pop})`;
      }
    }

    // ---- loop: stops off screen ----
    let visible = false, raf = 0, last = 0, ready = false;
    const fpsCap = isPhone ? 1000 / 45 : 0;
    function loop(now) {
      raf = 0;
      if (!visible || document.hidden || dead) return;
      raf = requestAnimationFrame(loop);
      if (fpsCap && now - last < fpsCap - 1) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      const gap = last ? now - last : 16; last = now;
      try {
        update(dt); renderFrame();
      } catch (err) { console.error(err); goStatic(); return; }
      // lower the resolution when frames run slow; never raise it back mid-flight
      frameCost = frameCost * 0.95 + gap * 0.05; frames++;
      if (frames > 90 && frameCost > 30 && pixelRatio > 1) {
        pixelRatio = Math.max(1, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); fit(); frames = 0; frameCost = 16;
      }
    }
    const wake = () => { if (!raf && visible && !document.hidden && !dead) { last = 0; raf = requestAnimationFrame(loop); } };
    new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; wake(); }, { threshold: 0 }).observe(stage);
    document.addEventListener('visibilitychange', wake);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); goStatic(); });

    // warm up: draw every material once behind the poster so nothing hitches on first sight
    update(0.016);
    flyers.forEach((f) => { f.m.visible = true; });
    stream.mesh.visible = true;
    renderer.compile(scene, camera);
    renderFrame();
    flyers.forEach((f) => { f.m.visible = false; });
    ready = true;
    stage.classList.add('is-ready');
    $('howLoader').hidden = true;
    wake();
    if (qa) {
      window.__how = {
        renderer, state, players, cam, camera, scene, THREE,
        jump(p) { const range = track.offsetHeight - stage.offsetHeight; document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, track.getBoundingClientRect().top + scrollY - stickyTop() + range * p + 1); cam.u = uFor(p); },
        capture(type, q) { renderFrame(); return canvas.toDataURL(type || 'image/webp', q || 0.8); },
        info() { return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, ratio: pixelRatio, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, frameCost }; },
        get match() { return match; }, M, humanOpen, humanClose, humanCard, setTarget, newRound, collect,
      };
    }
    return { destroy() { cancelAnimationFrame(raf); canvas.remove(); try { renderer.dispose(); } catch (e) {} } };
  }

  // Skip and Play free are plain HTML, so they work before and without 3D.
  // Download only once the visitor moves: bouncing from the hero costs them nothing.
  let begun = false;
  function begin() {
    if (begun) return;
    begun = true;
    window.removeEventListener('scroll', begin);
    window.removeEventListener('pointerdown', begin);
    start().catch((err) => { console.error(err); goStatic(); });
  }
  window.addEventListener('scroll', begin, { passive: true });
  window.addEventListener('pointerdown', begin, { passive: true });
  if (scrollY > 0 || track.getBoundingClientRect().top < innerHeight * 0.6) begin();
})();
