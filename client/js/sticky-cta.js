'use strict';

// One sticky bottom button for logged-out phone visitors on the landing and
// competition pages. Logged-in players already have the bottom tab bar. It hides
// while the page's own main button is on screen, while the keyboard is open and
// while the cookie banner is up, and leaves room for the support button.
(function () {
  if (!window.matchMedia('(max-width: 767px)').matches) return;
  let token = null;
  try { token = localStorage.getItem('sc_token') || localStorage.getItem('tw_token'); } catch (e) { /* treat as logged out */ }
  if (token) return;

  const isCompetition = location.pathname.startsWith('/competition/');
  const hero = document.querySelector('.hero .btn-primary');

  const style = document.createElement('style');
  style.textContent = `
    .sc-sticky-cta{position:fixed;left:0;right:0;bottom:0;z-index:8000;padding:10px 84px calc(10px + env(safe-area-inset-bottom)) 16px;background:var(--c-elev,#1d2d50);border-top:1px solid var(--c-hair-2,rgba(160,182,222,.26));transition:transform .2s}
    .sc-sticky-cta[hidden]{display:none}
    .sc-sticky-cta button{width:100%;min-height:48px;border:0;border-radius:999px;background:var(--c-blue-fill,#1d6fe6);color:#fff;font:700 15px Inter,system-ui,sans-serif;cursor:pointer}
    @media (prefers-reduced-motion: reduce){.sc-sticky-cta{transition:none}}`;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'sc-sticky-cta';
  bar.hidden = true;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = isCompetition ? 'Enter' : 'Play now';
  button.addEventListener('click', () => {
    if (typeof window.openPanel === 'function') window.openPanel('register');
    else location.href = '/?signup=1';
  });
  bar.appendChild(button);
  document.body.appendChild(bar);

  let heroVisible = Boolean(hero);
  let keyboardOpen = false;
  const update = () => { bar.hidden = heroVisible || keyboardOpen; };

  if (hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; update(); }).observe(hero);
  } else {
    heroVisible = false;
  }
  if (window.visualViewport) {
    const base = window.innerHeight;
    window.visualViewport.addEventListener('resize', () => {
      keyboardOpen = window.visualViewport.height < base * 0.75;
      update();
    });
  }
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea, select')) { keyboardOpen = true; update(); }
  });
  document.addEventListener('focusout', () => { keyboardOpen = false; update(); });
  update();
})();
