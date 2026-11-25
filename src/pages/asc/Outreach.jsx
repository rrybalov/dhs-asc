// Outreach: calls a coordinator makes, not just the ones they get. An action item, a referral or an open need can
// be called from wherever it shows. If they pick up, that's a new contact; if not, the attempt is logged on the
// item. Also here: status on action items, the Next Up list, referrals from other programs, and a client's
// ASC history at a glance.
import React, { useState } from 'react';
import { Icon } from '../../ui/icons.jsx';
import { Modal, Loaded, Table, SelectBox, ViewBar } from '../../ui/controls.jsx';
import { CopyButton } from '../../ui/records.jsx';
import { useMutations, useSession, useClient } from '../../state/data.js';
import { useData, usePref } from '../../state/store.jsx';
import { useModalControls } from '../../state/modal.js';
import { useAscMutations, useAscReferrals, useContactHistory, useNextUp, useOutreachMutations } from '../../state/asc.js';
import { Link, navigate, REFERRAL_VIEWS } from '../../router.jsx';

import { ACTION_STATUS, ATTEMPT_RESULTS, REFERRAL_STATUS, REFERRAL_SOURCES, OUTCOMES, OPEN, SUPERVISOR, usDate, plural } from '../../data/asc.js';
import { SearchLaunch } from '../hub/HubShell.jsx';
import { ascEnrollment } from './AscTab.jsx';

