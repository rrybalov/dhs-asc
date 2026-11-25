// ASC server logic: contacts (calls and in-person visits), identifying and enrolling the client, the automatic
// follow-ups, and contact history. Like backend.js, these run in the browser's sample-data source and in
// tools/mock-api.mjs. docs/API.md describes the endpoints.
import { NotFound, BadRequest, Forbidden, summary, fullRecord, newId, createNote } from './backend.js';
import { followUpPlan, SCREENING, totals, plural, summaryNote, isSummaryNote, LEGACY, OPEN, CRISIS, SUPERVISOR, addBusinessDays, dayOf, shown, DISCHARGE_REASONS, ageGroupFor, blankReach, blankDemo, REACH_FIELDS, DEMO_FIELDS, ACTION_STATUS, CLOSED_STATUS, ATTEMPT_RESULTS, REFERRAL_STATUS, REFERRAL_SOURCES, MIN_RANGES, unitsFor, weekday } from './asc.js';
const DISCHARGE_REASONS_SET = new Set(DISCHARGE_REASONS);
import { describePatch, appendLog, backfillLog } from './asc-log.js';
import { ASC_ENROLLMENT } from './asc-seed.js';

const pad = (n) => String(n).padStart(2, '0');
const usOf = (d) => pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
const findContact = (db, id) => { const k = (db.contacts || []).find((x) => x.id === id); if (!k) throw new NotFound('Contact'); return k; };
const findClient = (db, id) => { const c = db.clients.find((x) => x.id === id); if (!c) throw new NotFound('Client'); return c; };
const clone = (v) => JSON.parse(JSON.stringify(v));
const ensure = (db) => { if (!db.contacts) db.contacts = []; if (!db.contactSeq) db.contactSeq = 184; if (db.ascModel !== 6) migrate(db); };

// v4.1 renamed outcomes, merged screening's "Not sure" and "Prefers not to say" into "Skip", shortened the safety
// answer and added roles. Stored data is upgraded once, in place.
const ROLES = { u1: 'ASC Coordinator', u2: 'ASC Coordinator', u6: 'ASC Coordinator', u4: SUPERVISOR };
export const ascReady = (db) => ensure(db);
function migrate(db) {
  (db.contacts || []).forEach((k) => {
    k.needs.forEach((n) => { if (LEGACY.outcome[n.outcome]) n.outcome = LEGACY.outcome[n.outcome]; });
    if (k.intake && k.intake.safety in LEGACY.safety) k.intake.safety = LEGACY.safety[k.intake.safety];
    Object.keys(k.screening || {}).forEach((q) => { if (LEGACY.screening[k.screening[q]]) k.screening[q] = LEGACY.screening[k.screening[q]]; });
    if (!k.corrections) k.corrections = [];
    if (k.correction === undefined) k.correction = null;
    backfillLog(k); // v4.2: a step-by-step log, built from the answers for contacts saved before it existed
    upgradeIntake(db, k); // v4.6
    upgradeOutreach(k); // v4.7
  });
  (db.actions || []).forEach(upgradeAction);
  if (!db.ascReferrals) seedReferrals(db); // v4.7: referrals from other programs, waiting for a call
  (db.staff || []).forEach((s) => { if (!s.role && ROLES[s.id]) s.role = ROLES[s.id]; });
  (db.clients || []).forEach((c) => syncAscService(db, c));
  if (!db.closeouts) seedCloseout(db); // v4.3: one request waiting, so the supervisor's queue isn't empty
  db.ascModel = 6;
}
// v4.7: outreach (who started the conversation, and what it was for), the caller's name and details as separate
// fields, consent to share information, a last name for anonymous and name-only contacts, minute ranges,
// and statuses and call attempts on action items.
function upgradeOutreach(k) {
  if (!k.direction) k.direction = 'in';
  if (k.purpose === undefined) k.purpose = null;
  const i = k.intake;
  ['callerFirst', 'callerLast', 'callerRelation', 'callerPhone', 'consentBy', 'consentAt'].forEach((f) => { if (i[f] === undefined) i[f] = ''; });
  if (i.consent === undefined) i.consent = null;
  if (k.anon && k.anon.last === undefined) k.anon.last = '';
  if (k.unverifiedFirst === undefined) { const p = String(k.unverifiedName || '').trim().split(/\s+/); k.unverifiedFirst = p.length > 1 ? p.slice(0, -1).join(' ') : p[0] || ''; k.unverifiedLast = p.length > 1 ? p[p.length - 1] : ''; }
  (k.interactions || []).forEach((x) => { if (x.range === undefined) x.range = Number(x.min) > 0 ? 'custom' : ''; });
  (k.actions || []).forEach(upgradeAction);
}
function upgradeAction(a) {
  if (!a.status) a.status = a.done ? 'done' : 'open';
  if (!a.attempts) a.attempts = [];
}
// v4.6: one detail box under each caller and "how they found us" answer (replacing "Other" and the caller's name),
// the client's name as the caller gives it, contact info and demographics, and the 18–25 age group.
function upgradeIntake(db, k) {
  const i = k.intake || (k.intake = {});
  if (i.callerDetail === undefined) i.callerDetail = [i.callerName, i.callerOther].filter(Boolean).join(', ');
  if (i.foundDetail === undefined) i.foundDetail = i.foundOther || '';
  delete i.callerName; delete i.callerOther; delete i.foundOther;
  if (i.clientFirst === undefined) { i.clientFirst = ''; i.clientLast = ''; }
  if (LEGACY.age[i.age]) {
    const c = k.clientId && (db.clients || []).find((x) => x.id === k.clientId);
    const fromDob = c && ageGroupFor(c.dob, new Date(k.startedAt));
    i.age = fromDob && fromDob !== 'Child, 0–17' && fromDob !== 'Older adult, 60+' ? fromDob : LEGACY.age[i.age];
  }
  if (!k.reach) k.reach = blankReach();
  if (!k.demo) k.demo = blankDemo();
  if (k.identifiedIn === undefined) k.identifiedIn = k.clientId && (k.log || []).some((l) => /^Started from /.test(l.text)) ? 'profile' : k.clientId ? 'identify' : null;
}
function seedCloseout(db) {
  db.closeouts = [];
  const done = (db.clients || []).find((c) => c.id !== 'c65' && (c.enrollments || []).some((e) => e.name === ASC_ENROLLMENT && e.kind === 'active')
    && (db.contacts || []).some((k) => k.clientId === c.id) && (db.contacts || []).every((k) => k.clientId !== c.id || (k.status === 'closed' && k.needs.every((n) => n.outcome !== OPEN))));
  if (!done) return;
  const k = db.contacts.filter((x) => x.clientId === done.id).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  db.closeouts.push({ id: 'co1', clientId: done.id, by: k.staff, at: new Date(Date.now() - 26 * 3600000).toISOString(), reason: 'Needs met',
    note: 'Connected and confirmed at the follow-up call. Nothing else they need from us.', status: 'pending', decidedBy: '', decidedAt: '', decisionNote: '' });
}
const me = (db) => (db.staff || []).find((s) => s.id === db.userId) || {};
const isSupervisor = (db) => me(db).role === SUPERVISOR;
const staffLabel = (db, id) => { const s = (db.staff || []).find((x) => x.id === id); return s ? s.first + ' ' + s.last : 'ASC'; };
const clientName = (c) => (c ? c.first + ' ' + c.last : '');

function contactSummary(db, k) {
  const c = k.clientId ? db.clients.find((x) => x.id === k.clientId) : null;
  const t = totals(k.interactions);
  return {
    id: k.id, ref: k.ref, channel: k.channel, site: k.site, startedAt: k.startedAt, endedAt: k.endedAt, status: k.status, closedKind: k.closedKind,
    staff: k.staff, clientId: k.clientId, identity: k.identity, path: k.path, clientName: clientName(c) || (k.identity === 'unverified' ? k.unverifiedName : ''),
    anonName: [k.anon.name, k.anon.last].filter(Boolean).join(' '), needs: k.needs.map((n) => ({ name: n.name, urg: n.urg, outcome: n.outcome, resolvedAt: n.resolvedAt || '' })), ixCount: t.count, ixMin: t.min, ixUnits: t.units,
    direction: k.direction || 'in', purpose: k.purpose ? k.purpose.text : ''
  };
}

// Anonymous contacts that may belong to this contact's client: ones flagged as a likely match or tied by a
// reference number the caller gave, and not already on someone's record.
function possibleLinks(db, k) {
  if (!k.clientId) return [];
  return db.contacts.filter((x) => x.id !== k.id && !x.clientId && (x.possibleClientId === k.clientId || (k.group && x.group === k.group)) && k.linkedPrior !== 'no');
}

function full(db, k) {
  const out = clone(k);
  out.client = k.clientId ? summary(findClient(db, k.clientId)) : null;
  out.candidate = k.candidateId && !k.clientId ? summary(findClient(db, k.candidateId)) : null;
  out.possibleLinks = possibleLinks(db, k).map((x) => contactSummary(db, x));
  const known = k.clientId || k.candidateId ? db.clients.find((x) => x.id === (k.clientId || k.candidateId)) : null;
  out.known = known ? knownInfo(known, k.id) : null;
  return out;
}

