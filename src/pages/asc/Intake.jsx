// Step 1, Intake. Asked on every contact, by phone or in person, whether or not the person is known.
import React, { useRef, useState } from 'react';
import { Icon } from '../../ui/icons.jsx';
import { Segmented, Field } from '../../ui/controls.jsx';
import { useClient, useSearch } from '../../state/data.js';
import { useAscMutations } from '../../state/asc.js';
import { navigate } from '../../router.jsx';
import {
  SAFETY, CALLERS, CALLER_DETAIL, AGES, COVERAGE, FOUND, FOUND_DETAIL, PRIVACY, URGENCY, NEED_OPTIONS, SCREENING, SITES,
  REACH_FIELDS, DEMO_FIELDS, DEMO_OPTIONS, needForScreen, isConcern, usDate, ageGroupFor, effective, reachChanged, blankReach, stepsFor
} from '../../data/asc.js';
import { Options, Section, StepHeading, initials, focusLater, removeWithUndo, useMountFocus } from './parts.jsx';
import { PossibleLinks } from './Identify.jsx';
import { useApi, usePref } from '../../state/store.jsx';
import { dobText } from '../../lib.js';

// Dates of birth on file are MM/DD/YYYY; date fields use YYYY-MM-DD.
export const isoDob = (v) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v || ''); return m ? m[3] + '-' + m[1] + '-' + m[2] : v || ''; };

let needSeq = 0;
export const newNeed = (name, urg = 'Routine') => ({ id: 'n' + Date.now().toString(36) + (needSeq++), name, urg, outcome: '', outcomeNote: '' });

// In person only: which site, and whether the space is private enough for the safety and screening questions.
function Where({ k, edit }) {
  if (k.channel !== 'person') return null;
  return (
    <Section id="h-where" title="Where you're meeting" icon="door" className="is-compact">
      <div className="form-grid is-2">
        <div className="field">
          <label htmlFor="asc-site">Site</label>
          <select className="select" id="asc-site" value={k.site} onChange={(e) => edit({ site: e.target.value }, { now: true })}>
            {SITES.map((x) => <option key={x}>{x}</option>)}
          </select>
        </div>
      </div>
      <p className="field-label" id="h-privacy">Where are you talking?</p>
      <Options labelId="h-privacy" value={k.intake.privacy} options={PRIVACY} onChange={(v) => edit({ intake: { privacy: v } }, { now: true })} concern={[PRIVACY[1]]} />
      {k.intake.privacy === PRIVACY[1] && <p className="notice is-warn" role="note"><Icon name="alert" size={18} /><span>Move somewhere private before the safety and screening questions, or ask them before they leave.</span></p>}
    </Section>
  );
}

function Safety({ k, edit, openModal }) {
  const urgent = () => { edit({ intake: { safety: 'Yes' } }, { now: true }); openModal('ascUrgent', { contactId: k.id }); };
  return (
    <section className="asc-safety" aria-labelledby="h-safety">
      <div className="asc-safety-top">
        <div><h3 className="section-label" id="h-safety"><Icon name="shield" size={18} />Safety</h3><p id="q-safety">Is anyone in immediate danger, or thinking about hurting themselves?</p></div>
        <div className="asc-safety-opts">
          <Options labelId="q-safety" value={k.intake.safety === 'No' ? 'No' : null} options={SAFETY} onChange={(v) => edit({ intake: { safety: v } }, { now: true })} />
          <button type="button" className="opt is-danger" aria-pressed={k.intake.safety === 'Yes'} onClick={urgent}><Icon name="alert" size={14} />Yes</button>
        </div>
      </div>
      <p className="asc-safety-lines">If anyone is in danger right now: <strong>911</strong> · <strong>988</strong> Suicide and Crisis Lifeline · <strong>resolve Crisis Services</strong></p>
    </section>
  );
}