// ------------------------------------------------------------------ action item status
// The status of an action item, changeable where it shows. A client's items live on their record; an anonymous
// contact's live on the contact (pass `k` and `edit`).
export function ActionStatus({ a, id, label, k, edit, small }) {
  const { setActionStatus } = useMutations();
  const status = a.status || (a.done ? 'done' : 'open');
  const set = (v) => {
    if (v === status) return;
    if (k && edit) edit({ actions: k.actions.map((x) => (x.id === a.id ? { ...x, status: v, done: ['done', 'unreachable', 'cant'].indexOf(v) >= 0 } : x)) }, { now: true });
    else setActionStatus(a, v, ACTION_STATUS[v]).catch(() => {});
  };
  return (
    <span className={'asc-status-pick is-' + status + (small ? ' is-small' : '')}>
      <label className="sr-only" htmlFor={id}>{label || 'Status of ' + a.text}</label>
      <select className="select" id={id} value={status} onChange={(e) => set(e.target.value)}>
        {Object.entries(ACTION_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </span>
  );
}

const lastAttempt = (list) => (list && list.length ? list[list.length - 1] : null);
export const attemptsText = (list) => {
  const t = lastAttempt(list);
  return t ? plural(list.length, 'call attempt', 'call attempts') + ' · last: ' + t.result.toLowerCase() + ', ' + usDate(t.at) : '';
};

// ------------------------------------------------------------------ calling someone
// The Call button opens this. `item`: { kind: action|referral|need, text, why, name, phone, clientId, actionId,
// referralId, contactId, need, attempts[] }. They answered: start an outreach contact about the item. They didn't:
// log the attempt on the item.
export function CallButton({ item, label = 'Call', small, id }) {
  const { openModal } = useModalControls();
  return <button type="button" id={id} className={'btn-outline' + (small ? ' is-small' : '')} onClick={() => openModal('ascCall', { item })} aria-label={label + ' ' + (item.name || 'them') + ': ' + item.text}><Icon name="phone" size={small ? 14 : 16} />{label}</button>;
}

export function CallModal({ item, onClose }) {
  const { createContact } = useAscMutations();
  const { logAttempt } = useOutreachMutations();
  const [mode, setMode] = useState('choose');
  const [result, setResult] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!item) return null;
  const start = () => {
    setBusy(true);
    const body = { channel: 'phone', direction: 'out' };
    if (item.referralId) body.referralId = item.referralId;
    else if (item.actionId && item.clientId) body.actionId = item.actionId;
    else { if (item.clientId) body.clientId = item.clientId; body.purpose = item.kind === 'need' ? 'Follow up on an open need: ' + item.text : item.text; }
    createContact(body).then((k) => { onClose(); navigate({ page: 'contact', id: k.id, step: 'intake' }); }, () => setBusy(false));
  };
  const save = (e) => {
    e.preventDefault();
    if (!result) { setError('Choose what happened.'); return; }
    setBusy(true);
    logAttempt({ actionId: item.referralId ? undefined : item.actionId || undefined, referralId: item.referralId || undefined, clientId: item.actionId || item.referralId ? undefined : item.clientId, text: item.kind === 'need' ? 'Follow-up call about ' + item.text.toLowerCase() : item.text, result, note }).then(onClose, () => setBusy(false));
  };
  const canLog = !!(item.actionId || item.referralId || item.clientId);
  return (
    <Modal id="asc-call" title={'Call ' + (item.name || 'them')} icon="phone" narrow onClose={onClose} focusKey={mode}>
      <div className="asc-call">
        <p className="asc-call-why"><strong>{item.why ? item.why + ': ' : ''}</strong>{item.text}</p>
        {item.phone ? (
          <p className="asc-call-phone"><Icon name="phone" size={18} /><span className="mono" id="asc-call-number">{item.phone}</span><CopyButton value={item.phone} label={'phone number for ' + (item.name || 'them')} size={16} /></p>
        ) : <p className="asc-hint">No phone number on file. Check their record or the referral.</p>}
        {item.attempts && item.attempts.length > 0 && (
          <div>
            <p className="field-label">Earlier attempts</p>
            <ul className="asc-attempts">{item.attempts.slice(-4).reverse().map((t) => <li key={t.id}>{usDate(t.at)} · {t.result}{t.note ? ': ' + t.note : ''}</li>)}</ul>
          </div>
        )}
        {mode === 'choose' ? (
          <div className="asc-call-btns">
            <button type="button" className="btn-primary is-icon" onClick={start} disabled={busy} data-autofocus>{busy ? 'Starting…' : 'They Answered: Start Contact'}<Icon name="arrowRight" /></button>
            {canLog && <button type="button" className="btn-outline" onClick={() => setMode('log')}>No Answer: Log Attempt</button>}
          </div>
        ) : (
          <form className="asc-call-log" onSubmit={save} noValidate>
            <fieldset className="asc-fieldset">
              <legend className="field-label">What happened?</legend>
              <div className="asc-radio-list">
                {ATTEMPT_RESULTS.map((r) => (
                  <label key={r} className="check-row"><input type="radio" name="asc-attempt" value={r} checked={result === r} onChange={() => { setResult(r); setError(''); }} aria-describedby={error ? 'asc-attempt-err' : undefined} />{r}</label>
                ))}
              </div>
            </fieldset>
            {error && <p className="field-error" id="asc-attempt-err" role="alert">{error}</p>}
            <div className="field"><label htmlFor="asc-attempt-note">Note (optional)</label><input className="input" id="asc-attempt-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: left the ASC callback number" /></div>
            <div className="asc-inline-row is-end">
              <button type="button" className="btn-text" onClick={() => setMode('choose')}>Back</button>
              <button type="submit" className="btn-primary" disabled={busy}>Log Attempt</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ resolving an open need later
export function ResolveNeed({ x, idBase }) {
  const { resolveNeed } = useOutreachMutations();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="btn-text is-small" id={idBase + '-resolve'} onClick={() => setOpen(true)}>Mark Resolved</button>;
  const save = (e) => { e.preventDefault(); if (!outcome) return; setBusy(true); resolveNeed(x.contactId, { needId: x.needId, need: x.text, outcome }).catch(() => setBusy(false)); };
  return (
    <form className="asc-resolve" onSubmit={save}>
      <label className="sr-only" htmlFor={idBase + '-outcome'}>How was {x.text} resolved?</label>
      <select className="select" id={idBase + '-outcome'} value={outcome} onChange={(e) => setOutcome(e.target.value)} autoFocus>
        <option value="">How it ended</option>{OUTCOMES.filter((o) => o !== OPEN).map((o) => <option key={o}>{o}</option>)}
      </select>
      <button type="submit" className="btn-outline is-small" disabled={busy || !outcome}>Save</button>
      <button type="button" className="btn-text is-small" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

// ------------------------------------------------------------------ a client's ASC history at a glance
// On Intake once the person is identified, and on their ASC tab: enrollment, the last three contacts, and what's
// still open, which can be resolved, updated or called about right there.
export function AtAGlance({ clientId, contactId, openOnly }) {
  const { client: c } = useClient(clientId);
  const { actions } = useData();
  const { staffName } = useSession();
  const { query, history } = useContactHistory(contactId ? { contactId } : { clientId });
  const e = c ? ascEnrollment(c) : null;
  const done = history.contacts.filter((x) => x.status === 'closed' && x.clientId === clientId);
  const last = done[0];
  const needs = history.openItems.filter((o) => o.kind === 'Open need');
  const items = history.openItems.filter((o) => o.kind === 'Action item' && o.actionId);
  const name = c ? c.first + ' ' + c.last : '';
  return (
    <section className={'asc-glance' + (openOnly ? ' is-open-only' : '')} aria-labelledby="h-glance">
      <h4 className="asc-card-title" id="h-glance"><Icon name={openOnly ? 'inbox' : 'history'} size={18} />{openOnly ? 'Still open' : 'Earlier with ASC'}</h4>
      <Loaded query={query} what="their ASC history">{() => (
        <>
          {!openOnly && <p className="asc-glance-line">
            {e ? (e.kind === 'active' ? 'Enrolled since ' + e.start : 'Enrolled ' + e.start + '–' + e.end) : 'New to ASC'}
            {last ? ' · last contact ' + usDate(last.startedAt) + ' with ' + staffName(last.staff) : ''}
            {done.length ? ' · ' + plural(done.length, 'earlier contact', 'earlier contacts') : ''}
          </p>}
          {!openOnly && done.length > 0 && (
            <ul className="asc-glance-contacts" aria-label="Recent contacts">
              {done.slice(0, 3).map((x) => {
                const refs = x.interactions.filter((i) => i.referral && i.referral.name).map((i) => i.referral.name);
                return (
                  <li key={x.id}>
                    <span className="asc-glance-date">{usDate(x.startedAt)}{x.direction === 'out' ? ' · outreach' : ''}</span>
                    <span>{x.needs.length ? x.needs.map((n) => n.name + ': ' + (n.resolvedAt ? 'resolved' : (n.outcome || 'no outcome').toLowerCase())).join('; ') : 'No needs recorded'}</span>
                    {refs.length > 0 && <small>Referred to {[...new Set(refs)].join(', ')}</small>}
                  </li>
                );
              })}
            </ul>
          )}
          {needs.length + items.length > 0 ? (
            <ul className="asc-glance-open" aria-label="Still open">
              {needs.map((x, i) => (
                <li key={'n' + i}>
                  <span><Icon name="layers" size={15} /><strong>{x.text}</strong><small>{x.meta}</small></span>
                  <ResolveNeed x={x} idBase={'gl-n' + i} />
                </li>
              ))}
              {items.map((x) => {
                const a = actions[x.actionId] || { id: x.actionId, text: x.text, status: x.status, done: false, attempts: [] };
                return (
                  <li key={x.actionId}>
                    <span><Icon name="bell" size={15} /><strong>{x.text}</strong><small>{x.meta}</small></span>
                    <span className="asc-glance-acts">
                      <ActionStatus a={a} id={'gl-' + x.actionId} small />
                      {!contactId && <CallButton small item={{ kind: 'action', text: x.text, why: 'Action item', name, phone: c ? c.phone : '', clientId, actionId: x.actionId, attempts: a.attempts }} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="asc-hint">Nothing open from earlier contacts.</p>}
        </>
      )}</Loaded>
    </section>
  );
}

// ------------------------------------------------------------------ Next Up
function Head({ title, icon, children }) {
  return <div className="page-head asc-launch"><h1 className="page-title"><Icon name={icon} size={28} />{title}</h1>{children || <SearchLaunch />}</div>;
}
const RANK_LABEL = { 1: 'Urgent needs', 2: 'Overdue', 3: 'Due today', 4: 'New referrals', 5: 'Coming up' };
const KIND_ICON = { need: 'alert', action: 'bell', referral: 'inbox' };

export function NextUpPage() {
  const { user, me, staff } = useSession();
  const sup = user.role === SUPERVISOR;
  const [who, setWho] = usePref('asc.nextFor', '');
  const forId = sup && who ? who : me;
  const { query, items } = useNextUp(forId === me ? '' : forId);
  const { actions } = useData();
  const coordinators = staff.filter((s) => s.role === 'ASC Coordinator' || s.role === SUPERVISOR).map((s) => [s.id, s.first + ' ' + s.last + (s.id === me ? ' (me)' : '')]);
  const groups = [1, 2, 3, 4, 5].map((r) => [r, items.filter((x) => x.rank === r)]).filter(([, l]) => l.length);
  return (
    <>
      <Head title="Next Up" icon="list" />
      <section className="panel-card" aria-labelledby="asc-next-h">
        <div className="card-head">
          <h2 className="card-title" id="asc-next-h"><Icon name="list" size={22} />{forId === me ? 'Your next calls and tasks' : 'Next up for ' + (coordinators.find((c) => c[0] === forId) || ['', ''])[1]} {query.ready && <span>({items.length})</span>}</h2>
          {sup && <SelectBox id="asc-next-for" label="Coordinator" placeholder="Me" value={who} onChange={setWho} options={coordinators.filter((c) => c[0] !== me)} />}
        </div>
        <p className="asc-hint asc-next-how">Urgent needs first, then overdue, due today, new referrals and the rest by due date. People with more missed calls move down within each group.</p>
        <Loaded query={query} what="next up">{() => (groups.length ? groups.map(([r, list]) => (
          <div key={r} className="asc-next-group">
            <h3 className="asc-next-label">{RANK_LABEL[r]} <span>({list.length})</span></h3>
            <ul className="asc-next-list">
              {list.map((x) => {
                const a = x.actionId ? actions[x.actionId] || { id: x.actionId, text: x.text, status: x.status, done: false, attempts: [] } : null;
                return (
                  <li key={x.key} className={'asc-next is-' + x.kind}>
                    <Icon name={KIND_ICON[x.kind]} size={18} />
                    <div className="asc-next-main">
                      <span className="asc-next-why">{x.why}</span>
                      <strong>{x.text}</strong>
                      <span className="asc-next-who">
                        {x.clientId && x.kind !== 'referral' ? <Link className="link-btn" to={{ page: 'client', id: x.clientId, sub: 'tab', tab: 'asc' }}>{x.clientName}</Link> : x.clientName || (x.contactId ? 'Anonymous contact' : '')}
                        {x.attempts > 0 && <span className="asc-next-tries">{plural(x.attempts, 'missed call', 'missed calls')} · last: {x.lastAttempt}</span>}
                      </span>
                    </div>
                    <div className="asc-next-acts">
                      {a && <ActionStatus a={a} id={'nx-' + x.actionId} small />}
                      {x.kind === 'referral' && <Link className="btn-text is-small" to="#asc/referrals">Referral</Link>}
                      {x.kind === 'need' && <Link className="btn-text is-small" to={{ page: 'contact', id: x.contactId, step: 'wrap-up' }}>Contact</Link>}
                      <CallButton small item={{ kind: x.kind, text: x.text, why: x.why, name: x.clientName, phone: x.phone, clientId: x.clientId, actionId: x.actionId, referralId: x.referralId, contactId: x.contactId, attempts: a ? a.attempts : [] }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )) : <div className="empty-box"><Icon name="check" size={24} /><p>Nothing waiting. New referrals and due follow-ups will show here.</p></div>)}</Loaded>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ Referrals
const VIEW_TEST = { new: (r) => r.status === 'new', contacted: (r) => r.status === 'contacted', enrolled: (r) => r.status === 'enrolled', closed: (r) => r.status === 'declined' || r.status === 'unreachable', all: () => true };
const SOURCE_SHORT = { CYF: 'CYF', HMIS: 'HMIS (homeless services)', JAIL: 'Jail reentry', HOSP: 'Hospital discharge', IPV: 'IPV' };
const RSPEC = { grid: 'minmax(150px,1.2fr) minmax(220px,2.4fr) 140px 150px', min: 700 };

function ReferralRow({ r, staff }) {
  const { updateReferral } = useOutreachMutations();
  const [open, setOpen] = useState(false);
  const days = Math.round((Date.now() - new Date(r.receivedAt)) / 86400000);
  const name = r.person.first + ' ' + r.person.last;
  const item = { kind: 'referral', text: r.reason, why: 'Referral from ' + r.source, name, phone: r.person.phone, clientId: r.clientId, referralId: r.id, attempts: r.attempts };
  const base = 'rf-' + r.id;
  return (
    <div className="tr is-row is-ruled asc-ref-row" role="row">
      <div className="td" role="cell">
        {r.clientId && r.enrolled ? <Link className="link-btn" to={{ page: 'client', id: r.clientId, sub: 'tab', tab: 'asc' }}>{name}</Link> : <strong>{name}</strong>}
        <small>{r.clientId ? (r.enrolled ? 'Enrolled in ASC' : 'Found in MCI') : 'Not matched in MCI'}{r.person.phone ? ' · ' + r.person.phone : ''}</small>
        {(r.status === 'new' || r.status === 'contacted') && <CallButton small item={item} id={base + '-call'} />}
      </div>
      <div className="td" role="cell">
        <span>{r.reason}</span>
        <small><abbr title={REFERRAL_SOURCES[r.source]}>{r.source}</abbr> · {r.referrer.name}, {r.referrer.role} · {days ? usDate(r.receivedAt) : 'today'}</small>
        {r.attempts.length > 0 && <small className="asc-next-tries">{attemptsText(r.attempts)}</small>}
        {r.statusNote && <small>“{r.statusNote}”</small>}
        {open && (
          <ul className="asc-ref-log" aria-label={'History of the referral for ' + name}>{r.log.slice().reverse().map((l, i) => <li key={i}>{usDate(l.at)} · {l.text}</li>)}</ul>
        )}
        <button type="button" className="btn-text is-small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide History' : 'History'}</button>
      </div>
      <div className="td" role="cell">
        <label className="sr-only" htmlFor={base + '-who'}>Coordinator for {name}</label>
        <select className="select is-small" id={base + '-who'} value={r.assignee} onChange={(e) => updateReferral(r.id, { assignee: e.target.value }, e.target.value ? 'Referral assigned' : 'Referral unassigned').catch(() => {})}>
          <option value="">Unassigned</option>{staff.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
      </div>
      <div className="td" role="cell">
        <span className={'asc-status-pick is-' + r.status}>
          <label className="sr-only" htmlFor={base + '-status'}>Status of the referral for {name}</label>
          <select className={'select is-small'} id={base + '-status'} value={r.status} onChange={(e) => updateReferral(r.id, { status: e.target.value }, 'Referral marked ' + REFERRAL_STATUS[e.target.value]).catch(() => {})}>
            {Object.entries(REFERRAL_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </span>
      </div>
    </div>
  );
}

export function ReferralsPage({ route }) {
  const { staff, user } = useSession();
  const { query, referrals } = useAscReferrals();
  const { simulateReferral } = useOutreachMutations();
  const view = (route && route.view) || 'new';
  const [source, setSource] = usePref('asc.refSource', '');
  const list = referrals.filter((r) => VIEW_TEST[view] && VIEW_TEST[view](r) && (!source || r.source === source));
  const coordinators = staff.filter((s) => s.role === 'ASC Coordinator' || s.role === SUPERVISOR).map((s) => [s.id, s.first + ' ' + s.last]);
  return (
    <>
      <Head title="Referrals" icon="inbox">
        <button type="button" className="btn-text is-icon" onClick={() => simulateReferral().catch(() => {})}><Icon name="plus" size={16} />Simulate a Referral</button>
      </Head>
      <ViewBar label="Referral views" items={Object.keys(REFERRAL_VIEWS).map((v) => ({ to: v === 'new' ? '#asc/referrals' : '#asc/referrals/' + v, label: REFERRAL_VIEWS[v], count: query.ready ? referrals.filter(VIEW_TEST[v]).length : null, current: v === view }))} />
      <section className="panel-card" aria-labelledby="asc-ref-h">
        <div className="card-head">
          <h2 className="card-title" id="asc-ref-h"><Icon name="inbox" size={22} />{REFERRAL_VIEWS[view]} referrals {query.ready && <span>({list.length})</span>}</h2>
          <SelectBox id="asc-ref-source" label="Referred by" placeholder="All programs" value={source} onChange={setSource} options={Object.keys(REFERRAL_SOURCES).map((s) => [s, SOURCE_SHORT[s] || s])} />
        </div>
        <p className="asc-hint asc-next-how">Referrals arrive from other programs’ systems. Call to reach the person: they’re marked Contacted once you talk, and Enrolled once they’re on an ASC record.{user.role === SUPERVISOR ? '' : ' Assign one to yourself to see it in Next Up.'}</p>
        <Loaded query={query} what="referrals">{() => (
          <Table label="Referrals" spec={RSPEC} empty={'No ' + REFERRAL_VIEWS[view].toLowerCase() + ' referrals' + (source ? ' from ' + source : '') + '.'}
            head={['Person', 'Reason and referrer', 'Coordinator', 'Status'].map((h) => <div key={h} className="th" role="columnheader">{h}</div>)}>
            {list.map((r) => <ReferralRow key={r.id} r={r} staff={coordinators} />)}
          </Table>
        )}</Loaded>
      </section>
    </>
  );
}