export function listContacts(db, q = {}) {
  ensure(db);
  return db.contacts
    .filter((k) => (!q.status || k.status === q.status) && (!q.clientId || k.clientId === q.clientId))
    .map((k) => contactSummary(db, k))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export const getContact = (db, id) => { ensure(db); return full(db, findContact(db, id)); };

export function createContact(db, body = {}) {
  ensure(db);
  const n = db.contactSeq++;
  const channel = body.channel === 'person' ? 'person' : 'phone';
  const k = {
    id: newId('k'), ref: 'EV-26-' + String(n).padStart(6, '0'), channel,
    logId: (channel === 'person' ? 'VS-0912-' : 'CL-4417-') + String(4000 + n), site: channel === 'person' ? (body.site || 'Mercy Behavioral Health') : '',
    startedAt: new Date().toISOString(), endedAt: null, status: 'open', closedKind: null, staff: db.userId,
    clientId: null, identity: null, candidateId: null, possibleClientId: null, path: null, group: '', priorRefs: [], linkedPrior: null,
    anon: { name: '', last: '', zip: '', county: 'Allegheny', language: 'English' }, unverifiedName: '', unverifiedFirst: '', unverifiedLast: '',
    intake: { safety: null, caller: null, callerFirst: '', callerLast: '', callerRelation: '', callerPhone: '', callerDetail: '', clientFirst: '', clientLast: '', age: null, story: '', reason: null, reasonText: '', coverage: null, coverageDetail: '', found: null, foundDetail: '', privacy: null, callerConfirmed: null, coverageConfirmed: null, consent: null, consentBy: '', consentAt: '' },
    direction: body.direction === 'out' ? 'out' : 'in', purpose: null,
    reach: blankReach(), demo: blankDemo(), identifiedIn: null,
    screening: { mh: null, ph: null, house: null, food: null, su: null },
    needs: [], interactions: [], followUp: { ok: null, how: 'Phone call', time: '' }, onsite: { idCheck: null, consentSigned: '', docs: [] },
    notes: [], actions: [], links: [], urgent: null, correction: null, corrections: [], log: [], reminderId: null, createdAt: new Date().toISOString()
  };
  appendLog(k, [{ key: 'start', text: channel === 'person' ? 'Started an in-person visit at ' + k.site : k.direction === 'out' ? 'Started an outreach call' : 'Started a phone call' }], db.userId);
  // Outreach for an action item or a referral: the call is about that item, and the person is usually known.
  let clientId = body.clientId;
  if (body.actionId) {
    const a = db.actions.find((x) => x.id === body.actionId); if (!a) throw new NotFound('Action item');
    k.direction = 'out'; k.purpose = { kind: 'action', actionId: a.id, referralId: '', text: a.text };
    clientId = a.clientId;
    if (!CLOSED_STATUS.includes(a.status)) a.status = 'progress';
  } else if (body.referralId) {
    const r = findReferral(db, body.referralId);
    k.direction = 'out'; k.purpose = { kind: 'referral', actionId: '', referralId: r.id, text: 'Referral from ' + r.source + ': ' + r.reason };
    Object.assign(k.intake, { clientFirst: r.person.first, clientLast: r.person.last });
    if (r.person.dob) k.demo.dob = r.person.dob;
    if (r.person.phone) k.reach.phone = r.person.phone;
    if (r.person.zip) k.reach.zip = r.person.zip;
    const c = r.clientId ? findClient(db, r.clientId) : null;
    if (c && (c.colabs.indexOf('ASC') >= 0 || c.ascDischarge)) clientId = c.id; else if (c) { k.candidateId = c.id; k.path = 'client'; }
    if (r.status === 'new') r.status = 'contacted';
    r.contactIds.push(k.id);
    r.log.push({ at: k.startedAt, by: db.userId, text: 'Reached by phone: ' + k.ref });
  } else if (body.direction === 'out' && body.purpose) k.purpose = { kind: 'other', actionId: '', referralId: '', text: String(body.purpose).slice(0, 300) };
  if (k.purpose) appendLog(k, [{ key: 'purpose', text: 'Calling about: ' + k.purpose.text }], db.userId);
  if (clientId) {
    const c = findClient(db, clientId);
    if (c.colabs.indexOf('ASC') < 0 && !c.ascDischarge) throw new BadRequest('This client is not enrolled in ASC.');
    const back = !!c.ascDischarge;
    enroll(c); // a discharged client who comes back is re-enrolled
    Object.assign(k, { clientId: c.id, identity: 'matched', path: 'client', identifiedIn: 'profile', candidateId: null });
    k.intake.age = ageGroupFor(c.dob);
    appendLog(k, [{ key: 'identity', text: 'Started from ' + c.first + ' ' + c.last + '’s record' + (back ? ', re-enrolled in ASC' : '') }], db.userId);
    syncAscService(db, c);
  }
  db.contacts.unshift(k);
  return full(db, k);
}

// Creates, updates or removes the two automatic follow-ups so they match the contact's follow-up answer.
// Returns the client action items it changed.
function syncFollowUps(db, k) {
  const changed = [], removed = [];
  const autos = k.links.filter((l) => l.auto);
  const wanted = k.clientId && k.followUp.ok === 'Yes';
  if (!wanted) {
    autos.forEach((l) => {
      const i = db.actions.findIndex((a) => a.id === l.actionId);
      if (i >= 0 && !db.actions[i].done) { db.actions.splice(i, 1); removed.push(l.actionId); }
    });
    k.links = k.links.filter((l) => !l.auto || !removed.includes(l.actionId));
    return { changed, removed };
  }
  const c = findClient(db, k.clientId);
  const guardian = c.guardian && k.intake.caller === 'Parent or guardian' ? c.guardian.name.split(' ')[0] : c.first;
  followUpPlan(k, guardian).forEach((p) => {
    const link = autos.find((l) => l.auto === p.key);
    const existing = link && db.actions.find((a) => a.id === link.actionId);
    if (existing) {
      if (!existing.done && (existing.text !== p.text)) { existing.text = p.text; changed.push(existing); }
      return;
    }
    const a = { id: newId('a'), clientId: c.id, tag: 'ASC', text: p.text, assignee: k.staff, due: p.due, done: false, edited: false };
    db.actions.unshift(a); changed.push(a);
    k.links.push({ actionId: a.id, ixId: null, auto: p.key });
  });
  return { changed, removed };
}

const SECTIONS = ['intake', 'screening', 'followUp', 'onsite', 'anon', 'reach', 'demo'];
const LISTS = ['needs', 'interactions', 'notes', 'actions'];

// What can still change once a contact is closed: case notes and action items (and their links).
const AFTER_CLOSE = ['notes', 'actions', 'addLinks', 'removeLinks'];
// What a supervisor can correct on a closed contact. Who the contact is (identity, links) stays as closed.
const CORRECTABLE = ['intake', 'screening', 'needs', 'interactions', 'followUp', 'onsite', 'anon', 'reach', 'demo', 'site', 'channel', 'dropIxLinks'];
const text = (v, max) => String(v == null ? '' : v).slice(0, max);
const cleanSection = (v) => {
  const out = {};
  Object.keys(v).slice(0, 60).forEach((key) => { const x = v[key]; out[key] = Array.isArray(x) ? x.slice(0, 40).map((y) => text(y, 200)) : typeof x === 'boolean' || x === null ? x : typeof x === 'number' ? x : text(x, 4000); });
  return out;
};
const cleanNeed = (n) => ({ id: text(n.id, 40), name: text(n.name, 120), urg: text(n.urg, 40), outcome: text(n.outcome, 120), outcomeNote: text(n.outcomeNote, 2000), outcomeAuto: n.outcomeAuto === true ? true : n.outcomeAuto === false ? false : null });
// Minutes stay as typed, but no single interaction is recorded as longer than 10 hours.
const cleanMin = (v) => { const t = text(v, 6).trim(); const m = Number(t); return t && m > 600 ? '600' : t; };
// Who they were referred to: a snapshot from the provider directory, or a name typed in for someone not in it.
const cleanReferral = (r) => (!r || typeof r !== 'object' || !text(r.name, 200) ? null
  : { providerId: text(r.providerId, 60), facilityId: text(r.facilityId, 80), name: text(r.name, 200), site: text(r.site, 200), phone: text(r.phone, 40), address: text(r.address, 300) });
// A range sets the minutes to its top (so units come out right); "custom" keeps the minutes typed.
const cleanIx = (x) => {
  const range = MIN_RANGES[x.range] || x.range === 'custom' ? x.range : '';
  return { id: text(x.id, 40), what: text(x.what, 300), need: text(x.need, 40), type: text(x.type, 120), how: text(x.how, 60), range, min: MIN_RANGES[range] ? String(MIN_RANGES[range].min) : cleanMin(x.min), place: text(x.place, 120), notes: text(x.notes, 4000), referral: cleanReferral(x.referral) };
};

export function updateContact(db, id, patch = {}) {
  ensure(db);
  const k = findContact(db, id);
  if (k.status === 'closed') {
    const allowed = k.correction ? AFTER_CLOSE.concat(CORRECTABLE) : AFTER_CLOSE;
    const blocked = Object.keys(patch).filter((key) => allowed.indexOf(key) < 0);
    if (blocked.length) throw new BadRequest(k.correction ? 'Who the contact is can’t change in a correction.' : 'This contact is closed. Only case notes and action items can be added.');
    if (k.correction) Object.keys(patch).filter((key) => CORRECTABLE.indexOf(key) >= 0 && k.correction.changed.indexOf(key) < 0).forEach((key) => k.correction.changed.push(key));
  }
  const lines = describePatch(k, patch);
  SECTIONS.forEach((s) => { if (patch[s] && typeof patch[s] === 'object' && !Array.isArray(patch[s])) k[s] = { ...k[s], ...cleanSection(patch[s]) }; });
  LISTS.forEach((s) => {
    if (!Array.isArray(patch[s])) return;
    const list = patch[s].filter((x) => x && typeof x === 'object').slice(0, 100);
    k[s] = s === 'needs' ? list.map(cleanNeed) : s === 'interactions' ? list.map(cleanIx) : list;
  });
  // Links are added and removed one at a time, so two screens saving at once can't drop each other's.
  if (Array.isArray(patch.addLinks)) patch.addLinks.forEach((l) => { if (l && l.actionId && !k.links.some((x) => x.actionId === l.actionId)) k.links.push({ actionId: String(l.actionId), ixId: l.ixId ? String(l.ixId) : null, auto: null }); });
  if (Array.isArray(patch.removeLinks)) k.links = k.links.filter((l) => patch.removeLinks.indexOf(l.actionId) < 0 || l.auto);
  if (patch.dropIxLinks) k.links = k.links.filter((l) => l.ixId !== patch.dropIxLinks);
  // Contact info a coordinator updates for a known client is kept on their record, as an ASC-reported address.
  const recordChanged = patch.reach && k.clientId ? saveAscAddress(db, k) : null;
  if ('channel' in patch) k.channel = patch.channel === 'person' ? 'person' : 'phone';
  if ('site' in patch) k.site = String(patch.site || '');
  if ('path' in patch) k.path = patch.path === 'anon' || patch.path === 'client' ? patch.path : null;
  if ('candidateId' in patch) {
    const cand = patch.candidateId ? findClient(db, patch.candidateId) : null;
    if ((patch.candidateId || null) !== k.candidateId) lines.push({ key: 'candidate', text: cand ? 'Selected ' + cand.first + ' ' + cand.last + ' from MCI' : 'Cleared the MCI match' });
    k.candidateId = patch.candidateId || null;
  }
  if ('unverifiedName' in patch) k.unverifiedName = String(patch.unverifiedName || '');
  ['unverifiedFirst', 'unverifiedLast'].forEach((f) => { if (f in patch) k[f] = text(patch[f], 80); });
  if ('unverifiedFirst' in patch || 'unverifiedLast' in patch) k.unverifiedName = [k.unverifiedFirst, k.unverifiedLast].filter(Boolean).join(' ');
  // When consent is captured, and who gave it.
  if (patch.intake && 'consent' in patch.intake) k.intake.consentAt = k.intake.consent === 'Yes' ? new Date().toISOString() : '';
  if ('identity' in patch) {
    if (patch.identity !== 'unverified' && patch.identity !== null) throw new BadRequest('Link a client to set a matched identity.');
    if (k.clientId) throw new BadRequest('This contact is already on a client record.');
    k.identity = patch.identity;
    k.path = patch.identity === 'unverified' ? 'client' : k.path;
  }
  // The caller gave a reference number from an earlier contact.
  if ('priorRef' in patch) {
    const found = findByRef(db, patch.priorRef);
    if (!found) throw new BadRequest('No contact has the reference number ' + patch.priorRef + '.');
    k.group = found.group || found.id;
    if (!found.group) found.group = k.group;
    k.priorRefs = db.contacts.filter((x) => x.id !== k.id && x.group === k.group).map((x) => x.ref);
    if (found.clientId && !k.clientId) k.candidateId = found.clientId;
  }
  const moved = { notes: [], actions: [] };
  if ('linkedPrior' in patch) {
    if (patch.linkedPrior === 'linked') possibleLinks(db, k).forEach((x) => { x.clientId = k.clientId; x.identity = 'matched'; const m = moveToClient(db, x); moved.notes.push(...m.notes); moved.actions.push(...m.actions); });
    k.linkedPrior = patch.linkedPrior === 'linked' || patch.linkedPrior === 'no' ? patch.linkedPrior : null;
  }
  // Notes and action items belong to the client record once there is one.
  if (k.clientId && (k.notes.length || k.actions.length)) { const m = moveToClient(db, k); moved.notes.push(...m.notes); moved.actions.push(...m.actions); }
  const sync = syncFollowUps(db, k);
  appendLog(k, lines, db.userId, { correction: !!k.correction });
  const out = { contact: full(db, k), notes: moved.notes, actions: moved.actions.concat(sync.changed).map(clone), removeActions: sync.removed };
  if (recordChanged) out.client = fullRecord(recordChanged);
  return out;
}

function findByRef(db, text) {
  const d = String(text || '').replace(/\D/g, '');
  if (!d) return null;
  return db.contacts.find((x) => x.ref.replace(/\D/g, '').endsWith(d.padStart(6, '0')) || x.ref.replace(/\D/g, '') === d) || null;
}

// The reference-number lookup for a returning caller, before anything is attached to the contact.
export function lookupContact(db, ref) {
  ensure(db);
  const found = findByRef(db, ref);
  if (!found) throw new NotFound('Contact ' + ref);
  return contactSummary(db, found);
}

function moveToClient(db, k) {
  const moved = { notes: [], actions: [] };
  k.notes.forEach((n) => {
    const note = { id: n.id, clientId: k.clientId, date: n.date, edited: !!n.edited, restricted: !!n.restricted, tag: 'ASC', author: n.author || k.staff, text: n.text };
    db.notes.unshift(note); moved.notes.push(note);
  });
  k.actions.forEach((a) => {
    const act = { id: a.id, clientId: k.clientId, tag: 'ASC', text: a.text, assignee: a.assignee || k.staff, due: a.due || '', done: !!a.done, edited: !!a.edited };
    db.actions.unshift(act); moved.actions.push(act);
  });
  k.notes = []; k.actions = [];
  return moved;
}

// ------------------------------------------------------------------ contact info and demographics
// What's on file for a client, as intake shows it before the coordinator changes anything: the latest contact
// info ASC was given on an earlier contact, or else the address, phone and email on their record.
const ASC_SOURCE = { bucket: 'OBH', name: 'DCS - Administrative Service Coordination', code: 'ASC' };
const isAsc = (a) => (a.specificSources || []).some((x) => x.code === ASC_SOURCE.code) && /^asc-/.test(a.id);
const isoToday = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
function knownInfo(c, contactId) {
  const asc = (c.addresses || []).filter((a) => isAsc(a) && a.id !== 'asc-' + contactId && !a.end).sort((a, b) => (a.start < b.start ? 1 : -1))[0];
  const st = /\(([A-Z]{2})\)/.exec(asc ? asc.county : '');
  const reach = asc
    ? { street: asc.street === NO_STREET ? '' : asc.street, city: asc.city, state: st ? st[1] : 'PA', zip: asc.zip, phone: asc.phone ? asc.phone.number : '', email: asc.email || '' }
    : { street: (c.address && c.address.street) || '', city: (c.address && c.address.city) || '', state: (c.address && c.address.state) || (c.address && c.address.street ? 'PA' : ''), zip: (c.address && c.address.zip) || '', phone: c.phone || '', email: c.email || '' };
  const stamp = asc ? { source: 'ASC', asOf: asc.reports && asc.reports[0] ? asc.reports[0].date : asc.start } : (c.sources && c.sources.address) || { source: '', asOf: '' };
  const demo = {};
  DEMO_FIELDS.forEach(([key]) => { demo[key] = String(c[key] || ''); });
  return { reach, demo, source: stamp.source || '', asOf: stamp.asOf || '' };
}
const NO_STREET = 'No street address given';
// Saves the contact info from this contact on the client's record, as one address record reported to ASC (the
// program the info came from). Earlier ASC-reported records are ended: this one replaces them. Changing it back to
// what was on file removes it. Returns the client when their record changed.
function saveAscAddress(db, k) {
  const c = findClient(db, k.clientId);
  const id = 'asc-' + k.id;
  const known = knownInfo(c, k.id).reach;
  const eff = {};
  REACH_FIELDS.forEach(([key]) => { eff[key] = String(k.reach[key] != null ? k.reach[key] : known[key] || '').trim(); });
  const changed = REACH_FIELDS.some(([key]) => eff[key] !== String(known[key] || '').trim());
  const at = (c.addresses || []).findIndex((a) => a.id === id);
  if (!changed) { if (at < 0) return null; c.addresses.splice(at, 1); return c; }
  const today = isoToday();
  const state = (eff.state || 'PA').toUpperCase().slice(0, 2);
  const rec = {
    id, street: eff.street || NO_STREET, city: eff.city, township: '', county: state === 'PA' ? 'Allegheny' : 'Out of state (' + state + ')', zip: eff.zip,
    schoolDistrict: '', addressType: 'Reported', residential: !!eff.street, kind: 'home', useDescription: 'Given to ASC on ' + k.ref + (k.intake.caller && k.intake.caller !== 'The client' ? ', by the caller (' + k.intake.caller.toLowerCase() + ')' : ''),
    start: today, effDate: today, end: null, sources: [ASC_SOURCE.bucket], specificSources: [{ ...ASC_SOURCE }],
    reports: [{ agency: 'ASC – Allegheny County', date: today, method: k.channel === 'person' ? 'In person' : 'Phone call', county: 'Allegheny' }],
    certainty: k.intake.caller && k.intake.caller !== 'The client' ? 'low' : 'medium', conflict: '', email: eff.email,
    phone: eff.phone ? { number: eff.phone, type: 'Reported', validDate: today } : null, altPhones: [], providerLocation: '', facilityId: ''
  };
  if (!c.addresses) c.addresses = [];
  c.addresses.forEach((a) => { if (isAsc(a) && a.id !== id && !a.end) a.end = today; });
  if (at >= 0) c.addresses[at] = { ...rec, start: c.addresses[at].start, effDate: c.addresses[at].effDate }; else c.addresses.unshift(rec);
  return c;
}

const MCI = (db) => 'R' + String(1100000000 + db.clients.length * 7919 + db.contactSeq).slice(-10);

// Puts the contact on a client's record: an existing client (`clientId`) or one registered now (`newClient`).
// Enrolls the client in ASC, moves the contact's notes and action items over, and schedules follow-ups.
// Enrolls a client in ASC if they aren't already. Coming back after a discharge re-enrolls them.
function enroll(c) {
  const today = usOf(new Date());
  if (c.colabs.indexOf('ASC') < 0) c.colabs.push('ASC');
  if (c.ascDischarge) c.ascDischarge = null;
  if (!(c.enrollments || []).some((e) => e.name === ASC_ENROLLMENT && e.kind === 'active')) {
    c.enrollments = (c.enrollments || []).concat([{ name: ASC_ENROLLMENT, kind: 'active', status: 'Active', pct: 0, start: today, end: 'Ongoing', asOf: 'As of ' + today + ' | Today', stale: false }]);
  }
}

export function linkContact(db, id, body = {}) {
  ensure(db);
  const k = findContact(db, id);
  if (k.clientId) throw new BadRequest('This contact is already on a client record.');
  let c;
  let identity = 'matched';
  if (body.clientId) c = findClient(db, body.clientId);
  else if (body.newClient) {
    const f = body.newClient;
    if (!String(f.first || '').trim() || !String(f.last || '').trim() || !f.dob || !f.gender) throw new BadRequest('First name, last name, date of birth and gender are required.');
    const num = db.clients.length + 1;
    let cid = 'c' + num; while (db.clients.some((x) => x.id === cid)) cid += 'x';
    c = {
      id: cid, first: f.first.trim(), last: f.last.trim(), household: false, members: null, dob: f.dob, gender: f.gender, legalSex: f.gender,
      race: f.race || '', ethnicity: f.ethnicity || '', marital: f.marital || '', living: f.living || '', language: f.language || 'English',
      mci: MCI(db), ssn4: String(f.ssn || '').replace(/\D/g, '').slice(-4), ssnFull: '', dhs: '', dpw: '', phone: f.phone || '', email: f.email || '',
      address: { street: f.street || '', city: f.city || '', state: f.state || 'PA', zip: f.zip || '', school: '', ward: '', facility: null },
      colabs: [], starred: null, favorited: '', guardian: null, coverage: null, enrollments: [], services: [], instances: [], justice: null,
      sources: { address: { source: 'ASC', asOf: usOf(new Date()) }, phone: { source: 'ASC', asOf: usOf(new Date()) }, email: { source: '', asOf: '' } },
      addresses: f.street ? [{ id: 'addr0', street: f.street, city: f.city || '', township: '', county: f.county || 'Allegheny', zip: f.zip || '', schoolDistrict: '', addressType: 'Permanent', residential: true, kind: 'home', useDescription: 'Residence', start: new Date().toISOString().slice(0, 10), effDate: '', end: null, sources: ['Self'], specificSources: [{ bucket: 'Self', name: 'ASC intake', code: 'ASC' }], reports: [{ agency: 'ASC', date: usOf(new Date()), method: 'Phone', county: f.county || 'Allegheny' }], certainty: 'medium', conflict: '', email: f.email || '', phone: f.phone ? { number: f.phone, type: 'Reported', validDate: isoToday() } : null, altPhones: [], providerLocation: '', facilityId: '' }] : []
    };
    db.clients.push(c);
    identity = 'new';
  } else throw new BadRequest('Choose a client or register a new one.');

  enroll(c);
  Object.assign(k, { clientId: c.id, identity, path: 'client', candidateId: null, unverifiedName: '', identifiedIn: body.from === 'intake' ? 'intake' : 'identify' });
  // A referral's person who is now on a record and enrolled.
  if (k.purpose && k.purpose.referralId) {
    const r = (db.ascReferrals || []).find((x) => x.id === k.purpose.referralId);
    if (r) { r.clientId = c.id; r.status = 'enrolled'; r.log.push({ at: new Date().toISOString(), by: db.userId, text: 'Enrolled in ASC on ' + k.ref }); }
  }
  if (!k.intake.age) k.intake.age = ageGroupFor(c.dob);
  // Contact info typed before they were found goes on their record. A new client's record was just made from it.
  if (identity !== 'new' && REACH_FIELDS.some(([key]) => k.reach[key] != null)) saveAscAddress(db, k);
  // Earlier calls tied by the caller's reference number are theirs by definition.
  const earlier = { notes: [], actions: [] };
  if (k.group) db.contacts.forEach((x) => {
    if (x.id === k.id || x.group !== k.group || x.clientId) return;
    x.clientId = c.id; x.identity = 'matched';
    const m = moveToClient(db, x); earlier.notes.push(...m.notes); earlier.actions.push(...m.actions);
  });
  if (k.group) k.linkedPrior = 'linked';
  const moved = moveToClient(db, k);
  const sync = syncFollowUps(db, k);
  syncAscService(db, c);
  appendLog(k, [{ key: 'identity', text: (identity === 'new' ? 'Registered ' + c.first + ' ' + c.last + ' in MCI' : 'Matched ' + c.first + ' ' + c.last + ' in MCI') + ' and enrolled in ASC' }].concat(earlier.notes.length || earlier.actions.length || k.group ? [{ key: 'linkedPrior', text: 'Earlier contacts moved to their record' }] : []), db.userId);
  return { contact: full(db, k), client: fullRecord(c), notes: moved.notes.concat(earlier.notes), actions: moved.actions.concat(earlier.actions, sync.changed).map(clone), removeActions: sync.removed };
}

// ASC shows on the client's Services tab: one service row, with one instance per contact (its units and site).
const ASC_SERVICE = 'Administrative Service Coordination';
const ASC_PROVIDER = 'DHS ASC';
export function syncAscService(db, c) {
  if (!c || !(c.enrollments || []).some((e) => e.name === ASC_ENROLLMENT)) return;
  const mine = db.contacts.filter((x) => x.clientId === c.id).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const all = (c.enrollments || []).filter((e) => e.name === ASC_ENROLLMENT);
  const toKey = (us) => (us ? us.slice(6) + us.slice(0, 2) + us.slice(3, 5) : '');
  const first = all.map((e) => e.start).sort((a, b) => (toKey(a) < toKey(b) ? -1 : 1))[0] || (mine.length ? usOf(new Date(mine[0].startedAt)) : usOf(new Date()));
  const dates = mine.map((x) => usOf(new Date(x.startedAt))).concat(c.ascDischarge ? [usOf(new Date(c.ascDischarge.at))] : []);
  const last = dates.sort((a, b) => (toKey(a) < toKey(b) ? -1 : 1)).pop() || first;
  c.services = (c.services || []).filter((s) => s.id !== 'asc');
  c.services.unshift({ id: 'asc', service: ASC_SERVICE, area: 'Service Coordination', program: 'Service Coordination', first, last, added: first, all: [ASC_PROVIDER], grouped: [ASC_PROVIDER] });
  c.instances = (c.instances || []).filter((i) => i.service !== ASC_SERVICE).concat(mine.map((x) => {
    const t = totals(x.interactions);
    return { service: ASC_SERVICE, provider: ASC_PROVIDER, facility: x.channel === 'person' ? x.site || 'ASC site' : 'ASC call center', program: 'Service Coordination', dx: '—', units: String(t.units), rate: 'TBD', rateType: 'Per 15 min', cost: 'TBD', status: x.status === 'open' ? 'Active' : 'Pending', first: usOf(new Date(x.startedAt)), last: usOf(new Date(x.endedAt || x.startedAt)) };
  }));
}

export function closeContact(db, id, body = {}) {
  ensure(db);
  const k = findContact(db, id);
  if (k.status === 'closed') throw new BadRequest('This contact is already closed.');
  if (body.urgent) {
    const u = body.urgent;
    k.urgent = { dest: String(u.dest || ''), how: String(u.how || ''), need: String(u.need || ''), note: String(u.note || ''), at: new Date().toISOString() };
    k.needs = k.needs.map((n) => ({ ...n, outcome: n.name === u.need ? CRISIS : (n.outcome || OPEN) }));
    k.closedKind = 'urgent';
  } else {
    if (!k.needs.length) throw new BadRequest('Add at least one need before closing.');
    const open = k.needs.filter((n) => !n.outcome);
    if (open.length) throw new BadRequest('Give each need an outcome before closing: ' + open.map((n) => n.name).join(', ') + '.');
    k.closedKind = k.clientId ? 'client' : 'anon';
  }
  k.status = 'closed';
  k.endedAt = new Date().toISOString();
  appendLog(k, [{ key: 'close', text: k.closedKind === 'urgent' ? 'Closed as a transfer to ' + shown(k.urgent.dest) + ' (' + k.urgent.how.split(':')[0].toLowerCase() + ')' : 'Closed the contact' }], db.userId);
  // The automatic summary: a case note on the client's record, or on the contact while the person is anonymous.
  const notes = [addNote(db, k, summaryNote(k, staffLabel(db, k.staff)), k.staff)].filter(Boolean);
  k.summarized = true; // contacts closed before v4.0.2 have no summary note
  const reminder = remindOpenItems(db, k);
  if (k.clientId) syncAscService(db, findClient(db, k.clientId));
  // The call an action item asked for happened, so the item is done.
  const changed = reminder ? [clone(reminder)] : [];
  if (k.purpose && k.purpose.actionId) {
    const a = db.actions.find((x) => x.id === k.purpose.actionId);
    if (a && !CLOSED_STATUS.includes(a.status)) { a.status = 'done'; a.done = true; changed.push(clone(a)); appendLog(k, [{ key: 'purpose.done', text: 'Marked “' + a.text + '” done' }], db.userId); }
  }
  return { contact: full(db, k), notes, actions: changed };
}

// Action items still open from this conversation: ones added during it (or tied to its interactions), not the
// automatic 7-day and 90-day follow-ups. Anonymous contacts keep theirs on the contact.
export function openItemsFrom(db, k) {
  if (!k.clientId) return k.actions.filter((a) => !a.done && a.id !== k.reminderId);
  const autos = k.links.filter((l) => l.auto).map((l) => l.actionId);
  const linked = k.links.filter((l) => !l.auto).map((l) => l.actionId);
  // Reminders from any contact are about other items, never items of their own.
  const reminders = new Set(db.contacts.map((x) => x.reminderId).filter(Boolean));
  return db.actions.filter((a) => a.clientId === k.clientId && !a.done && !reminders.has(a.id) && autos.indexOf(a.id) < 0 &&
    (linked.indexOf(a.id) >= 0 || (a.tag === 'ASC' && a.createdAt && a.createdAt >= k.startedAt)));
}

// When a conversation ends with open action items, the coordinator gets a reminder to check on them in three
// business days. One per contact.
function remindOpenItems(db, k) {
  if (k.reminderId) return null;
  const open = openItemsFrom(db, k);
  if (!open.length) return null;
  const c = k.clientId ? findClient(db, k.clientId) : null;
  const a = { id: newId('a'), tag: 'ASC', text: 'Check on ' + plural(open.length, 'open action item', 'open action items') + ' from ' + k.ref + (c ? ' with ' + c.first : ''), assignee: k.staff, due: addBusinessDays(dayOf(k.endedAt), 3), done: false, edited: false, createdAt: new Date().toISOString() };
  if (c) { a.clientId = c.id; db.actions.unshift(a); } else k.actions.unshift(a);
  k.reminderId = a.id;
  appendLog(k, [{ key: 'reminder', text: 'Reminder set for ' + addBusinessDays(dayOf(k.endedAt), 3).replace(/(\d+)-(\d+)-(\d+)/, '$2/$3/$1') + ': ' + a.text }], k.staff);
  return c ? a : null;
}

// A case note from the system: on the client's record, or on the contact while the person is anonymous.
function addNote(db, k, text, author) {
  if (k.clientId) return createNote(db, k.clientId, { tag: 'ASC', author, text });
  k.notes.unshift({ id: newId('kn'), text, restricted: false, date: usOf(new Date()), author, edited: false });
  return null;
}

// Supervisors correct closed contacts. Opening a correction needs a reason; every change is saved as it's made,
// and finishing records who changed what and why, as a case note and on the contact.
export function startCorrection(db, id, body = {}) {
  ensure(db);
  const k = findContact(db, id);
  if (!isSupervisor(db)) throw new Forbidden('Only an ASC supervisor can edit a closed contact.');
  if (k.status !== 'closed') throw new BadRequest('This contact is still open. Edit it directly.');
  if (k.correction) throw new BadRequest('This contact is already being corrected by ' + staffLabel(db, k.correction.by) + '.');
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (!reason) throw new BadRequest('Give a reason for the correction.');
  k.correction = { by: db.userId, at: new Date().toISOString(), reason, changed: [] };
  appendLog(k, [{ key: 'correction.start', text: 'Correction started: “' + reason + '”' }], db.userId, { correction: true });
  return { contact: full(db, k), notes: [] };
}

const FIELD_NAMES = { intake: 'intake', screening: 'screening', needs: 'needs and outcomes', interactions: 'interactions', followUp: 'follow-up', onsite: 'on-site steps', anon: 'anonymous details', site: 'site', channel: 'contact type', dropIxLinks: 'interactions' };
export function finishCorrection(db, id) {
  ensure(db);
  const k = findContact(db, id);
  if (!k.correction) throw new BadRequest('This contact isn’t being corrected.');
  if (!isSupervisor(db)) throw new Forbidden('Only an ASC supervisor can edit a closed contact.');
  if (!k.needs.length) throw new BadRequest('Add at least one need before saving.');
  const open = k.needs.filter((n) => !n.outcome);
  if (open.length) throw new BadRequest('Give each need an outcome before saving: ' + open.map((n) => n.name).join(', ') + '.');
  const c = k.correction;
  const changed = [...new Set(c.changed.map((f) => FIELD_NAMES[f] || f))];
  const entry = { by: c.by, at: new Date().toISOString(), reason: c.reason, changed };
  k.corrections.push(entry);
  k.correction = null;
  appendLog(k, [{ key: 'correction.end', text: 'Correction saved' + (changed.length ? ': ' + changed.join(', ') : '') }], entry.by, { correction: true });
  const text = 'ASC correction to ' + k.ref + ', ' + usOf(new Date(entry.at)) + ', ' + staffLabel(db, entry.by) + '.\nReason: ' + entry.reason + '\nChanged: ' + (changed.length ? changed.join(', ') : 'nothing') + '.\n\n' + summaryNote(k, staffLabel(db, k.staff));
  const notes = [addNote(db, k, text, entry.by)].filter(Boolean);
  return { contact: full(db, k), notes };
}

// Prototype only: switch between a coordinator and a supervisor to try both roles.
export const DEMO_USERS = ['u1', 'u4'];
export function switchUser(db, body = {}) {
  ensure(db);
  if (DEMO_USERS.indexOf(body.userId) < 0) throw new BadRequest('Unknown user.');
  db.userId = body.userId;
  return { ok: true };
}

// Everything a coordinator needs when a person comes back: what is still open, then each past contact.
export function contactHistory(db, q = {}) {
  ensure(db);
  let related = [];
  let current = null;
  if (q.contactId) current = findContact(db, q.contactId);
  const clientId = q.clientId || (current && current.clientId);
  const group = current && current.group;
  related = db.contacts.filter((x) => (!current || x.id !== current.id) && (
    (clientId && (x.clientId === clientId || x.possibleClientId === clientId)) || (group && x.group === group)
  ));
  related.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const staffName = (sid) => { const s = db.staff.find((x) => x.id === sid); return s ? s.first + ' ' + s.last : sid; };
  const open = [];
  const seenNeeds = new Set();
  // Each open item says where it came from, so a screen can act on it: add the need to this contact, mark an
  // action item done, or open the contact it came from.
  const due = (a) => (a.due ? a.due.slice(5, 7) + '/' + a.due.slice(8, 10) + '/' + a.due.slice(0, 4) : 'no date');
  related.forEach((x) => x.needs.forEach((n) => {
    if (seenNeeds.has(n.name)) return;
    seenNeeds.add(n.name);
    if (n.outcome === OPEN && !n.resolvedAt && x.status === 'closed') open.push({ kind: 'Open need', text: n.name, need: n.name, needId: n.id, urg: n.urg, contactId: x.id, ref: x.ref, meta: n.urg + ' · open since ' + usOf(new Date(x.startedAt)) + ' · ' + staffName(x.staff) + ' · ' + x.ref });
  }));
  related.forEach((x) => x.actions.filter((a) => !a.done).forEach((a) => open.push({ kind: 'Action item', text: a.text, contactId: x.id, ref: x.ref, actionId: a.id, meta: staffName(a.assignee) + ' · due ' + due(a) + ' · from ' + x.ref })));
  const tries = (a) => (a.attempts && a.attempts.length ? ' · ' + plural(a.attempts.length, 'call attempt', 'call attempts') : '');
  if (clientId) db.actions.filter((a) => a.clientId === clientId && a.tag === 'ASC' && !a.done).forEach((a) => open.push({ kind: 'Action item', text: a.text, actionId: a.id, clientId, status: a.status || 'open', meta: staffName(a.assignee) + ' · due ' + due(a) + tries(a) }));
  return {
    openItems: open,
    contacts: related.map((x) => ({
      ...contactSummary(db, x), staffName: staffName(x.staff), possible: !x.clientId && !!clientId,
      interactions: x.interactions, notes: ((own) => own.concat(x.intake.story && !own.length ? [x.intake.story] : []))(x.notes.map((n) => n.text).filter((t) => !isSummaryNote(t))),
      screening: SCREENING.filter((s) => x.screening[s.key]).map((s) => s.label + ': ' + x.screening[s.key]),
      minutes: x.endedAt ? Math.round((new Date(x.endedAt) - new Date(x.startedAt)) / 60000) : 0,
      // The full record, for the opt-in view of everything the coordinator filled in, and the step-by-step log.
      record: { id: x.id, ref: x.ref, channel: x.channel, direction: x.direction, purpose: x.purpose, site: x.site, startedAt: x.startedAt, endedAt: x.endedAt, status: x.status, closedKind: x.closedKind, staff: x.staff, identity: x.identity, unverifiedName: x.unverifiedName, path: x.path, anon: x.anon, intake: x.intake, screening: x.screening, needs: x.needs, interactions: x.interactions, followUp: x.followUp, onsite: x.onsite, urgent: x.urgent, corrections: x.corrections, log: x.log, clientId: x.clientId },
      totalsText: plural(x.interactions.length, 'interaction', 'interactions')
    }))
  };
}

// ================================================================== supervisor tools
const requireSupervisor = (db) => { if (!isSupervisor(db)) throw new Forbidden('Only an ASC supervisor can do this.'); };
const ascStaff = (db) => (db.staff || []).filter((s) => s.role === 'ASC Coordinator' || s.role === SUPERVISOR);
const activeEnrollment = (c) => (c.enrollments || []).find((e) => e.name === ASC_ENROLLMENT && e.kind === 'active');
const isoDay = (iso) => (iso ? iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4) : '');