// A returning caller's reference number, from an earlier contact. Attaching it ties the contacts together.
function LookUp({ k, edit, openModal, close }) {
  const { lookupContact } = useAscMutations();
  const [ref, setRef] = useState('');
  const [byRef, setByRef] = useState({ busy: false, found: null });
  const [error, setError] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!ref.trim()) { setError('Enter the reference number they were given.'); return; }
    setError(''); setByRef({ busy: true, found: null });
    lookupContact(ref.trim()).then((found) => setByRef({ busy: false, found }), () => { setByRef({ busy: false, found: null }); setError('No contact has that reference number. Check it with them.'); });
  };
  const attach = () => edit({ priorRef: byRef.found.ref }, { now: true }).then(() => { close(true); openModal('ascHistory', { contactId: k.id }); });
  return (
    <form className="asc-inline" onSubmit={submit} noValidate aria-labelledby="h-lookup-caller">
      <h3 id="h-lookup-caller">Returning caller</h3>
      <div className="form-grid asc-lookup-grid">
        <Field id="asc-ref" label="Reference number" autoFocus value={ref} onChange={(v) => { setRef(v); if (error) setError(''); }} placeholder="EV-26-000142" autoComplete="off" aria-invalid={!!error} aria-describedby={error ? 'asc-look-err' : undefined} />
      </div>
      {error && <p className="field-error" id="asc-look-err" role="alert">{error}</p>}
      <div className="asc-inline-row is-end">
        <button type="button" className="btn-text" onClick={() => close()}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={byRef.busy}>Look Up</button>
      </div>
      {byRef.found && (
        <div className="asc-found" role="status">
          <span><strong>{byRef.found.ref}</strong> · {usDate(byRef.found.startedAt)} · {byRef.found.clientName || 'Anonymous' + (byRef.found.anonName ? ': ' + byRef.found.anonName : '')} · {byRef.found.needs.map((n) => n.name).join(', ')}</span>
          <button type="button" className="btn-outline" onClick={attach}><Icon name="history" />Attach and View</button>
        </div>
      )}
    </form>
  );
}

// Who the client is, as the caller gives it. Searching MCI from here and picking them puts the contact on their
// record straight away, so there's no Identify step.
function ClientFinder({ k, edit }) {
  const { linkContact } = useAscMutations();
  const { toast } = useApi();
  const i = k.intake;
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const { query, results } = useSearch(run);
  const dob = k.demo.dob || '';
  const setName = (key) => (v) => { edit({ intake: { [key]: v } }); if (error) setError(''); };
  const setDob = (v) => edit(i.age || !ageGroupFor(v) ? { demo: { dob: v } } : { demo: { dob: v }, intake: { age: ageGroupFor(v) } });
  const search = () => {
    if (!i.clientFirst.trim() && !i.clientLast.trim()) { setError('Enter a first or last name to search MCI.'); focusLater('asc-client-first'); return; }
    setError(''); setRun({ first: i.clientFirst, last: i.clientLast, dob });
  };
  const pick = (c) => {
    setBusy(c.id);
    linkContact(k, { clientId: c.id, from: 'intake' }).then((r) => { toast(r.client.first + ' ' + r.client.last + ' is on this contact and enrolled in ASC'); focusLater('h-match'); }, () => setBusy(null));
  };
  const caller = i.caller && i.caller !== 'The client';
  return (
    <div className="asc-client-find">
      <div className="form-grid is-3">
        <Field id="asc-client-first" label="First name" value={i.clientFirst} onChange={setName('clientFirst')} autoComplete="off" />
        <Field id="asc-client-last" label="Last name" value={i.clientLast} onChange={setName('clientLast')} autoComplete="off" />
        <Field id="asc-client-dob" label="Date of birth" type="date" value={dob} onChange={setDob} />
      </div>
      <div className="asc-inline-row">
        <button type="button" className="btn-outline" id="asc-client-search" onClick={search}><Icon name="search" />Search MCI</button>
        <span className="asc-hint">{caller ? 'Who the caller says the client is. ' : ''}Optional. They can stay anonymous.</span>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {run && (
        <div className="asc-results" aria-live="polite">
          {!query.ready ? <p className="asc-hint">Searching…</p>
            : results.length ? (
              <ul className="asc-result-list">
                {results.slice(0, 6).map((c) => (
                  <li key={c.id}>
                    <span><strong>{c.first} {c.last}</strong><small>{dobText(c)} · MCI {c.mci} · {c.address.city} {c.address.zip}</small></span>
                    <button type="button" className="btn-outline" disabled={!!busy} onClick={() => pick(c)}>{busy === c.id ? 'Adding…' : 'Select ' + c.first + ' ' + c.last}</button>
                  </li>
                ))}
              </ul>
            ) : <p className="asc-hint">No match in MCI. Keep going: on Identify they can stay anonymous, or you can register them.</p>}
        </div>
      )}
    </div>
  );
}

