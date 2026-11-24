// Searching the behavioral health provider directory (data/bh-providers.json) during a contact.
// Pure functions, so the search behaves the same in the browser, the mock API and tests.

// What each ASC need starts the search with. Needs the directory doesn't cover say so instead.
export const NEED_SEARCH = {
  'Mental health services for a child': { services: ['mh-outpatient'], ages: 'children' },
  'Mental health, adult': { services: ['mh-outpatient'], ages: 'adults' },
  'Substance use treatment': { services: ['sud-assessment'], ages: 'adults' },
  Housing: { category: 'housing' }
};
export const NOT_COVERED = {
  'Health coverage (MA or HealthChoices)': 'For coverage questions, Community Care Member Services is in the directory (search “Community Care”).',
  'Food or other benefits': 'Food and benefits aren’t in this directory. 211 covers them.',
  'Physical health care': 'Physical health care isn’t in this directory yet.',
  'Rides to care (MATP)': 'Rides aren’t in this directory. Use the MATP resource.'
};

// The person's age from the intake answer, as a directory age group.
const INTAKE_AGES = { 'Child, 0–17': 'children', 'Transition-age youth, 18–25': 'transition-age-youth', 'Adult, 26–59': 'adults', 'Adult, 18–59': 'adults', 'Older adult, 60+': 'older-adults' };
export const ageFromIntake = (age) => INTAKE_AGES[age] || '';
export const AGE_FILTERS = [['', 'Any age'], ['children', 'Children'], ['adolescents', 'Adolescents'], ['transition-age-youth', 'Transition-age youth'], ['adults', 'Adults'], ['older-adults', 'Older adults']];
// Children's services are usually labeled "children" and "adolescents" together, so a child search also matches adolescents' listings.
const AGE_MATCH = { children: ['children'], adolescents: ['adolescents'], 'transition-age-youth': ['transition-age-youth', 'adults'], adults: ['adults'], 'older-adults': ['older-adults', 'adults'] };

export function emptyFilters(seed = {}) {
  return { q: '', category: '', service: '', ages: '', population: '', area: '', inCounty: true, ...seed };
}

// The filters to start with for one interaction: its need, and the age from intake.
export function filtersFor(need, intakeAge) {
  const s = NEED_SEARCH[need] || {};
  return emptyFilters({ service: s.services ? s.services[0] : '', category: s.category || '', ages: ageFromIntake(intakeAge) || s.ages || '' });
}

