'use strict';
// Sabotage card showcase: one real game card as a small 3D object.
//
// The name, description and buttons are ordinary HTML outside the scene. A
// static picture shows first and stays if 3D can't run (no WebGL, Save-Data, or
// the 3D file fails to load). Three.js only downloads when the section nears
// the screen. Vertical swipes scroll the page (touch-action: pan-y in the CSS);
// only sideways drags turn the card, and the mouse wheel is never captured.
(function () {
  // ADJUST HERE ----------------------------------------------------------------
  const CONFIG = {
    cardScale: 1,          // object size: 1 fills the stage height, 0.8 is smaller
    dragSpeed: 0.011,      // radians turned per pixel dragged
    swayAmount: 0.32,      // idle rock in radians; 0 turns it off
    swaySpeed: 0.55,
    keyLight: 1.7,         // main light strength
    fillLight: 0.4,       // soft light from the opposite side
    ambientLight: 1.3,
    backLight: 1.9,        // lights the back of the card
    reflections: 0.2,     // strength of the moving sheen
    maxPixelRatioDesktop: 2,
    maxPixelRatioPhone: 1.5,
    fpsPhone: 30,
  };
  const CARDS = window.SCCardArt.CARDS; // six cards; add more in card-art.js
  const THREE_URL = '/vendor/three-0.187.0/three-lite.min.js';
  // ----------------------------------------------------------------------------

  const CARD_W = 2.2, CARD_H = 3.1, CARD_R = 0.14, CARD_D = 0.035;

  const stage = document.getElementById('showcaseStage');
  if (!stage) return;
  const $ = (id) => document.getElementById(id);
  const poster = $('showcasePoster'), loader = $('showcaseLoader'), hint = $('showcaseHint'), flipBtn = $('showcaseFlip');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const isPhone = matchMedia('(max-width: 760px), (pointer: coarse)').matches;

  let current = 0;
  let scene3d = null;

  // ---- HTML side, works with or without 3D ----
  function select(i) {
    current = i;
    const c = CARDS[i];
    $('showcaseName').textContent = c.name;
    $('showcaseDesc').textContent = c.desc;
    poster.src = `/assets/showcase/${c.id}.webp`;
    poster.alt = `${c.name} sabotage card`;
    document.querySelectorAll('[data-showcase-card]').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    stage.setAttribute('aria-label', `${c.name} sabotage card. Use the left and right arrow keys to turn it.`);
    if (scene3d) scene3d.show(c);
  }
  document.querySelectorAll('[data-showcase-card]').forEach((b, k) => b.addEventListener('click', () => select(k)));

  function staticOnly() {
    loader.hidden = true; hint.hidden = true; flipBtn.hidden = true;
    stage.removeAttribute('tabindex');
    stage.setAttribute('aria-label', `${CARDS[current].name} sabotage card`);
    stage.classList.add('is-static');
  }

  const { drawFace, drawBack } = window.SCCardArt;

  // ---- 3D ----
  async function start() {
    const THREE = await import(THREE_URL);
    await window.SCCardArt.fontsReady();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: isPhone ? 'low-power' : 'default' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, isPhone ? CONFIG.maxPixelRatioPhone : CONFIG.maxPixelRatioDesktop));
    const canvas = renderer.domElement;
    canvas.className = 'showcase-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    stage.prepend(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);

    // Soft reflections from a tiny room of lit panels: this is the moving sheen.
    const room = new THREE.Scene();
    room.background = new THREE.Color('#0a1020');
    [['#ffffff', 5, 0, 6, 0], ['#6cb2ff', 3, -6, 1, 3], ['#ff4d6a', 2, 6, -1, 2]].forEach(([col, size, x, y, z]) => {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(size, size, 0.1), new THREE.MeshBasicMaterial({ color: col }));
      panel.position.set(x, y, z); panel.lookAt(0, 0, 0); room.add(panel);
    });
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(room, 0.06).texture;
    scene.environment = env;
    scene.environmentIntensity = CONFIG.reflections;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, CONFIG.ambientLight));
    const key = new THREE.DirectionalLight(0xffffff, CONFIG.keyLight); key.position.set(4, 6, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9cc4ff, CONFIG.fillLight); fill.position.set(-4, -1, 3); scene.add(fill);
    const rear = new THREE.DirectionalLight(0xffffff, CONFIG.backLight); rear.position.set(-3, 3, -6); scene.add(rear);

    // card: a thin rounded slab with one artwork on each side
    const shape = new THREE.Shape();
    const hw = CARD_W / 2, hh = CARD_H / 2, r = CARD_R;
    shape.moveTo(-hw + r, -hh); shape.lineTo(hw - r, -hh); shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
    shape.lineTo(hw, hh - r); shape.quadraticCurveTo(hw, hh, hw - r, hh);
    shape.lineTo(-hw + r, hh); shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
    shape.lineTo(-hw, -hh + r); shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    const faceGeo = new THREE.ShapeGeometry(shape, 12);
    const uv = faceGeo.attributes.uv, pos = faceGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + hw) / CARD_W, (pos.getY(i) + hh) / CARD_H);

    const texW = isPhone ? 640 : 1000, texH = Math.round(texW * (CARD_H / CARD_W));
    const mkCanvas = () => { const c = document.createElement('canvas'); c.width = texW; c.height = texH; return c; };
    const frontCv = mkCanvas(), backCv = mkCanvas();
    drawFace(frontCv, CARDS[current]); drawBack(backCv);
    const mkTex = (c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return t;
    };
    const frontTex = mkTex(frontCv);
    const faceMat = (map) => new THREE.MeshPhysicalMaterial({ map, roughness: 0.6, metalness: 0, specularIntensity: 0.5, clearcoat: 0.12, clearcoatRoughness: 0.4 });

    const card = new THREE.Group();
    const edge = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: CARD_D, bevelEnabled: false, curveSegments: 12 }),
      new THREE.MeshStandardMaterial({ color: '#5b76b8', roughness: 0.45, metalness: 0.3 })
    );
    edge.position.z = -CARD_D / 2;
    const front = new THREE.Mesh(faceGeo, faceMat(frontTex)); front.position.z = CARD_D / 2 + 0.001;
    const back = new THREE.Mesh(faceGeo, faceMat(mkTex(backCv))); back.position.z = -CARD_D / 2 - 0.001; back.rotation.y = Math.PI;
    card.add(edge, front, back);
    card.scale.setScalar(CONFIG.cardScale);
    scene.add(card);

    // motion state
    let target = 0, angle = 0, vel = 0, tilt = 0, tiltTarget = 0;
    let dragging = false, lastX = 0, lastY = 0, lastTouch = -1e9;
    let visible = true, raf = 0, prev = 0, clock = 0, lastDraw = 0;

    function fit() {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      const half = Math.tan((camera.fov * Math.PI) / 360);
      const distH = (CARD_H / 2) / half, distW = (CARD_W / 2) / (half * camera.aspect);
      camera.position.set(0, -0.14, Math.max(distH, distW) * (H < 420 ? 1.3 : 1.2)); // -0.14 leaves room for the hint
      camera.updateProjectionMatrix();
    }
    const swaying = () => !reduced.matches && CONFIG.swayAmount > 0 && !dragging && performance.now() - lastTouch > 3000;
    function pose(now) {
      const sway = swaying() ? Math.sin(clock * CONFIG.swaySpeed) * CONFIG.swayAmount : 0;
      card.rotation.y = angle + sway;
      card.rotation.x = tilt;
      void now;
    }
    function render() { renderer.render(scene, camera); }
    function step(dt) {
      if (!dragging) {
        target += vel * dt; vel *= Math.pow(0.05, dt);
        if (Math.abs(vel) < 0.01) vel = 0;
      }
      const k = 1 - Math.pow(0.0005, dt);
      angle += (target - angle) * k;
      tilt += (tiltTarget - tilt) * k;
      if (!dragging) tiltTarget *= Math.pow(0.1, dt);
      clock += dt;
    }
    const settled = () => !dragging && !vel && Math.abs(target - angle) < 0.001 && Math.abs(tilt) < 0.001 && !swaying();
    function frame(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      if (isPhone && now - lastDraw < 1000 / CONFIG.fpsPhone - 1) { raf = requestAnimationFrame(frame); return; }
      lastDraw = now;
      const dt = prev ? Math.min((now - prev) / 1000, 0.05) : 0.016; prev = now;
      step(dt); pose(now); render();
      if (settled()) { prev = 0; return; } // nothing moving: stop drawing until something changes
      raf = requestAnimationFrame(frame);
    }
    const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };

    // input: sideways drag turns the card. touch-action:pan-y gives vertical
    // swipes to the browser, which fires pointercancel and ends the drag.
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY; vel = 0; lastTouch = performance.now();
      canvas.setPointerCapture(e.pointerId); stage.classList.add('is-dragging'); hint.classList.add('is-used'); wake();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      target += dx * CONFIG.dragSpeed;
      vel = (dx * CONFIG.dragSpeed) * 30;
      if (e.pointerType === 'mouse') tiltTarget = Math.max(-0.35, Math.min(0.35, tiltTarget + dy * 0.004));
      lastTouch = performance.now();
    });
    const endDrag = () => { if (!dragging) return; dragging = false; lastTouch = performance.now(); if (reduced.matches) vel = 0; stage.classList.remove('is-dragging'); wake(); };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    function turnBy(rad) {
      target += rad; lastTouch = performance.now();
      if (reduced.matches) { angle = target; }
      wake();
    }
    stage.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); turnBy(-0.4); }
      if (e.key === 'ArrowRight') { e.preventDefault(); turnBy(0.4); }
    });
    flipBtn.addEventListener('click', () => turnBy(Math.PI));

    new ResizeObserver(() => { fit(); pose(); render(); }).observe(stage);
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) { prev = 0; wake(); } }).observe(stage);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { prev = 0; wake(); } });
    reduced.addEventListener('change', wake);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); canvas.remove(); poster.hidden = false; poster.classList.remove('is-done'); staticOnly(); scene3d = null; });

    scene3d = {
      show(c) {
        drawFace(frontCv, c); frontTex.needsUpdate = true;
        // always land on the front; a full turn when motion is welcome
        const nearest = Math.round(target / (Math.PI * 2)) * Math.PI * 2;
        target = nearest + (reduced.matches ? 0 : Math.PI * 2);
        if (reduced.matches) angle = target;
        lastTouch = performance.now() - 1500;
        wake();
      },
    };

    fit(); pose(); render();
    // Used to make the static pictures, so they match the 3D view exactly.
    canvas.capture = (type, quality) => { render(); return canvas.toDataURL(type || 'image/webp', quality || 0.9); };
    canvas.classList.add('is-ready');
    loader.hidden = true; hint.hidden = false;
    stage.classList.add('is-3d');
    poster.classList.add('is-done');
    wake();
  }

  select(0);

  const saveData = navigator.connection && navigator.connection.saveData;
  const webgl = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })();
  if (saveData || !webgl) { staticOnly(); return; }

  loader.hidden = false;
  const io = new IntersectionObserver((es) => {
    if (!es[0].isIntersecting) return;
    io.disconnect();
    start().catch(() => { staticOnly(); });
  }, { rootMargin: '500px' });
  io.observe(stage);
})();