// How to reach the person. For a known client it starts as what's on file; changing it saves the new info on their
// record, reported to ASC. Demographics are behind a toggle: reaching them matters more.
function Reach({ k, edit }) {
  const kn = k.known;
  const [demoOpen, setDemoOpen] = usePref('asc.demo', false);
  const who = k.client || k.candidate;
  const val = (key) => effective(k.reach, kn && kn.reach, key);
  const dval = (key) => (key === 'dob' ? k.demo.dob || isoDob(kn && kn.demo.dob) : effective(k.demo, kn && kn.demo, key));
  const changed = !!kn && reachChanged(k);
  const onFile = kn && (kn.source || kn.asOf) ? 'On file' + (kn.source ? ' from ' + kn.source : '') + (kn.asOf ? ', as of ' + kn.asOf : '') + '.' : kn ? 'What’s on file.' : '';
  const hint = kn ? onFile + ' Update anything that’s changed.' : 'Optional. Kept with this contact' + (k.clientId ? '.' : ', and moves to their record if they’re identified.');
  const wide = { street: true };
  return (
    <Section id="h-reach" title="How to reach them" icon="phone" hint={hint}
      aside={changed && <button type="button" className="btn-text" onClick={() => edit({ reach: blankReach() }, { now: true })}>Use What’s on File</button>}>
      <div className="form-grid asc-reach-grid">
        {REACH_FIELDS.map(([key, label]) => (
          <Field key={key} id={'asc-reach-' + key} label={label} value={val(key)} wide={wide[key]} onChange={(v) => edit({ reach: { [key]: v } })}
            autoComplete="off" type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} inputMode={key === 'zip' ? 'numeric' : undefined} maxLength={key === 'zip' ? 5 : key === 'state' ? 2 : undefined} />
        ))}
      </div>
      {changed && who && <p className="notice is-good" role="status"><Icon name="check" size={18} /><span>{k.clientId ? 'Saved to ' + who.first + '’s record as an address reported to ASC. What was on file stays in their address history.' : 'Saved to ' + who.first + '’s record, reported to ASC, once they’re enrolled.'}</span></p>}
      <button type="button" className="btn-text is-icon asc-demo-toggle" aria-expanded={demoOpen} aria-controls={demoOpen ? 'asc-demo' : undefined} onClick={() => setDemoOpen(!demoOpen)}>
        <Icon name="chevronDown" size={16} className={'chev' + (demoOpen ? ' is-open' : '')} />{demoOpen ? 'Hide Demographics' : 'Show Demographics'}
      </button>
      {demoOpen && (
        <div id="asc-demo" className="asc-demo">
          <p className="asc-hint">{kn ? 'From MCI. Changes here are kept with this contact; they don’t change MCI.' : 'Optional. Ask only if they’re comfortable.'}</p>
          <div className="form-grid">
            {DEMO_FIELDS.map(([key, label]) => (key === 'dob'
              ? <Field key={key} id="asc-demo-dob" label={label} type="date" value={dval('dob')} onChange={(v) => edit(k.intake.age || !ageGroupFor(v) ? { demo: { dob: v } } : { demo: { dob: v }, intake: { age: ageGroupFor(v) } })} />
              : (
                <div className="field" key={key}><label htmlFor={'asc-demo-' + key}>{label}</label>
                  <select className="select" id={'asc-demo-' + key} value={dval(key)} onChange={(e) => edit({ demo: { [key]: e.target.value } }, { now: true })}>
                    <option value="">Not asked</option>
                    {DEMO_OPTIONS[key].concat(dval(key) && DEMO_OPTIONS[key].indexOf(dval(key)) < 0 ? [dval(key)] : []).map((o) => <option key={o}>{o}</option>)}
                  </select></div>
              )))}
          </div>
        </div>
      )}
    </Section>
  );
}

// The detail box under whichever answer is chosen.
function Detail({ id, spec, value, onChange }) {
  if (!spec) return null;
  return <div className="form-grid is-2 asc-detail"><Field id={id} label={spec.label} value={value} onChange={onChange} placeholder={spec.placeholder} autoComplete="off" wide /></div>;
}

// The person this contact is about, once picked: one line. For a candidate, details and "Not the right person"
// are on Identify.
export function MatchCard({ k }) {
  const s = k.candidate || k.client;
  // Focus moves here only when a match is chosen, not when the page opens with one already chosen.
  const shownAtOpen = useRef(!!s).current;
  const head = useMountFocus(!!s && !shownAtOpen);
  if (!s) return null;
  return (
    <section className="asc-match is-line" aria-labelledby="h-match">
      <span className="asc-avatar" aria-hidden="true">{initials(s)}</span>
      <h3 id="h-match" tabIndex={-1} ref={head}>{s.first} {s.last}</h3>
      <span>{dobText(s)} · MCI {s.mci}{k.clientId ? ' · Enrolled in ASC' : ''}</span>
    </section>
  );
}