// ------------------------------------------------------------------ reassignment
// Everyone's open ASC work: contacts in progress and open ASC action items (on client records and on anonymous
// contacts), so a supervisor can move it when someone is out or leaves.
export function teamWork(db) {
  ensure(db); requireSupervisor(db);
  const name = (id) => { const c = db.clients.find((x) => x.id === id); return c ? clientName(c) : ''; };
  return {
    staff: ascStaff(db).map((s) => {
      const contacts = db.contacts.filter((k) => k.staff === s.id && k.status === 'open').map((k) => contactSummary(db, k));
      const actions = db.actions.filter((a) => a.assignee === s.id && a.tag === 'ASC' && !a.done).map((a) => ({ id: a.id, text: a.text, due: a.due, clientId: a.clientId, where: name(a.clientId) }))
        .concat(...db.contacts.map((k) => k.actions.filter((a) => a.assignee === s.id && !a.done).map((a) => ({ id: a.id, text: a.text, due: a.due, clientId: '', contactId: k.id, where: k.ref }))));
      actions.sort((a, b) => ((a.due || '9') < (b.due || '9') ? -1 : 1));
      return { id: s.id, name: s.first + ' ' + s.last, role: s.role, contacts, actions };
    })
  };
}

export function reassign(db, body = {}) {
  ensure(db); requireSupervisor(db);
  const to = ascStaff(db).find((s) => s.id === body.to);
  if (!to) throw new BadRequest('Choose who to reassign to.');
  const contactIds = Array.isArray(body.contactIds) ? body.contactIds : [];
  const actionIds = Array.isArray(body.actionIds) ? body.actionIds : [];
  if (!contactIds.length && !actionIds.length) throw new BadRequest('Choose at least one contact or action item.');
  const contacts = [], actions = [];
  contactIds.forEach((id) => {
    const k = findContact(db, id);
    if (k.staff === to.id) return;
    const from = staffLabel(db, k.staff);
    k.staff = to.id;
    appendLog(k, [{ key: 'reassign', text: 'Reassigned from ' + from + ' to ' + to.first + ' ' + to.last }], db.userId);
    contacts.push(full(db, k));
  });
  actionIds.forEach((id) => {
    const a = db.actions.find((x) => x.id === id);
    if (a) { a.assignee = to.id; actions.push(clone(a)); return; }
    const k = db.contacts.find((x) => x.actions.some((y) => y.id === id));
    if (!k) throw new NotFound('Action item');
    k.actions.find((y) => y.id === id).assignee = to.id;
    if (!contacts.some((c) => c.id === k.id)) contacts.push(full(db, k));
  });
  return { contacts, actions, moved: contacts.length + actions.length };
}

