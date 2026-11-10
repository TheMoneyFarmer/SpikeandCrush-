'use strict';

// Arena layout for the match screen on desktop (css/arena.css): standings and
// the card feed race down the left, the cards sit in a dock under the chart,
// and the instrument tabs join the chart's header. The same elements are
// moved, not copied, so every listener and id keeps working. Below desktop
// width they go back where game.html puts them, which is the layout
// css/mobile.css was written for.
(function () {
  const mq = window.matchMedia('(min-width: 1025px)');
  const homes = []; // [{ el, parent, next }] in the order they were moved

  function move(el, target, prepend) {
    if (!el || !target || el.parentNode === target) return;
    homes.push({ el, parent: el.parentNode, next: el.nextSibling });
    if (prepend) target.prepend(el);
    else target.appendChild(el);
  }

  function restore() {
    while (homes.length) {
      const { el, parent, next } = homes.pop();
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
    }
  }

  function apply() {
    const on = mq.matches;
    document.body.classList.toggle('arena', on);
    if (!on) {
      restore();
      return;
    }
    if (homes.length) return;
    const race = document.getElementById('arenaRace');
    move(document.getElementById('leaderboardPanel'), race);
    move(document.querySelector('.match-feed'), race);
    move(document.querySelector('.sabotage-panel'), document.getElementById('arenaDock'));
    move(document.getElementById('instrumentTabs'), document.querySelector('.chart-quotes'), true);
    // The chart library sizes itself to its box: tell it the box changed.
    window.dispatchEvent(new Event('resize'));
  }

  if (mq.addEventListener) mq.addEventListener('change', apply);
  else mq.addListener(apply);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