function Needs({ k, edit, openModal }) {
  const { toast } = useApi();
  const [custom, setCustom] = useState('');
  const names = k.needs.map((n) => n.name);
  const setUrg = (n, u) => {
    edit({ needs: k.needs.map((x) => (x.id === n.id ? { ...x, urg: u } : x)) }, { now: true });
    if (u === 'Crisis') openModal('ascUrgent', { contactId: k.id, need: n.name });
  };
  const add = (name) => { if (!name.trim() || names.indexOf(name.trim()) >= 0) return; edit({ needs: k.needs.concat([newNeed(name.trim())]) }, { now: true }); };
  return (
    <Section id="h-needs" title="What they need help with" icon="layers">
      {k.needs.length ? (
        <ul className="asc-needs">
          {k.needs.map((n) => (
            <li key={n.id}>
              <strong>{n.name}</strong>
              <Segmented small label={'Urgency for ' + n.name} value={n.urg} onChange={(u) => setUrg(n, u)} options={URGENCY.map((u) => ({ id: u, label: u }))} />
              <button type="button" className="icon-btn is-danger asc-icon-btn" aria-label={'Remove ' + n.name} onClick={() => { removeWithUndo(toast, edit, k, 'needs', n, n.name); focusLater('h-needs'); }}><Icon name="trash" size={16} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="asc-empty">No needs yet.</p>}
      <div className="asc-add-row" role="group" aria-label="Add a need">
        {NEED_OPTIONS.filter((x) => names.indexOf(x) < 0).map((x) => <button key={x} type="button" className="opt is-add" onClick={() => add(x)}><Icon name="plus" size={14} />{x}</button>)}
      </div>
      <form className="asc-inline-row" onSubmit={(e) => { e.preventDefault(); add(custom); setCustom(''); }}>
        <Field id="asc-custom-need" label="Another need" value={custom} onChange={setCustom} placeholder="For example: help with a utility shutoff notice" />
        <button type="submit" className="btn-outline">Add Need</button>
      </form>
    </Section>
  );
}

// A concern answer adds the matching need straight away (with Undo), so there's nothing extra to press.
function Screening({ k, edit }) {
  const { toast } = useApi();
  const answer = (q, v) => {
    const need = needForScreen(q, k.intake.age);
    const add = isConcern(q, v) && !k.needs.some((n) => n.name === need);
    if (!add) { edit({ screening: { [q.key]: v } }, { now: true }); return; }
    const before = k.needs;
    edit({ screening: { [q.key]: v }, needs: before.concat([newNeed(need)]) }, { now: true });
    toast(need + ' added to needs', { undo: () => edit({ needs: before }, { now: true }) });
  };
  return (
    <Section id="h-screen" title="Screening" icon="check">
      <div className="asc-screen">
        {SCREENING.map((q) => (
          <div className="asc-q" key={q.key}>
            <p className="asc-q-text" id={'q-' + q.key}>{q.question}</p>
            <Options labelId={'q-' + q.key} value={k.screening[q.key]} options={q.options} concern={q.concern} onChange={(v) => answer(q, v)} />
          </div>
        ))}
      </div>
    </Section>
  );
}

export function IntakeStep({ k, edit, openModal, next }) {
  const [look, setLookState] = useState(false);
  // Closing the lookup puts focus back on the button that opened it.
  const setLook = (v, quiet) => { if (!v && look && !quiet) focusLater('asc-btn-look'); setLookState(v); };
  const { client: c } = useClient(k.candidateId || null);
  const i = k.intake;
  const set = (key, now) => (v) => edit({ intake: { [key]: v } }, now ? { now: true } : undefined);
  const closed = k.status === 'closed';
  const known = !!(k.clientId || k.candidateId);
  return (
    <div className="view asc-view">
      <StepHeading>Intake</StepHeading>
      {!known && !closed && (
        <div className="asc-step-actions">
          <button type="button" className="btn-outline" id="asc-btn-look" aria-expanded={look} onClick={() => setLook(!look)}><Icon name="history" />Returning Caller</button>
        </div>
      )}
      {look && <LookUp k={k} edit={edit} openModal={openModal} close={(quiet) => setLook(false, quiet)} />}
      {k.priorRefs.length > 0 && (
        <div className="notice is-info">
          <Icon name="history" size={18} />
          <p><strong>Returning caller.</strong> Earlier contacts {k.priorRefs.join(' and ')} are tied to this one.</p>
          <button type="button" className="btn-outline" onClick={() => openModal('ascHistory', { contactId: k.id })}>View History</button>
        </div>
      )}

      <Where k={k} edit={edit} />
      <Safety k={k} edit={edit} openModal={openModal} />

      <Section id="h-who" title="Who's calling" icon="users">
        {c && c.guardian && (
          <div className="asc-confirm">
            <p id="h-cconf"><strong>On file:</strong> {c.guardian.name}, {c.guardian.relationship.toLowerCase()} · {c.guardian.phone}. Is this who you're talking to?</p>
            <Options labelId="h-cconf" value={i.callerConfirmed} options={['Yes, ' + c.guardian.name, 'Someone else']}
              onChange={(v) => edit({ intake: v && v !== 'Someone else' ? { callerConfirmed: v, caller: 'Parent or guardian', callerDetail: c.guardian.name + ', ' + c.guardian.relationship.toLowerCase() } : { callerConfirmed: v } }, { now: true })} />
          </div>
        )}
        <p className="field-label" id="h-caller">Caller</p>
        <Options labelId="h-caller" value={i.caller} options={CALLERS} onChange={set('caller', true)} />
        {i.caller && <Detail id="asc-caller-detail" spec={CALLER_DETAIL[i.caller]} value={i.callerDetail} onChange={set('callerDetail')} />}
        <p className="field-label" id="h-age">Age of the person who needs help</p>
        <Options labelId="h-age" value={i.age} options={AGES} onChange={set('age', true)} />
      </Section>

      <Section id="h-client" title="Who the client is" icon="user">
        {known ? (
          <>
            <MatchCard k={k} />
            {k.clientId && !stepsFor(k).some((s) => s[0] === 'identify') && <PossibleLinks k={k} edit={edit} />}
          </>
        ) : <ClientFinder k={k} edit={edit} />}
      </Section>

      <Reach k={k} edit={edit} />

      <Section id="h-story" title="What's going on" icon="notes">
        <label className="sr-only" htmlFor="asc-story">What's going on, in their words</label>
        <textarea className="input is-block" id="asc-story" rows={4} value={i.story} onChange={(e) => set('story')(e.target.value)} placeholder="In their words" />
      </Section>

      <Screening k={k} edit={edit} />
      <Needs k={k} edit={edit} openModal={openModal} />

      <Section id="h-cov" title="Healthcare coverage" icon="landmark">
        {c && c.coverage && (
          <div className="asc-confirm">
            <p id="h-covconf"><strong>On file:</strong> {c.coverage.plan}, {c.coverage.status.toLowerCase()} as of {c.coverage.asOf}. Still right?</p>
            <Options labelId="h-covconf" value={i.coverageConfirmed} options={['Yes, still the same', 'It changed']}
              onChange={(v) => edit({ intake: v === 'Yes, still the same' ? { coverageConfirmed: v, coverage: COVERAGE[0], coverageDetail: c.coverage.plan } : { coverageConfirmed: v, coverage: v ? null : i.coverage } }, { now: true })} />
          </div>
        )}
        <Options label="Healthcare coverage" value={i.coverage} options={COVERAGE} onChange={set('coverage', true)} />
        {i.coverage && i.coverage !== 'None' && i.coverage !== 'Doesn’t know' && <div className="form-grid is-2"><Field id="asc-cov" label="Plan (optional)" value={i.coverageDetail} onChange={set('coverageDetail')} placeholder="For example: HealthChoices through CCBH" /></div>}
      </Section>

      <Section id="h-found" title="How they found us" icon="search">
        <Options label="How they found us" value={i.found} options={FOUND} onChange={set('found', true)} />
        {i.found && <Detail id="asc-found-detail" spec={FOUND_DETAIL[i.found]} value={i.foundDetail} onChange={set('foundDetail')} />}
      </Section>

      {next && <div className="asc-foot"><span /><button type="button" className="btn-primary is-icon" onClick={() => navigate({ page: 'contact', id: k.id, step: next[0] })}>Next: {next[1]}<Icon name="arrowRight" /></button></div>}
    </div>
  );
}