// ------------------------------------------------------------------ close-out requests and discharge
function closeoutView(db, r) {
  const c = findClient(db, r.clientId);
  const contacts = db.contacts.filter((k) => k.clientId === c.id);
  const openNeeds = [...new Set(contacts.flatMap((k) => k.needs.filter((n) => n.outcome === OPEN).map((n) => n.name)))];
  return {
    ...r, client: summary(c), byName: staffLabel(db, r.by), decidedByName: r.decidedBy ? staffLabel(db, r.decidedBy) : '',
    openContacts: contacts.filter((k) => k.status === 'open').length,
    openActions: db.actions.filter((a) => a.clientId === c.id && a.tag === 'ASC' && !a.done).length,
    openNeeds, lastContact: contacts.length ? contacts.map((k) => k.startedAt).sort().pop() : ''
  };
}

export function listCloseouts(db) {
  ensure(db);
  return (db.closeouts || []).slice().sort((a, b) => (a.at < b.at ? 1 : -1)).map((r) => closeoutView(db, r));
}

// A coordinator asks for a client to be closed out; it waits in the supervisor's queue.
export function requestCloseout(db, clientId, body = {}) {
  ensure(db);
  const c = findClient(db, clientId);
  if (!activeEnrollment(c)) throw new BadRequest(c.first + ' isn’t enrolled in ASC.');
  if ((db.closeouts || []).some((r) => r.clientId === c.id && r.status === 'pending')) throw new BadRequest('A close-out is already waiting for a supervisor.');
  const reason = DISCHARGE_REASONS_SET.has(body.reason) ? body.reason : '';
  if (!reason) throw new BadRequest('Choose a reason.');
  const r = { id: newId('co'), clientId: c.id, by: db.userId, at: new Date().toISOString(), reason, note: text(body.note, 2000), status: 'pending', decidedBy: '', decidedAt: '', decisionNote: '' };
  db.closeouts = (db.closeouts || []).concat([r]);
  return closeoutView(db, r);
}

