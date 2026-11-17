'use strict';

// Prize claim page (server/claimRoutes.js). The page never sees the partner's
// address: "Open your prize account" is the server's /go/c/ redirect.
(function () {
  const $ = (id) => document.getElementById(id);
  const token = decodeURIComponent(location.pathname.split('/').pop() || '');
  const COUNTRIES = 'AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HK HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY PE PH PL PT PR QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW'.split(' ');
  const names = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { return null; } })();
  const sel = $('clCountry');
  COUNTRIES.map((c) => [c, names ? names.of(c) : c]).sort((a, b) => a[1].localeCompare(b[1])).forEach(([c, n]) => sel.insertAdjacentHTML('beforeend', `<option value="${c}">${n}</option>`));

  function friendly(kind) {
    $('clStatus').classList.remove('hidden');
    $('clBody').classList.add('hidden');
    $('clStatus').innerHTML = {
      expired: 'This claim link has expired. Claim links work for 14 days. Contact <a href="mailto:hello@spikeandcrush.com">hello@spikeandcrush.com</a> and we will help.',
      used: 'This claim link was already used. If you still need help with your prize, contact <a href="mailto:hello@spikeandcrush.com">hello@spikeandcrush.com</a>.',
      invalid: 'This claim link is not valid. Please use the link in your email exactly as it was sent, or contact <a href="mailto:hello@spikeandcrush.com">hello@spikeandcrush.com</a>.',
    }[kind] || 'This page is not available right now. Please try again later.';
  }

  async function load() {
    let res;
    try {
      res = await fetch(`/api/claims/${encodeURIComponent(token)}`);
    } catch (e) {
      return friendly('down');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return friendly(data.error);
    const c = data.claim;
    $('clStatus').classList.add('hidden');
    $('clBody').classList.remove('hidden');
    $('clTitle').textContent = c.manual ? 'Your result' : c.button === 'Claim your challenge' ? 'Claim your challenge' : 'Claim your prize';
    $('clIntro').textContent = `You finished #${c.rank} in ${c.competition} and won ${c.prize}.${c.partnerName ? ` Provided by ${c.partnerName}.` : ''}`;
    $('clDelivery').textContent = c.delivery;
    if (c.steps) { $('clSteps').textContent = c.steps; $('clSteps').classList.remove('hidden'); }
    $('clDisclosure').textContent = c.disclosure || '';
    $('clConsentText').textContent = c.consentText;
    $('clGoBtn').textContent = c.button;
    if (c.manual) { $('clForm').classList.add('hidden'); return; }
    if (c.claimed) { $('clForm').classList.add('hidden'); $('clGo').classList.remove('hidden'); $('clGoBtn').href = `/go/c/${encodeURIComponent(token)}`; }
  }

  $('clForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('clError').textContent = '';
    if (!$('clAge').checked) return ($('clError').textContent = 'Confirm that you are 18 or over.');
    if (!sel.value) return ($('clError').textContent = 'Choose your country.');
    const btn = $('clSubmit');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/claims/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ over18: true, country: sel.value, consent: $('clConsent').checked }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (['expired', 'used', 'invalid'].includes(data.error)) return friendly(data.error);
        $('clError').textContent = data.message || 'Could not save your claim. Please try again.';
      } else if (!data.consent) {
        $('clError').textContent = data.message;
      } else {
        $('clForm').classList.add('hidden');
        $('clGo').classList.remove('hidden');
        $('clGoBtn').href = data.go;
      }
    } catch (err) {
      $('clError').textContent = 'Could not reach the server. Check your connection and try again.';
    }
    btn.disabled = false;
  });

  load();
})();
