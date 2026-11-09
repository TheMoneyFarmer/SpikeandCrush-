'use strict';
// Quiet animated gradient, drawn behind a section's content. No dependencies.
//
//   <div class="offer" data-shader-bg="coins"> ... </div>
//
// The canvas is decoration: it sits behind the content, ignores the pointer and
// cannot be selected. The output is always a blend of the palette's colours, so
// the lightest colour in a palette is the brightest the section can ever get.
// Check contrast against that colour when changing a palette.
//
// It stops drawing when the section is off screen or the tab is hidden, draws a
// single still frame for reduced motion, and leaves the section's normal CSS
// background in place if WebGL is unavailable.
(function () {
  // ADJUST HERE: colours per palette and theme, overall speed, resolution, frame rate.
  const PALETTES = {
    coins: {
      dark: ['#182746', '#17305c', '#4a3614'],
      light: ['#ffffff', '#eaf1fc', '#fdf3de'],
    },
    war: {
      dark: ['#182746', '#0d3a30', '#431828'],
      light: ['#ffffff', '#e4f6ee', '#fce9ec'],
    },
  };
  const SPEED = 0.05;        // lower is calmer
  const SCALE_DESKTOP = 0.5; // canvas pixels per CSS pixel; a soft gradient needs few
  const SCALE_PHONE = 0.35;
  const FPS_DESKTOP = 30;
  const FPS_PHONE = 20;

  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec3 a,b,c;
float rnd(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 u=gl_FragCoord.xy/r;
  vec2 q=vec2(u.x*r.x/max(r.y,1.),u.y)*1.15;
  float n1=sin(q.x*1.7+t*1.1+sin(q.y*2.1-t*.7)*1.3);
  float n2=sin(q.y*2.3-t*.9+sin(q.x*1.4+t*.6)*1.5);
  float m1=smoothstep(-.9,.9,n1);
  float m2=smoothstep(-.2,1.,n2*.6+n1*.4);
  // Weights always sum to 1 or less, so output stays between the palette colours.
  // Accent c fades where b is strong, which keeps the two from mixing to grey.
  vec3 col=a+(b-a)*m1+(c-a)*m2*(1.-m1)*.95;
  col+=(rnd(gl_FragCoord.xy+fract(t))-.5)/255.;
  gl_FragColor=vec4(col,1.);
}`;

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const isPhone = () => matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

  function mount(host) {
    if (host.querySelector(':scope > .shader-bg')) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'shader-bg';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;user-select:none;-webkit-user-select:none;opacity:0;transition:opacity .6s ease';

    const opts = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
    const gl = canvas.getContext('webgl', opts);
    if (!gl) return; // the section keeps its CSS background

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.prepend(canvas);

    let U = null, visible = true, raf = 0, last = 0, clock = 0, shown = false;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    }
    function setup() {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(gl.getAttribLocation(prog, 'p'));
      gl.vertexAttribPointer(gl.getAttribLocation(prog, 'p'), 2, gl.FLOAT, false, 0, 0);
      U = { r: gl.getUniformLocation(prog, 'r'), t: gl.getUniformLocation(prog, 't'), a: gl.getUniformLocation(prog, 'a'), b: gl.getUniformLocation(prog, 'b'), c: gl.getUniformLocation(prog, 'c') };
      setColours();
      return true;
    }
    function setColours() {
      if (!U) return;
      const set = PALETTES[host.dataset.shaderBg] || PALETTES.coins;
      const cols = (document.documentElement.getAttribute('data-theme') === 'light' ? set.light : set.dark).map(hex);
      gl.uniform3fv(U.a, cols[0]); gl.uniform3fv(U.b, cols[1]); gl.uniform3fv(U.c, cols[2]);
    }
    function resize() {
      const s = isPhone() ? SCALE_PHONE : SCALE_DESKTOP;
      const w = Math.max(1, Math.round(host.clientWidth * s)), h = Math.max(1, Math.round(host.clientHeight * s));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
    }
    function draw(t) {
      if (!U) return;
      gl.uniform2f(U.r, canvas.width, canvas.height);
      gl.uniform1f(U.t, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!shown) { shown = true; canvas.style.opacity = '1'; }
    }
    function loop(now) {
      raf = requestAnimationFrame(loop);
      const fps = isPhone() ? FPS_PHONE : FPS_DESKTOP;
      if (now - last < 1000 / fps - 1) return;
      const dt = last ? Math.min(now - last, 100) : 0;
      last = now;
      clock += (dt / 1000) * SPEED * 10;
      draw(clock);
    }
    function stop() { cancelAnimationFrame(raf); raf = 0; last = 0; }
    function sync() {
      const run = visible && !document.hidden && !reducedQuery.matches;
      if (run && !raf) raf = requestAnimationFrame(loop);
      else if (!run) { stop(); draw(clock); }
    }

    if (!setup()) { canvas.remove(); return; }
    resize(); draw(clock);

    new ResizeObserver(() => { resize(); draw(clock); }).observe(host);
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { rootMargin: '100px' }).observe(host);
    document.addEventListener('visibilitychange', sync);
    reducedQuery.addEventListener('change', sync);
    const recolour = new MutationObserver(() => { setColours(); draw(clock); });
    recolour.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    recolour.observe(host, { attributes: true, attributeFilter: ['data-shader-bg'] });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); U = null; });
    canvas.addEventListener('webglcontextrestored', () => { if (setup()) { resize(); draw(clock); sync(); } });

    // Lets a test read real pixels at any point in the cycle.
    canvas.sampleAt = (t) => {
      draw(t);
      const px = new Uint8Array(4 * canvas.width * canvas.height);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    sync();
  }

  function init() { document.querySelectorAll('[data-shader-bg]').forEach(mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
