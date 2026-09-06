'use strict';

window.TW = window.TW || {};

// Reusable searchable country selector. Mounts into a container with the
// fixed IDs the markup below expects (#cs-selected-text, #cs-flag,
// #cs-dropdown, #cs-search, #cs-list) - only one instance per page is
// supported today since IDs aren't namespaced, matching the one real
// selector in the app (Settings > Profile > Country).
(function () {
  const COUNTRIES = [
    { code: 'AE', name: 'United Arab Emirates', flag: '🇦🇪' },
    { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
    { code: 'US', name: 'United States', flag: '🇺🇸' },
    { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
    { code: 'GH', name: 'Ghana', flag: '🇬🇭' },
    { code: 'KE', name: 'Kenya', flag: '🇰🇪' },
    { code: 'EG', name: 'Egypt', flag: '🇪🇬' },
    { code: 'IN', name: 'India', flag: '🇮🇳' },
    { code: 'PK', name: 'Pakistan', flag: '🇵🇰' },
    { code: 'PH', name: 'Philippines', flag: '🇵🇭' },
    { code: 'BD', name: 'Bangladesh', flag: '🇧🇩' },
    { code: 'AU', name: 'Australia', flag: '🇦🇺' },
    { code: 'CA', name: 'Canada', flag: '🇨🇦' },
    { code: 'DE', name: 'Germany', flag: '🇩🇪' },
    { code: 'FR', name: 'France', flag: '🇫🇷' },
    { code: 'IT', name: 'Italy', flag: '🇮🇹' },
    { code: 'ES', name: 'Spain', flag: '🇪🇸' },
    { code: 'NL', name: 'Netherlands', flag: '🇳🇱' },
    { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
    { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
    { code: 'AR', name: 'Argentina', flag: '🇦🇷' },
    { code: 'TR', name: 'Turkey', flag: '🇹🇷' },
    { code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦' },
    { code: 'QA', name: 'Qatar', flag: '🇶🇦' },
    { code: 'KW', name: 'Kuwait', flag: '🇰🇼' },
    { code: 'BH', name: 'Bahrain', flag: '🇧🇭' },
    { code: 'OM', name: 'Oman', flag: '🇴🇲' },
    { code: 'JO', name: 'Jordan', flag: '🇯🇴' },
    { code: 'LB', name: 'Lebanon', flag: '🇱🇧' },
    { code: 'MA', name: 'Morocco', flag: '🇲🇦' },
    { code: 'TN', name: 'Tunisia', flag: '🇹🇳' },
    { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
    { code: 'MY', name: 'Malaysia', flag: '🇲🇾' },
    { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
    { code: 'TH', name: 'Thailand', flag: '🇹🇭' },
    { code: 'VN', name: 'Vietnam', flag: '🇻🇳' },
    { code: 'JP', name: 'Japan', flag: '🇯🇵' },
    { code: 'KR', name: 'South Korea', flag: '🇰🇷' },
    { code: 'CN', name: 'China', flag: '🇨🇳' },
    { code: 'HK', name: 'Hong Kong', flag: '🇭🇰' },
    { code: 'NZ', name: 'New Zealand', flag: '🇳🇿' },
    { code: 'ZW', name: 'Zimbabwe', flag: '🇿🇼' },
    { code: 'TZ', name: 'Tanzania', flag: '🇹🇿' },
    { code: 'UG', name: 'Uganda', flag: '🇺🇬' },
    { code: 'ET', name: 'Ethiopia', flag: '🇪🇹' },
    { code: 'SN', name: 'Senegal', flag: '🇸🇳' },
    { code: 'CI', name: 'Ivory Coast', flag: '🇨🇮' },
    { code: 'CM', name: 'Cameroon', flag: '🇨🇲' },
    { code: 'RW', name: 'Rwanda', flag: '🇷🇼' },
    { code: 'TT', name: 'Trinidad and Tobago', flag: '🇹🇹' },
    { code: 'JM', name: 'Jamaica', flag: '🇯🇲' },
    { code: 'OTHER', name: 'Other', flag: '🌍' },
  ];

  let selectedCode = '';
  let open = false;
  let onChangeCb = null;

  function renderList(list) {
    const el = document.getElementById('cs-list');
    if (!el) return;
    el.innerHTML = list.map((c) => `
      <div class="cs-item" data-code="${c.code}">
        <span class="cs-item-flag">${c.flag}</span>
        <span class="cs-item-name">${c.name}</span>
      </div>
    `).join('');
    el.querySelectorAll('.cs-item').forEach((row) => {
      row.addEventListener('click', () => {
        const country = COUNTRIES.find((c) => c.code === row.dataset.code);
        if (country) select(country);
      });
    });
  }

  function select(country) {
    selectedCode = country.code;
    const flagEl = document.getElementById('cs-flag');
    const textEl = document.getElementById('cs-selected-text');
    if (flagEl) flagEl.textContent = country.flag;
    if (textEl) textEl.textContent = country.name;
    setOpen(false);
    if (onChangeCb) onChangeCb(country.code);
  }

  function setOpen(next) {
    open = next;
    const dd = document.getElementById('cs-dropdown');
    if (dd) dd.style.display = open ? 'block' : 'none';
    if (open) document.getElementById('cs-search')?.focus();
  }

  // existingCode: a country code (e.g. 'AE') already saved for this player.
  // onChange: called with the new code every time the player picks one.
  function init(existingCode, onChange) {
    onChangeCb = onChange || null;
    renderList(COUNTRIES);

    if (existingCode) {
      const found = COUNTRIES.find((c) => c.code === existingCode);
      if (found) {
        selectedCode = found.code;
        const flagEl = document.getElementById('cs-flag');
        const textEl = document.getElementById('cs-selected-text');
        if (flagEl) flagEl.textContent = found.flag;
        if (textEl) textEl.textContent = found.name;
      }
    }

    document.getElementById('csSelected')?.addEventListener('click', () => setOpen(!open));
    document.getElementById('cs-search')?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('cs-search')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      renderList(q ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q)) : COUNTRIES);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#country-selector')) setOpen(false);
    });
  }

  TW.CountrySelector = {
    init,
    getValue: () => selectedCode,
    COUNTRIES,
  };
})();