// ------------------------------------------------------------------ distance
// Where "near" is: a 5-digit ZIP, or a town name from the ZIP list (its ZIPs averaged). null when it's neither, and
// then the search falls back to matching the text against addresses. `zips` maps ZIP → [latitude, longitude, city].
export function placeFor(zips, text) {
  const t = String(text || '').trim();
  if (!zips || !t) return null;
  if (/^\d{5}$/.test(t)) { const z = zips[t]; return z ? { lat: z[0], lon: z[1], label: t, town: z[2] } : null; }
  const name = t.toLowerCase().replace(/^the\s+/, '');
  if (NEIGHBORHOODS[name] && zips[NEIGHBORHOODS[name]]) { const z = zips[NEIGHBORHOODS[name]]; return { lat: z[0], lon: z[1], label: t, town: 'Pittsburgh' }; }
  // Towns only count in southwestern Pennsylvania (ZIPs 150–156), so "Lawrenceville" isn't the one in Tioga County.
  const hits = Object.keys(zips).filter((k) => k < '157' && zips[k][2].toLowerCase() === name);
  if (!hits.length) return null;
  const avg = (i) => hits.reduce((s, k) => s + zips[k][i], 0) / hits.length;
  return { lat: avg(0), lon: avg(1), label: t, town: zips[hits[0]][2] };
}
// Pittsburgh neighborhoods people name instead of a ZIP, with the ZIP that covers most of each.
const NEIGHBORHOODS = {
  downtown: '15222', 'the strip': '15222', 'strip district': '15222', 'north side': '15212', northside: '15212', 'north shore': '15212',
  'east liberty': '15206', 'highland park': '15206', lawrenceville: '15201', bloomfield: '15224', garfield: '15224', 'polish hill': '15219',
  'hill district': '15219', 'the hill': '15219', uptown: '15219', oakland: '15213', shadyside: '15232', 'squirrel hill': '15217',
  greenfield: '15207', hazelwood: '15207', 'south side': '15203', southside: '15203', 'mount washington': '15211', 'mt washington': '15211',
  beechview: '15216', brookline: '15226', carrick: '15210', 'homewood': '15208', 'point breeze': '15208', 'east hills': '15221',
  'morningside': '15206', 'stanton heights': '15201', 'manchester': '15233', 'west end': '15220', 'sheraden': '15204', 'beltzhoover': '15210',
  'knoxville': '15210', 'allentown': '15210', 'troy hill': '15212', 'spring hill': '15212', 'brighton heights': '15212', 'perry south': '15214'
};
// Straight-line miles between two points. Good enough to sort by; driving or bus distance is longer.
export function milesBetween(a, b) {
  const r = (d) => (d * Math.PI) / 180, R = 3958.8;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const milesText = (m) => (m == null ? '' : m < 1 ? 'Under 1 mi' : 'About ' + Math.round(m) + ' mi');
const siteMiles = (zips, place, fac) => {
  const z = place && fac.address && zips[fac.address.zip];
  return z ? milesBetween(place, { lat: z[0], lon: z[1] }) : null;
};

const has = (hay, needle) => String(hay || '').toLowerCase().indexOf(needle) >= 0;
const addressText = (f) => (f.address ? [f.address.line1, f.address.line2, f.address.city, f.address.zip].join(' ') : '');

function serviceMatches(s, f, labels, cats) {
  if (f.service && s.service !== f.service) return false;
  if (!f.service && f.category && cats[s.service] !== f.category) return false;
  if (f.ages) {
    const want = AGE_MATCH[f.ages] || [f.ages];
    if (s.ageGroups.length && !s.ageGroups.some((g) => want.indexOf(g) >= 0)) return false;
  }
  return true;
}

// Returns matching providers, each with the sites that offer a matching service. Sites a source didn't confirm are
// returned as "unsited" services: the provider offers it, call to find where.
// A ZIP or town in `area` sorts by distance instead of filtering: nearest site first, each site with `miles`. Any
// other text in `area` still filters by address.
export function searchProviders(dir, filters) {
  if (!dir) return [];
  const f = emptyFilters(filters);
  const q = f.q.trim().toLowerCase();
  const zips = dir.zips || {};
  const place = placeFor(zips, f.area);
  const area = place ? '' : f.area.trim().toLowerCase();
  const labels = {}, cats = {};
  dir.vocabularies.services.forEach((s) => { labels[s.id] = s.label; cats[s.id] = s.category; });
  const out = [];
  dir.providers.forEach((p) => {
    if (q) {
      const text = [p.name, p.aka.join(' '), p.operator, p.notes].concat(p.services.map((s) => labels[s.service] + ' ' + (s.notes || ''))).join(' ').toLowerCase();
      if (text.indexOf(q) < 0) return;
    }
    const matched = p.services.filter((s) => serviceMatches(s, f, labels, cats)
      && (!f.population || s.populations.indexOf(f.population) >= 0 || p.serves.populations.indexOf(f.population) >= 0));
    if (!matched.length) return;
    const byFacility = {};
    const unsited = [];
    matched.forEach((s) => {
      if (!s.facilities.length) { unsited.push(s); return; }
      s.facilities.forEach((id) => { (byFacility[id] = byFacility[id] || []).push(s); });
    });
    const sites = p.facilities.filter((fac) => byFacility[fac.id]
      && (!f.inCounty || fac.inAlleghenyCounty)
      && (!area || has(addressText(fac), area) || has(fac.name, area)))
      .map((fac) => ({ facility: fac, services: byFacility[fac.id], miles: siteMiles(zips, place, fac) }))
      .sort((a, b) => (a.miles == null ? 1e9 : a.miles) - (b.miles == null ? 1e9 : b.miles));
    const keepUnsited = unsited.length && !area && (!f.inCounty || p.facilities.some((fac) => fac.inAlleghenyCounty) || !p.facilities.length);
    if (!sites.length && !keepUnsited) return;
    const specific = f.population && matched.some((s) => s.populations.indexOf(f.population) >= 0) ? 2 : 0;
    const near = sites.length && sites[0].miles != null ? sites[0].miles : null;
    out.push({ provider: p, sites, unsited: keepUnsited ? unsited : [], miles: near, score: specific + sites.length * 0.1 + (p.verification.level === 'multiple' ? 0.5 : 0) });
  });
  // By distance: the provider with the nearest site first. Providers with no site to measure come last.
  if (place) return out.sort((a, b) => (a.miles == null) - (b.miles == null) || (a.miles || 0) - (b.miles || 0) || b.score - a.score || a.provider.name.localeCompare(b.provider.name));
  return out.sort((a, b) => b.score - a.score || a.provider.name.localeCompare(b.provider.name));
}

// What gets saved on the interaction: a snapshot, so the record still reads right if the directory changes.
export function referralFrom(p, fac) {
  const a = fac && fac.address;
  return {
    providerId: p.id, facilityId: fac ? fac.id : '', name: p.name, site: fac ? fac.name : '',
    phone: (fac && fac.phone) || Object.values(p.phones)[0] || '',
    address: a ? [a.line1, a.line2].filter(Boolean).join(', ') + ', ' + a.city + ' ' + a.zip : ''
  };
}
export const referralText = (r) => (!r || !r.name ? '' : r.name + (r.site && r.site !== r.name ? ' (' + r.site + ')' : ''));