export function cancelCloseout(db, id) {
  ensure(db);
  const r = (db.closeouts || []).find((x) => x.id === id);
  if (!r) throw new NotFound('Close-out request');
  if (r.status !== 'pending') throw new BadRequest('This request has already been decided.');
  if (r.by !== db.userId && !isSupervisor(db)) throw new Forbidden('Only the person who asked, or a supervisor, can withdraw it.');
  r.status = 'withdrawn'; r.decidedBy = db.userId; r.decidedAt = new Date().toISOString();
  return closeoutView(db, r);
}

export function decideCloseout(db, id, body = {}) {
  ensure(db); requireSupervisor(db);
  const r = (db.closeouts || []).find((x) => x.id === id);
  if (!r) throw new NotFound('Close-out request');
  if (r.status !== 'pending') throw new BadRequest('This request has already been decided.');
  if (body.decision === 'decline') {
    const note = text(body.note, 2000).trim();
    if (!note) throw new BadRequest('Say why, so the coordinator knows what to do next.');
    Object.assign(r, { status: 'declined', decidedBy: db.userId, decidedAt: new Date().toISOString(), decisionNote: note });
    return { closeout: closeoutView(db, r), client: fullRecord(findClient(db, r.clientId)), removeActions: [] };
  }
  if (body.decision !== 'discharge') throw new BadRequest('Choose discharge or decline.');
  const out = dischargeClient(db, r.clientId, { reason: r.reason, note: body.note || r.note });
  return { ...out, closeout: closeoutView(db, (db.closeouts || []).find((x) => x.id === id)) };
}

