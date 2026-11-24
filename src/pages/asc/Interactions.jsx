// Step 3, Interactions: the main work during a contact. Each resource or hand-off is one service interaction,
// documented while the person is still on the phone or in the room. Also follow-up permission and, in person,
// the steps only a visit allows (checking ID, signing consent, scanning documents).
import React, { useState } from 'react';
import { Icon } from '../../ui/icons.jsx';
import { Field } from '../../ui/controls.jsx';
import { useData } from '../../state/store.jsx';
import { useMutations, useSession } from '../../state/data.js';
import { navigate } from '../../router.jsx';
import { isoToUS, todayISO } from '../../lib.js';
import {
  IX_TYPES, PLACES, HOWS, PRESETS, FOLLOW_HOWS, needForScreen, howFor, defaultPlace, unitsFor, missingFor, totals, totalsText,
  followUpPlan, weekday, usDate, minutesBetween, clockTime, shown, plural, effective
} from '../../data/asc.js';
import { Options, Section, StepHeading, focusLater, removeWithUndo } from './parts.jsx';
import { ProviderSearchModal } from './ProviderSearch.jsx';
import { referralText } from '../../data/provider-search.js';
import { useApi } from '../../state/store.jsx';

let seq = 0;
const uid = (p) => p + Date.now().toString(36) + (seq++).toString(36);
const DOC_TYPES = ['Last year’s evaluation', 'School behavior report', 'Insurance card', 'Photo ID', 'Benefits letter', 'Other document'];

function Reminders({ k, x, reminders }) {
  const { createAction } = useMutations();
  const { staff, me } = useSession();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ text: '', assignee: me, due: '' });
  const [error, setError] = useState(false);
  const save = (e) => {
    e.preventDefault();
    const text = d.text.trim() || 'Follow up on ' + x.what;
    if (!d.due) { setError(true); return; }
    setOpen(false); setError(false);
    if (k.clientId) {
      createAction(k.clientId, { text, assignee: d.assignee, due: d.due, tag: 'ASC' }, 'Reminder added to action items')
        .then((a) => x.edit({ addLinks: [{ actionId: a.id, ixId: x.id }] }, { now: true }), () => {});
    } else {
      const a = { id: uid('ka'), text, assignee: d.assignee, due: d.due, done: false, edited: false };
      x.edit({ actions: k.actions.concat([a]), addLinks: [{ actionId: a.id, ixId: x.id }] }, { now: true });
    }
    setD({ text: '', assignee: me, due: '' });
    focusLater(base + '-add');
  };
  const base = 'r-' + x.id;
  return (
    <div className="asc-reminders">
      {reminders.length > 0 && (
        <ul className="asc-rem-list" aria-label={'Reminders for interaction ' + x.num}>
          {reminders.map((a) => <li key={a.id} className={a.done ? 'is-done' : ''}><Icon name="bell" size={15} /><span><strong>{a.text}</strong> · Due {a.due ? weekday(a.due) + ' ' + isoToUS(a.due) : 'no date'}{a.done ? ' · Done' : ''}</span></li>)}
        </ul>
      )}
      {open ? (
        <form className="composer asc-rem-form" onSubmit={save} noValidate>
          <label className="field-label" htmlFor={base + '-text'}>New reminder from this interaction</label>
          <input className="input is-block" id={base + '-text'} autoFocus value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} placeholder={'For example: Call to confirm the appointment'} />
          <div className="composer-row">
            <label className="sr-only" htmlFor={base + '-who'}>Assignee</label>
            <select className="select" id={base + '-who'} value={d.assignee} onChange={(e) => setD({ ...d, assignee: e.target.value })} style={{ flex: '1 1 160px' }}>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.first} {s.last}{s.id === me ? ' (me)' : ''}</option>)}
            </select>
            <label className="sr-only" htmlFor={base + '-due'}>Due date</label>
            <input className="input" id={base + '-due'} type="date" min={todayISO()} value={d.due} aria-invalid={error} aria-describedby={error ? base + '-err' : undefined} onChange={(e) => { setD({ ...d, due: e.target.value }); setError(false); }} />
          </div>
          {error && <span className="error" id={base + '-err'} role="alert">Choose a due date for the reminder.</span>}
          <div className="composer-foot"><button type="button" className="btn-text" onClick={() => { setOpen(false); setError(false); focusLater(base + '-add'); }}>Cancel</button><button type="submit" className="btn-outline is-wide">Save Reminder</button></div>
        </form>
      ) : <button type="button" className="btn-text is-icon" id={base + '-add'} onClick={() => setOpen(true)}><Icon name="bell" size={15} />Add Reminder</button>}
    </div>
  );
}