// Ends ASC enrollment. Scheduled 7-day and 90-day follow-ups that haven't happened are removed; other action items
// stay. Any pending close-out request for the client is marked discharged. They're re-enrolled if they come back.
export function dischargeClient(db, clientId, body = {}) {
  ensure(db); requireSupervisor(db);
  const c = findClient(db, clientId);
  const e = activeEnrollment(c);
  if (!e) throw new BadRequest(c.first + ' isn’t enrolled in ASC.');
  if (db.contacts.some((k) => k.clientId === c.id && k.status === 'open')) throw new BadRequest('Close the contact in progress before discharging.');
  const reason = DISCHARGE_REASONS_SET.has(body.reason) ? body.reason : '';
  if (!reason) throw new BadRequest('Choose a reason.');
  const now = new Date();
  const today = usOf(now);
  Object.assign(e, { kind: 'inactive', status: 'Discharged', end: today, pct: 100, asOf: 'Discharged ' + today + ': ' + reason });
  c.colabs = c.colabs.filter((x) => x !== 'ASC');
  c.ascDischarge = { by: db.userId, at: now.toISOString(), reason, note: text(body.note, 2000) };
  const removed = [];
  db.contacts.filter((k) => k.clientId === c.id).forEach((k) => {
    k.links.filter((l) => l.auto).forEach((l) => {
      const i = db.actions.findIndex((a) => a.id === l.actionId && !a.done);
      if (i >= 0) { db.actions.splice(i, 1); removed.push(l.actionId); }
    });
    k.links = k.links.filter((l) => !l.auto || removed.indexOf(l.actionId) < 0);
  });
  (db.closeouts || []).filter((r) => r.clientId === c.id && r.status === 'pending').forEach((r) => Object.assign(r, { status: 'discharged', decidedBy: db.userId, decidedAt: now.toISOString(), decisionNote: text(body.note, 2000) }));
  createNote(db, c.id, { tag: 'ASC', author: db.userId, text: 'Discharged from ASC, ' + today + ', ' + staffLabel(db, db.userId) + '.\nReason: ' + reason + (body.note ? '\n' + text(body.note, 2000) : '') + (removed.length ? '\nRemoved ' + plural(removed.length, 'scheduled follow-up', 'scheduled follow-ups') + '.' : '') });
  syncAscService(db, c);
  return { client: fullRecord(c), removeActions: removed, notes: db.notes.filter((n) => n.clientId === c.id).slice(0, 1) };
}