// One interaction. A draft (a blank card nobody has typed in yet) isn't saved until something is filled in.
function InteractionCard({ k, x, num, edit, save, needs, reminders, isNew, draft, onRemoveDraft, onFind, presets }) {
  const { toast } = useApi();
  const set = (key, now) => (v) => save({ ...x, [key]: v }, now);
  // Picking a common resource from the list fills in its type and how.
  const setWhat = (v) => {
    const p = presets.find((y) => y.label.toLowerCase() === v.trim().toLowerCase());
    if (!p) { set('what')(v); return; }
    const need = p.need === 'MH' ? needForScreen({ need: 'MH' }, k.intake.age) : p.need;
    save({ ...x, what: p.what, type: p.type, how: howFor(k.channel, p.how), need: needs.indexOf(need) >= 0 ? need : x.need }, true);
  };
  const miss = missingFor(x);
  const units = unitsFor(x.min);
  const id = (s) => 'ix-' + x.id + '-' + s;
  const needOpts = ['General'].concat(needs); if (needOpts.indexOf(x.need) < 0) needOpts.push(x.need);
  const ready = !miss.length;
  return (
    <li className={'asc-ix' + (ready || draft ? '' : ' is-incomplete') + (draft ? ' is-draft' : '')}>
      <div className="asc-ix-head">
        <span className="asc-ix-num" aria-hidden="true">{num}</span>
        <div className="field asc-ix-what">
          <label htmlFor={id('what')}>Resource or hand-off <span className="sr-only">for interaction {num}</span></label>
          <input className="input" id={id('what')} value={x.what} autoFocus={isNew} list="asc-presets" autoComplete="off" placeholder="Choose a common resource or type one" onChange={(e) => setWhat(e.target.value)} />
        </div>
        {draft ? (onRemoveDraft && <button type="button" className="icon-btn is-danger asc-icon-btn" aria-label={'Remove interaction ' + num} onClick={() => { onRemoveDraft(); focusLater('asc-add-ix'); }}><Icon name="trash" size={16} /></button>)
          : <button type="button" className="icon-btn is-danger asc-icon-btn" aria-label={'Remove interaction ' + num + ': ' + x.what} onClick={() => { removeWithUndo(toast, edit, k, 'interactions', x, 'Interaction ' + num); focusLater('h-ix'); }}><Icon name="trash" size={16} /></button>}
      </div>
      <div className="asc-ix-grid">
        <div className="field"><label htmlFor={id('need')}>For which need</label>
          <select className="select" id={id('need')} value={x.need} onChange={(e) => set('need', true)(e.target.value)}>{needOpts.map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="field"><div className="field-top"><label htmlFor={id('type')}>Type</label><span className="req">Required</span></div>
          <select className="select" id={id('type')} value={x.type} onChange={(e) => set('type', true)(e.target.value)}>{IX_TYPES.map((v) => <option key={v} value={v}>{shown(v)}</option>)}</select></div>
        <div className="field"><label htmlFor={id('how')}>How</label>
          <select className="select" id={id('how')} value={x.how} onChange={(e) => set('how', true)(e.target.value)}>{HOWS.map((v) => <option key={v} value={v}>{shown(v)}</option>)}</select></div>
        <div className="field"><div className="field-top"><label htmlFor={id('min')}>Minutes</label><span className="req">Required</span></div>
          <div className="asc-min-row">
            <input className="input" id={id('min')} type="number" min="1" inputMode="numeric" value={x.min} aria-invalid={!(Number(x.min) > 0) && k.status === 'closed'} aria-describedby={id('units')} onChange={(e) => set('min')(e.target.value)} />
            <span className="asc-units" id={id('units')}>{units ? plural(units, 'unit', 'units') : '15 min = 1 unit'}</span>
          </div></div>
        <div className="field"><div className="field-top"><label htmlFor={id('place')}>Place of service</label><span className="req">Required</span></div>
          <select className="select" id={id('place')} value={x.place} onChange={(e) => set('place', true)(e.target.value)}><option value="">Choose one</option>{PLACES.map((v) => <option key={v} value={v}>{shown(v)}</option>)}</select></div>
      </div>
      <div className="field asc-ix-ref">
        <div className="field-top"><label htmlFor={id('ref')}>Referred to</label><span className="asc-optional">Optional</span></div>
        <div className="asc-inline-row">
          <input className="input" id={id('ref')} value={referralText(x.referral)} placeholder="Find one in the directory, or type a name"
            aria-describedby={x.referral && x.referral.providerId ? id('refd') : undefined}
            onChange={(e) => set('referral')(e.target.value ? { providerId: '', facilityId: '', name: e.target.value, site: '', phone: '', address: '' } : null)} />
          <button type="button" className="btn-outline" id={id('find')} onClick={() => onFind(x)}><Icon name="search" />Find a Provider</button>
        </div>
        {x.referral && x.referral.providerId && (
          <p className="asc-ix-refd" id={id('refd')}><Icon name="checkSmall" size={14} /><span>From the provider directory{x.referral.phone ? ' · ' + x.referral.phone : ''}{x.referral.address ? ' · ' + x.referral.address : ''}</span></p>
        )}
      </div>
      <div className="field"><label htmlFor={id('notes')}>Notes</label>
        <textarea className="input is-block" id={id('notes')} rows={2} value={x.notes} placeholder="What you told them and what happens next" onChange={(e) => set('notes')(e.target.value)} /></div>
      {!draft && (
        <div className="asc-ix-foot">
          <Reminders k={k} x={{ ...x, num, edit }} reminders={reminders} />
          {!ready && <span className="asc-ix-status"><Icon name="alert" size={15} />Missing: {miss.join(', ')}</span>}
        </div>
      )}
    </li>
  );
}

function FollowUp({ k, edit }) {
  const plan = k.clientId && k.followUp.ok === 'Yes' ? followUpPlan(k, '') : null;
  return (
    <Section id="h-follow" title="Follow-up" icon="calendar" className={k.followUp.ok ? '' : 'is-warn'}>
      <p className="field-label" id="h-fok">Is it OK if we follow up to see how things are going?</p>
      <Options labelId="h-fok" value={k.followUp.ok} options={['Yes', 'No']} onChange={(v) => edit({ followUp: { ok: v } }, { now: true })} />
      {k.followUp.ok === 'Yes' && (
        <>
          <p className="field-label" id="h-fhow">Best way to reach them</p>
          <Options labelId="h-fhow" value={k.followUp.how} options={FOLLOW_HOWS} required onChange={(v) => edit({ followUp: { how: v } }, { now: true })} />
          <div className="form-grid is-2"><Field id="asc-ftime" label="Best time (optional)" value={k.followUp.time} onChange={(v) => edit({ followUp: { time: v } })} placeholder="For example: after 3 PM" /></div>
          {plan && <p className="notice is-good"><Icon name="calendar" size={18} /><span>In Action Items: 7-day on <strong>{weekday(plan[0].due)} {usDate(plan[0].due)}</strong>, 90-day on <strong>{weekday(plan[1].due)} {usDate(plan[1].due)}</strong>.</span></p>}
        </>
      )}
      {k.followUp.ok === 'No' && <p className="asc-hint">No follow-ups scheduled.</p>}
    </Section>
  );
}

function OnSite({ k, edit }) {
  const [doc, setDoc] = useState(DOC_TYPES[0]);
  const stamp = () => usDate(todayISO()) + ' ' + clockTime(new Date().toISOString());
  return (
    <Section id="h-onsite" title="On-site steps" icon="door">
      <p className="field-label" id="h-idc">Check ID</p>
      <Options labelId="h-idc" value={k.onsite.idCheck} options={['Photo ID', 'Insurance card', 'Both', 'None shown']} onChange={(v) => edit({ onsite: { idCheck: v } }, { now: true })} />
      <div className="asc-onsite-row">
        <div><strong>Consent to share with providers</strong>{k.onsite.consentSigned && <p className="asc-hint">Signed {k.onsite.consentSigned}.</p>}</div>
        {!k.onsite.consentSigned ? <button type="button" className="btn-outline" onClick={() => edit({ onsite: { consentSigned: stamp() } }, { now: true })}><Icon name="pen" />Get Signature</button> : <button type="button" className="btn-outline is-done" aria-disabled="true"><Icon name="checkSmall" />Signed</button>}
      </div>
      <div className="asc-onsite-row">
        <div><strong>Documents they brought</strong>
          {k.onsite.docs.length > 0 && <ul className="asc-docs">{k.onsite.docs.map((d) => <li key={d}><Icon name="notes" size={14} />{d}</li>)}</ul>}
        </div>
        <div className="asc-inline-row">
          <label className="sr-only" htmlFor="asc-doc">Document type</label>
          <select className="select" id="asc-doc" value={doc} onChange={(e) => setDoc(e.target.value)}>{DOC_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <button type="button" className="btn-outline" onClick={() => edit({ onsite: { docs: k.onsite.docs.concat([doc + ', scanned ' + stamp()]) } }, { now: true })}><Icon name="scan" />Scan</button>
        </div>
      </div>
    </Section>
  );
}

export function InteractionsStep({ k, edit, next }) {
  const { actions } = useData();
  const [justAdded, setJustAdded] = useState(null);
  const [finder, setFinder] = useState(null); // { x } for the interaction it was opened from
  const needs = k.needs.map((n) => n.name);
  // A new card starts on the first need nothing has been done for yet.
  const blank = () => ({ id: uid('i'), what: '', need: needs.find((n) => !k.interactions.some((x) => x.need === n)) || needs[0] || 'General', type: IX_TYPES[0], how: howFor(k.channel, 'Number given'), min: '', place: defaultPlace(k.channel), notes: '', referral: null });
  // Blank cards on screen that haven't been saved. With no interactions yet, there's always one to start typing in.
  const [drafts, setDrafts] = useState(() => (k.interactions.length || k.status === 'closed' ? [] : [blank()]));
  const saved = new Set(k.interactions.map((x) => x.id));
  const pending = drafts.filter((d) => !saved.has(d.id));
  const open = k.status === 'open' || !!k.correction;
  // The first change to a draft saves it as an interaction.
  const save = (y, now) => edit({ interactions: saved.has(y.id) ? k.interactions.map((z) => (z.id === y.id ? y : z)) : k.interactions.concat([y]) }, now ? { now: true } : undefined);
  const addDraft = () => { const d = blank(); setDrafts(pending.concat([d])); setJustAdded(d.id); };
  // A provider picked from the directory goes on the interaction it was opened from.
  const picked = (referral) => {
    const x = finder.x;
    const what = x.what.trim() ? x.what : 'Referral: ' + referral.name + (referral.site && referral.site !== referral.name ? ', ' + referral.site : '');
    save({ ...x, what, referral }, true);
    focusLater('ix-' + x.id + '-find');
  };
  const t = totals(k.interactions);
  const lookup = (id) => (k.clientId ? actions[id] : k.actions.find((a) => a.id === id));
  const elapsed = minutesBetween(k.startedAt, k.endedAt || new Date().toISOString());
  const have = k.interactions.map((x) => x.what);
  const presets = PRESETS.filter((p) => have.indexOf(p.what) < 0);
  const near = effective(k.reach, k.known && k.known.reach, 'zip') || k.anon.zip;
  const list = k.interactions.map((x) => ({ x, draft: false })).concat(open ? pending.map((x) => ({ x, draft: true })) : []);
  return (
    <div className="view asc-view">
      <StepHeading>Interactions</StepHeading>
      <div className="asc-step-actions"><span className="asc-total" role="status">{totalsText(t)} · {k.status === 'open' ? 'contact so far ' : 'contact '}{elapsed} min</span></div>

      <Section id="h-ix" title="Service interactions" icon="layers" hint={open ? 'One for each resource, referral or hand-off.' : undefined}
        aside={open && <button type="button" className="btn-outline" id="asc-add-ix" onClick={addDraft}><Icon name="plus" />Add Interaction</button>}>
        {list.length ? (
          <ol className="asc-ix-list">
            {list.map(({ x, draft }, i) => (
              <InteractionCard key={x.id} k={k} x={x} num={i + 1} edit={edit} save={save} needs={needs} isNew={x.id === justAdded} draft={draft} presets={presets}
                onRemoveDraft={draft && list.length > 1 ? () => setDrafts(pending.filter((d) => d.id !== x.id)) : null}
                reminders={k.links.filter((l) => l.ixId === x.id).map((l) => lookup(l.actionId)).filter(Boolean)} onFind={(ix) => setFinder({ x: ix })} />
            ))}
          </ol>
        ) : <p className="asc-empty">No interactions.</p>}
        <datalist id="asc-presets">{presets.map((p) => <option key={p.label} value={p.label} />)}</datalist>
        {finder && (
          <ProviderSearchModal need={finder.x.need} intakeAge={k.intake.age} coverage={k.intake.coverage} near={near}
            onPick={picked} onClose={() => setFinder(null)} />
        )}
      </Section>

      {k.clientId ? <FollowUp k={k} edit={edit} /> : (
        <p className="notice"><Icon name="calendar" size={18} /><span>Follow-ups can be scheduled once the person is identified.</span></p>
      )}
      {k.channel === 'person' && <OnSite k={k} edit={edit} />}

      {(next || t.incomplete > 0) && <div className="asc-foot">
        {t.incomplete ? <p className="asc-gaps"><Icon name="info" size={16} />{t.incomplete === 1 ? '1 interaction is' : t.incomplete + ' interactions are'} missing what was given, minutes or place of service.</p> : <span />}
        {next && <button type="button" className="btn-primary is-icon" onClick={() => navigate({ page: 'contact', id: k.id, step: next[0] })}>Next: {next[1]}<Icon name="arrowRight" /></button>}
      </div>}
    </div>
  );
}