// ------------------------------------------------------------------ state reporting
// One month of ASC services for the state: every interaction on a closed contact with a client verified in MCI,
// with anything that would stop it being accepted. Open, anonymous and name-only contacts are counted, not sent.
export function stateReport(db, period) {
  ensure(db); requireSupervisor(db);
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw new BadRequest('Choose a month.');
  const inMonth = db.contacts.filter((k) => dayOf(k.startedAt).slice(0, 7) === period);
  const sent = inMonth.filter((k) => k.status === 'closed' && k.clientId && k.identity !== 'unverified');
  const rows = [];
  sent.forEach((k) => {
    const c = findClient(db, k.clientId);
    const clientProblems = [];
    if (!c.dob) clientProblems.push('Date of birth missing');
    if (!c.gender) clientProblems.push('Gender missing');
    if (!k.interactions.length) rows.push({ id: k.id + '-none', contactId: k.id, ref: k.ref, clientId: c.id, clientName: clientName(c), mci: c.mci, code: '', date: isoDay(dayOf(k.startedAt)), units: 0, place: '', coordinator: staffLabel(db, k.staff), problems: ['No interactions documented'].concat(clientProblems) });
    k.interactions.forEach((x) => {
      const problems = clientProblems.slice();
      const units = unitsFor(x.min);
      if (!units) problems.push('Minutes missing');
      if (!x.place) problems.push('Place of service missing');
      const code = /T1016\w+/.exec(x.type || '');
      if (!code) problems.push('Service code not set for “' + shown(x.type) + '”');
      rows.push({ id: k.id + '-' + x.id, contactId: k.id, ref: k.ref, clientId: c.id, clientName: clientName(c), mci: c.mci, code: code ? code[0] : '', date: isoDay(dayOf(k.startedAt)), units, place: shown(x.place), coordinator: staffLabel(db, k.staff), problems });
    });
  });
  const saved = (db.ascReports || {})[period] || null;
  const changed = saved ? sent.filter((k) => (k.corrections || []).some((x) => x.at > saved.at)).map((k) => k.ref) : [];
  return {
    period, rows,
    totals: { contacts: sent.length, clients: new Set(sent.map((k) => k.clientId)).size, rows: rows.length, units: rows.reduce((s, r) => s + r.units, 0), problems: rows.filter((r) => r.problems.length).length },
    notSent: { open: inMonth.filter((k) => k.status === 'open').length, anonymous: inMonth.filter((k) => k.status === 'closed' && !k.clientId && k.identity !== 'unverified').length, unverified: inMonth.filter((k) => k.identity === 'unverified').length },
    submission: saved ? { ...saved, byName: staffLabel(db, saved.by), changedSince: changed } : null
  };
}

export function submitReport(db, period) {
  const r = stateReport(db, period);
  if (!r.rows.length) throw new BadRequest('There’s nothing to send for this month.');
  if (r.totals.problems) throw new BadRequest('Fix ' + plural(r.totals.problems, 'row', 'rows') + ' with problems before submitting.');
  const prev = (db.ascReports || {})[period];
  db.ascReports = { ...(db.ascReports || {}), [period]: { by: db.userId, at: new Date().toISOString(), rows: r.totals.rows, units: r.totals.units, contacts: r.totals.contacts, version: prev ? prev.version + 1 : 1 } };
  return stateReport(db, period);
}

// ================================================================== outreach: referrals, call attempts, next up
const DAY = 86400000;
const isoAgo = (days, hour = 10) => { const d = new Date(Date.now() - days * DAY); d.setHours(hour, 15, 0, 0); return d.toISOString(); };
const findReferral = (db, id) => { const r = (db.ascReferrals || []).find((x) => x.id === id); if (!r) throw new NotFound('Referral'); return r; };
const attemptOf = (db, body) => {
  const result = String(body.result || '');
  if (ATTEMPT_RESULTS.indexOf(result) < 0) throw new BadRequest('Choose what happened on the call.');
  return { id: newId('t'), at: new Date().toISOString(), by: db.userId, result, note: String(body.note || '').trim().slice(0, 1000) };
};

// Referrals from other programs. In production these arrive from each program's system; here a few are seeded,
// all fictional, and "Simulate a referral" adds one.
const SAMPLE_REFERRALS = [
  { source: 'CYF', clientId: 'c9', days: 1, status: 'new', assignee: '', referrer: { name: 'Jordan Price', role: 'CYF caseworker, East Region office', phone: '412-555-0190' },
    reason: 'Open CYF case. Caseworker wants her connected to outpatient mental health and a parenting group.', needs: ['Mental health, adult'] },
  { source: 'CYF', clientId: 'c29', days: 3, status: 'new', assignee: 'u1', referrer: { name: 'Renee Castillo', role: 'CYF caseworker, Central Region office', phone: '412-555-0174' },
    reason: 'Drug and alcohol assessment is part of the family service plan.', needs: ['Substance use treatment'], attempts: [[2, 'No answer', '']] },
  { source: 'HMIS', clientId: 'c32', days: 2, status: 'new', assignee: 'u1', referrer: { name: 'Pat Okafor', role: 'Shelter case manager, Smithfield Street shelter', phone: '412-555-0133' },
    reason: 'Staying at the shelter. Asked for help finding a psychiatrist and renewing Medical Assistance.', needs: ['Mental health, adult', 'Health coverage (MA or HealthChoices)'], attempts: [[2, 'Left a voicemail', 'Left the ASC number.'], [1, 'No answer', '']] },
  { source: 'HMIS', person: { first: 'Dana', last: 'Kirby', dob: '1988-06-12', phone: '412-555-0142', zip: '15222' }, days: 0, status: 'new', assignee: '', referrer: { name: 'Sam Reyes', role: 'Street outreach, Operation Safety Net', phone: '412-555-0108' },
    reason: 'Met by street outreach downtown. Interested in detox and a bed.', needs: ['Substance use treatment', 'Housing'] },
  { source: 'JAIL', clientId: 'c17', days: 5, status: 'contacted', assignee: 'u2', referrer: { name: 'Kim Albright', role: 'Reentry specialist, Allegheny County Jail', phone: '412-555-0121' },
    reason: 'Released next week. Needs his MAT continued and outpatient drug and alcohol treatment.', needs: ['Substance use treatment'] },
  { source: 'HOSP', person: { first: 'Luis', last: 'Ortega', dob: '1979-02-03', phone: '412-555-0166', zip: '15210' }, days: 6, status: 'unreachable', assignee: 'u1', referrer: { name: 'Erin Walsh', role: 'Discharge planner, inpatient psychiatry', phone: '412-555-0157' },
    reason: 'Discharged from inpatient psychiatry. Needs an outpatient appointment within 7 days.', needs: ['Mental health, adult'], attempts: [[5, 'No answer', ''], [4, 'Left a voicemail', ''], [3, 'Number disconnected', 'Number from the hospital no longer works.']] },
  { source: 'CYF', clientId: 'c24', days: 9, status: 'declined', assignee: 'u6', referrer: { name: 'Jordan Price', role: 'CYF caseworker, East Region office', phone: '412-555-0190' },
    reason: 'Father asked for help with housing and a mental health evaluation.', needs: ['Housing'], note: 'Already working with a case manager at Mercy. Doesn’t want a second one.' }
];
function referralFrom(db, x, i) {
  const c = x.clientId ? db.clients.find((y) => y.id === x.clientId) : null;
  const iso = (us) => (us ? us.slice(6) + '-' + us.slice(0, 2) + '-' + us.slice(3, 5) : '');
  const person = c ? { first: c.first, last: c.last, dob: iso(c.dob), phone: c.phone || '', zip: (c.address && c.address.zip) || '' } : x.person;
  const at = isoAgo(x.days, 9);
  return {
    id: 'rf' + (i + 1), source: x.source, receivedAt: at, status: x.status, assignee: x.assignee, referrer: x.referrer, reason: x.reason, needs: x.needs || [],
    clientId: c ? c.id : '', person, statusNote: x.note || '', contactIds: [],
    attempts: (x.attempts || []).map(([d, result, note], j) => ({ id: 'rf' + (i + 1) + 't' + j, at: isoAgo(d, 14), by: x.assignee || 'u1', result, note })),
    log: [{ at, by: '', text: 'Received from ' + REFERRAL_SOURCES[x.source] }]
  };
}
function seedReferrals(db) { db.ascReferrals = SAMPLE_REFERRALS.filter((x) => !x.clientId || db.clients.some((c) => c.id === x.clientId)).map((x, i) => referralFrom(db, x, i)); }

const referralView = (db, r) => ({ ...clone(r), assigneeName: r.assignee ? staffLabel(db, r.assignee) : '', enrolled: !!(r.clientId && db.clients.some((c) => c.id === r.clientId && c.colabs.indexOf('ASC') >= 0)) });
export function listAscReferrals(db) {
  ensure(db);
  return db.ascReferrals.slice().sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).map((r) => referralView(db, r));
}
export function updateAscReferral(db, id, body = {}) {
  ensure(db);
  const r = findReferral(db, id);
  const now = new Date().toISOString();
  if ('status' in body) {
    if (!REFERRAL_STATUS[body.status]) throw new BadRequest('Unknown referral status.');
    if (body.status !== r.status) r.log.push({ at: now, by: db.userId, text: 'Marked ' + REFERRAL_STATUS[body.status] + (body.statusNote ? ': ' + String(body.statusNote).trim() : '') });
    r.status = body.status;
  }
  if ('statusNote' in body) r.statusNote = String(body.statusNote || '').trim().slice(0, 1000);
  if ('assignee' in body) {
    if (body.assignee && !(db.staff || []).some((s) => s.id === body.assignee)) throw new BadRequest('Unknown coordinator.');
    if ((body.assignee || '') !== r.assignee) r.log.push({ at: now, by: db.userId, text: body.assignee ? 'Assigned to ' + staffLabel(db, body.assignee) : 'Unassigned' });
    r.assignee = body.assignee || '';
  }
  return referralView(db, r);
}
// Prototype only: one more referral arrives, as the import from another program would deliver it.
const SIMULATED = [
  { source: 'HMIS', person: { first: 'Terrell', last: 'Banks', dob: '1994-09-30', phone: '412-555-0118', zip: '15212' }, referrer: { name: 'Pat Okafor', role: 'Shelter case manager, Smithfield Street shelter', phone: '412-555-0133' }, reason: 'New to the shelter. Asked about counseling and getting his ID replaced.', needs: ['Mental health, adult'] },
  { source: 'CYF', clientId: 'c11', referrer: { name: 'Renee Castillo', role: 'CYF caseworker, Central Region office', phone: '412-555-0174' }, reason: 'Grandmother raising two grandchildren. Needs a mental health evaluation for the older one.', needs: ['Mental health services for a child'] },
  { source: 'HOSP', person: { first: 'Grace', last: 'Liu', dob: '1961-11-02', phone: '412-555-0199', zip: '15217' }, referrer: { name: 'Erin Walsh', role: 'Discharge planner, inpatient psychiatry', phone: '412-555-0157' }, reason: 'Going home tomorrow. Needs an outpatient psychiatrist and help with a ride to the first visit.', needs: ['Mental health, adult', 'Rides to care (MATP)'] }
];
export function simulateAscReferral(db) {
  ensure(db);
  const n = db.ascReferrals.length;
  const x = SIMULATED[n % SIMULATED.length];
  const r = referralFrom(db, { ...x, days: 0, status: 'new', assignee: '' }, n);
  r.receivedAt = new Date().toISOString(); r.log[0].at = r.receivedAt;
  while (db.ascReferrals.some((y) => y.id === r.id)) r.id += 'x';
  db.ascReferrals.unshift(r);
  return referralView(db, r);
}

// A call that didn't become a conversation: logged on the action item or referral it was for. Starting a contact
// is for when they pick up.
export function addAttempt(db, body = {}) {
  ensure(db);
  const t = attemptOf(db, body);
  if (body.referralId) {
    const r = findReferral(db, body.referralId);
    r.attempts.push(t);
    r.log.push({ at: t.at, by: db.userId, text: 'Call attempt: ' + t.result.toLowerCase() + (t.note ? '. ' + t.note : '') });
    return { referral: referralView(db, r), action: null };
  }
  // A call about nothing on file yet (a check-in from the client's record): the attempt becomes an action item, so
  // the call to try again shows in Next Up.
  if (!body.actionId && body.clientId) {
    const c = findClient(db, body.clientId);
    const a = { id: newId('a'), clientId: c.id, tag: 'ASC', text: String(body.text || 'Check-in call').slice(0, 300) + ' with ' + c.first, assignee: db.userId, due: isoToday(), done: false, edited: false, createdAt: new Date().toISOString(), status: 'progress', attempts: [t] };
    db.actions.unshift(a);
    return { referral: null, action: clone(a) };
  }
  const a = db.actions.find((x) => x.id === body.actionId);
  if (!a) {
    const k = (db.contacts || []).find((x) => x.actions.some((y) => y.id === body.actionId));
    if (!k) throw new NotFound('Action item');
    const own = k.actions.find((y) => y.id === body.actionId); upgradeAction(own); own.attempts.push(t);
    appendLog(k, [{ key: 'attempt', text: 'Call attempt for “' + own.text + '”: ' + t.result.toLowerCase() }], db.userId);
    return { referral: null, action: null, contact: full(db, k) };
  }
  upgradeAction(a);
  a.attempts.push(t);
  if (a.status === 'open') a.status = 'progress';
  return { referral: null, action: clone(a) };
}

// A need left "Still open" when its contact closed, resolved later: from the client's ASC tab or the next contact.
// The contact keeps the outcome it closed with; the resolution is recorded beside it.
export function resolveNeed(db, contactId, body = {}) {
  ensure(db);
  const k = findContact(db, contactId);
  const n = k.needs.find((x) => x.id === body.needId || x.name === body.need);
  if (!n) throw new NotFound('Need');
  if (k.status !== 'closed') throw new BadRequest('This contact is still open. Set the outcome in Wrap Up.');
  const outcome = String(body.outcome || '');
  if (!outcome || outcome === OPEN) throw new BadRequest('Choose how the need was resolved.');
  Object.assign(n, { resolvedAt: new Date().toISOString(), resolvedBy: db.userId, resolution: outcome, resolutionNote: String(body.note || '').trim().slice(0, 1000) });
  appendLog(k, [{ key: 'need.' + n.id + '.resolved', text: 'Need resolved later: ' + n.name + ', ' + outcome.toLowerCase() + (n.resolutionNote ? '. ' + n.resolutionNote : '') }], db.userId);
  return { contact: full(db, k), notes: [], actions: [] };
}

// What to do next, for one coordinator, most pressing first:
// 1 urgent or crisis needs still open, 2 overdue items, 3 items due today, 4 new referrals, 5 everything else by
// due date. Within a group, items with more failed call attempts come later, so one person who can't be reached
// doesn't hold up the rest.
export function nextUp(db, q = {}) {
  ensure(db);
  const who = q.staff || db.userId;
  const today = isoToday();
  const name = (c) => (c ? c.first + ' ' + c.last : '');
  const phoneOf = (c) => (c ? c.phone || '' : '');
  const items = [];
  const latest = {};
  db.contacts.filter((k) => k.clientId && k.status === 'closed').sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).forEach((k) => k.needs.forEach((n) => {
    const key = k.clientId + '|' + n.name;
    if (key in latest) return;
    latest[key] = true;
    if (n.outcome !== OPEN || n.resolvedAt || (n.urg !== 'Urgent' && n.urg !== 'Crisis') || k.staff !== who) return;
    const c = db.clients.find((x) => x.id === k.clientId);
    items.push({ key: 'n-' + k.id + '-' + n.id, kind: 'need', rank: 1, why: n.urg + ' need still open since ' + usOf(new Date(k.startedAt)), text: n.name, due: '', attempts: 0, lastAttempt: '', clientId: k.clientId, clientName: name(c), phone: phoneOf(c), contactId: k.id, needId: n.id, actionId: '', referralId: '', status: '' });
  }));
  const actionItem = (a, c, contactId) => {
    const days = a.due ? Math.round((new Date(today) - new Date(a.due)) / DAY) : null;
    const rank = days == null ? 5 : days > 0 ? 2 : days === 0 ? 3 : 5;
    const why = days == null ? 'No due date' : days > 0 ? 'Overdue ' + plural(days, 'day', 'days') : days === 0 ? 'Due today' : 'Due ' + weekday(a.due) + ' ' + a.due.slice(5, 7) + '/' + a.due.slice(8, 10);
    const tries = a.attempts || [];
    items.push({ key: 'a-' + a.id, kind: 'action', rank, why, text: a.text, due: a.due, attempts: tries.length, lastAttempt: tries.length ? tries[tries.length - 1].result + ', ' + usOf(new Date(tries[tries.length - 1].at)) : '', clientId: c ? c.id : '', clientName: name(c), phone: phoneOf(c), contactId: contactId || '', needId: '', actionId: a.id, referralId: '', status: a.status || 'open' });
  };
  db.actions.filter((a) => a.tag === 'ASC' && a.assignee === who && !a.done).forEach((a) => actionItem(a, db.clients.find((c) => c.id === a.clientId), ''));
  db.contacts.filter((k) => !k.clientId).forEach((k) => k.actions.filter((a) => !a.done && a.assignee === who).forEach((a) => actionItem(a, null, k.id)));
  db.ascReferrals.filter((r) => r.status === 'new' && (r.assignee === who || !r.assignee)).forEach((r) => {
    const days = Math.round((Date.now() - new Date(r.receivedAt)) / DAY);
    const tries = r.attempts;
    items.push({ key: 'r-' + r.id, kind: 'referral', rank: 4, why: 'New referral from ' + r.source + (days ? ', ' + plural(days, 'day', 'days') + ' ago' : ', today') + (r.assignee ? '' : ' · unassigned'), text: r.reason, due: '', attempts: tries.length, lastAttempt: tries.length ? tries[tries.length - 1].result + ', ' + usOf(new Date(tries[tries.length - 1].at)) : '', clientId: r.clientId, clientName: r.person.first + ' ' + r.person.last, phone: r.person.phone, contactId: '', needId: '', actionId: '', referralId: r.id, status: r.status });
  });
  const order = (x) => x.due || '9999';
  return items.sort((a, b) => a.rank - b.rank || a.attempts - b.attempts || (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0) || a.key.localeCompare(b.key));
}
