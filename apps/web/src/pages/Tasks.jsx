import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ui/icons.jsx';
import { Badge, EmptyState, PageHeader, Segmented, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Field, Notice, Pager, Toolbar } from '../ui/forms.jsx';
import { api } from '../api.js';

const COLUMNS = [['todo', 'To do'], ['inprogress', 'In progress'], ['review', 'In review'], ['done', 'Done']];
const STATUS_LABEL = Object.fromEntries(COLUMNS);
const PRIORITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['critical', 'Critical']];
const PRIORITY_LABEL = Object.fromEntries(PRIORITIES);
const PRIORITY_TONE = { low: 'neutral', medium: 'info', high: 'warn', critical: 'bad' };
const PAGE = 15;

const fmtDate = (d) => (d ? d.split('-').reverse().join('-') : '');
const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const when = (iso) => { const d = new Date(String(iso).includes('Z') || String(iso).includes('+') ? iso : `${iso}Z`); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };

const PriorityBadge = ({ p }) => <Badge tone={PRIORITY_TONE[p] ?? 'neutral'}>{PRIORITY_LABEL[p] ?? p}</Badge>;
const Due = ({ t }) => (t.dueDate ? <span className={`tk-due${t.overdue ? ' late' : ''}`}><Icon name={t.overdue ? 'alert' : 'clock'} size={13} /> {fmtDate(t.dueDate)}{t.overdue && ' · overdue'}</span> : <span className="muted">No due date</span>);
const Who = ({ name }) => (name ? <span className="tk-who"><span className="tk-avatar" aria-hidden="true">{initials(name)}</span>{name}</span> : <span className="muted">Unassigned</span>);

export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('kanban');
  const [q, setQ] = useState('');
  const [who, setWho] = useState('all');
  const [prio, setPrio] = useState('all');
  const [form, setForm] = useState(null);          // { task?, status? } while the new/edit drawer is open
  const [openId, setOpenId] = useState(null);
  const [flash, setFlash] = useState('');
  const [sortDesc, setSortDesc] = useState(false);
  const [page, setPage] = useState(1);

  const load = () => api('GET', '/tasks').then((r) => { setTasks(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const names = useMemo(() => [...new Set((tasks ?? []).map((t) => t.assignee).filter(Boolean))].sort(), [tasks]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (tasks ?? []).filter((t) => (who === 'all' || (who === '' ? !t.assignee : t.assignee === who)) && (prio === 'all' || t.priority === prio)
      && (!needle || [t.title, t.description, t.category, t.assignee].some((x) => String(x ?? '').toLowerCase().includes(needle))));
  }, [tasks, q, who, prio]);

  async function move(t, status) {
    if (t.status === status) return;
    setErr('');
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, status } : x)));   // shows the move at once; reloaded below
    try { await api('PUT', `/tasks/${t.id}`, { status }); } catch (e) { setErr(e.message); }
    load();
  }

  if (!tasks) return <><PageHeader title="Task manager" subtitle="Plan, assign and track the work of your business" />{err ? <Notice>{err}</Notice> : <Skeleton rows={6} height={44} />}</>;

  const filtered = q || who !== 'all' || prio !== 'all';
  return (
    <>
      <PageHeader title="Task manager" subtitle="Plan, assign and track the work of your business">
        <Segmented label="View" value={view} onChange={setView} options={[['kanban', 'Board'], ['list', 'List']]} />
        <button className="primary" onClick={() => { setFlash(''); setForm({}); }}><Icon name="plus" size={15} /> New task</button>
      </PageHeader>
      {flash && <Notice tone="ok">{flash}</Notice>}
      <Notice>{err}</Notice>
      <Toolbar search={q} onSearch={(v) => { setQ(v); setPage(1); }} placeholder="Search tasks">
        <select aria-label="Filter by assignee" value={who} onChange={(e) => { setWho(e.target.value); setPage(1); }}>
          <option value="all">Everyone</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}<option value="">Unassigned</option>
        </select>
        <select aria-label="Filter by priority" value={prio} onChange={(e) => { setPrio(e.target.value); setPage(1); }}>
          <option value="all">Any priority</option>{PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Toolbar>

      {tasks.length === 0 ? (
        <div className="panel"><EmptyState icon="tasks" title="No tasks yet" text="Write down what needs doing, give it a date and an owner, and move it along as the work progresses.">
          <button className="primary" onClick={() => setForm({})}><Icon name="plus" size={15} /> New task</button>
        </EmptyState></div>
      ) : view === 'kanban' ? (
        <Board tasks={shown} filtered={filtered} onOpen={setOpenId} onMove={move} onAdd={(status) => { setFlash(''); setForm({ status }); }} />
      ) : (
        <List tasks={shown} desc={sortDesc} onSort={() => setSortDesc(!sortDesc)} page={page} onPage={setPage} onOpen={setOpenId} />
      )}

      {form && <TaskForm task={form.task} status={form.status} onClose={() => setForm(null)}
        onSaved={(t, isNew) => { setForm(null); setFlash(isNew ? 'Task added.' : 'Task updated.'); load(); if (isNew) setOpenId(null); else setOpenId(t.id); }} />}
      {openId && !form && <Detail id={openId} onClose={() => { setOpenId(null); load(); }} onChanged={load} onEdit={(task) => setForm({ task })} onDeleted={() => { setOpenId(null); setFlash('Task deleted.'); load(); }} />}
    </>
  );
}

function Board({ tasks, filtered, onOpen, onMove, onAdd }) {
  const [over, setOver] = useState('');
  const drop = (status) => (e) => {
    e.preventDefault(); setOver('');
    const id = Number(e.dataTransfer.getData('text/plain'));
    const t = tasks.find((x) => x.id === id);
    if (t) onMove(t, status);
  };
  return (
    <div className="tk-board">
      {COLUMNS.map(([status, label]) => {
        const col = tasks.filter((t) => t.status === status);
        return (
          <section key={status} className={`tk-col${over === status ? ' over' : ''}`} aria-label={label}
            onDragOver={(e) => { e.preventDefault(); setOver(status); }} onDragLeave={() => setOver('')} onDrop={drop(status)}>
            <header className="tk-col-head"><h3>{label}</h3><span className="tk-count">{col.length}</span></header>
            <div className="tk-cards">
              {col.map((t) => <Card key={t.id} t={t} onOpen={onOpen} onMove={onMove} />)}
              {!col.length && <p className="tk-none">{filtered ? 'Nothing matches here.' : 'Nothing here yet.'}</p>}
            </div>
            <button type="button" className="tk-add" onClick={() => onAdd(status)}><Icon name="plus" size={14} /> Add task</button>
          </section>
        );
      })}
    </div>
  );
}

function Card({ t, onOpen, onMove }) {
  return (
    <article className={`tk-card p-${t.priority}`} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; }}>
      <button type="button" className="tk-card-main" onClick={() => onOpen(t.id)}>
        <span className="tk-title">{t.title}</span>
        <span className="tk-meta"><PriorityBadge p={t.priority} />{t.category && <span className="tk-cat">{t.category}</span>}</span>
        <span className="tk-meta"><Who name={t.assignee} /></span>
        <span className="tk-meta"><Due t={t} />
          {t.checklistTotal > 0 && <span className="tk-small" title="Checklist items done"><Icon name="check" size={13} /> {t.checklistDone}/{t.checklistTotal}</span>}
          {t.commentCount > 0 && <span className="tk-small" title="Comments">{t.commentCount} {t.commentCount === 1 ? 'comment' : 'comments'}</span>}
        </span>
      </button>
      <select className="tk-move" aria-label={`Move "${t.title}" to`} value={t.status} onChange={(e) => onMove(t, e.target.value)}>
        {COLUMNS.map(([v, l]) => <option key={v} value={v}>{v === t.status ? `Status: ${l}` : `Move to ${l}`}</option>)}
      </select>
    </article>
  );
}

function List({ tasks, desc, onSort, page, onPage, onOpen }) {
  const rows = useMemo(() => [...tasks].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return a.id - b.id;
    if (!a.dueDate) return 1;                        // tasks without a date always sit at the bottom
    if (!b.dueDate) return -1;
    return (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id) * (desc ? -1 : 1);
  }), [tasks, desc]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(page, pages);
  const visible = rows.slice((cur - 1) * PAGE, cur * PAGE);
  if (!rows.length) return <div className="panel"><EmptyState icon="tasks" title="No tasks match" text="Try clearing the search or the filters." /></div>;
  return (
    <>
      <table>
        <thead><tr>
          <th>Task</th><th>Assignee</th>
          <th aria-sort={desc ? 'descending' : 'ascending'}><button type="button" className="tk-sort" onClick={onSort}>Due {desc ? '▼' : '▲'}</button></th>
          <th>Priority</th><th>Status</th>
        </tr></thead>
        <tbody>{visible.map((t) => (
          <tr key={t.id}>
            <td><button type="button" className="tk-link" onClick={() => onOpen(t.id)}><Cell main={t.title} sub={[t.category, t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal} done` : ''].filter(Boolean).join(' · ') || undefined} /></button></td>
            <td><Who name={t.assignee} /></td>
            <td><Due t={t} /></td>
            <td><PriorityBadge p={t.priority} /></td>
            <td><Badge tone={t.status === 'done' ? 'ok' : t.status === 'todo' ? 'neutral' : 'info'}>{STATUS_LABEL[t.status]}</Badge></td>
          </tr>
        ))}</tbody>
      </table>
      <Pager page={cur} pages={pages} total={rows.length} size={PAGE} onPage={onPage} />
    </>
  );
}

/** Add or edit a task. */
function TaskForm({ task, status, onClose, onSaved }) {
  const [f, setF] = useState({ title: task?.title ?? '', description: task?.description ?? '', assignee: task?.assignee ?? '', dueDate: task?.dueDate ?? '', priority: task?.priority ?? 'medium', category: task?.category ?? '', status: task?.status ?? status ?? 'todo' });
  const [people, setPeople] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('GET', '/tasks/assignees').then(setPeople).catch(() => {}); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!f.title.trim()) { setErr('Give the task a title.'); return; }
    setBusy(true);
    const match = people.find((p) => p.name.toLowerCase() === f.assignee.trim().toLowerCase());
    const body = { title: f.title.trim(), description: f.description.trim() || null, assignee: f.assignee.trim() || null, assigneeEmployeeId: match?.employeeId ?? null, dueDate: f.dueDate || null, priority: f.priority, category: f.category.trim() || null, status: f.status };
    try {
      const saved = task ? await api('PUT', `/tasks/${task.id}`, body) : await api('POST', '/tasks', body);
      onSaved(saved, !task);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }
  return (
    <Drawer open title={task ? 'Edit task' : 'New task'} subtitle={task ? undefined : 'What needs doing, who does it and by when'} onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="task-form" disabled={busy}>{busy ? 'Saving…' : task ? 'Save changes' : 'Add task'}</button></>}>
      <form id="task-form" onSubmit={submit} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-grid">
          <Field label="Title" className="span2"><input value={f.title} onChange={set('title')} maxLength={200} placeholder="For example: File GSTR-3B for October" required /></Field>
          <Field label="Description" className="span2"><textarea rows={3} value={f.description} onChange={set('description')} maxLength={5000} placeholder="Optional details" /></Field>
          <Field label="Assigned to" hint="Pick an employee or type any name"><input value={f.assignee} onChange={set('assignee')} list="task-people" maxLength={120} placeholder="Name" /></Field>
          <Field label="Due date"><input type="date" value={f.dueDate} onChange={set('dueDate')} /></Field>
          <Field label="Priority"><select value={f.priority} onChange={set('priority')}>{PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Status"><select value={f.status} onChange={set('status')}>{COLUMNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Category" className="span2"><input value={f.category} onChange={set('category')} maxLength={60} placeholder="For example: GST, Accounts, Admin" /></Field>
        </div>
        <datalist id="task-people">{people.map((p) => <option key={p.name} value={p.name} />)}</datalist>
      </form>
    </Drawer>
  );
}

/** One task in full: details, checklist, move buttons and comments. */
function Detail({ id, onClose, onChanged, onEdit, onDeleted }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  const [item, setItem] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { api('GET', `/tasks/${id}`).then(setT).catch((e) => setErr(e.message)); }, [id]);

  // Every change returns the whole task, so the panel simply shows what came back.
  async function run(method, path, body) {
    setErr(''); setBusy(true);
    try { const r = await api(method, path, body); setT(r); onChanged(); return r; }
    catch (e) { setErr(e.message); return null; }
    finally { setBusy(false); }
  }
  async function addItem(e) { e.preventDefault(); if (!item.trim()) return; if (await run('POST', `/tasks/${id}/checklist`, { text: item.trim() })) setItem(''); }
  async function post(e) { e.preventDefault(); if (!note.trim()) return; if (await run('POST', `/tasks/${id}/comments`, { body: note.trim() })) setNote(''); }
  async function remove() {
    setBusy(true);
    try { await api('DELETE', `/tasks/${id}`); onDeleted(); } catch (e) { setErr(e.message); setBusy(false); setConfirm(false); }
  }

  const done = t ? t.checklist.filter((c) => c.done).length : 0;
  return (
    <Drawer open wide title={t?.title ?? 'Task'} subtitle={t ? `${STATUS_LABEL[t.status]} · ${PRIORITY_LABEL[t.priority]} priority` : undefined} onClose={onClose}
      footer={t && (confirm
        ? <><span className="tk-confirm">Delete this task for good?</span><button type="button" onClick={() => setConfirm(false)}>Keep it</button><button type="button" className="tk-danger" disabled={busy} onClick={remove}>Yes, delete</button></>
        : <>{t.canDelete && <button type="button" className="tk-danger" onClick={() => setConfirm(true)}>Delete</button>}<button type="button" onClick={() => onEdit(t)}>Edit details</button><button type="button" className="primary" onClick={onClose}>Close</button></>)}>
      <Notice>{err}</Notice>
      {!t && !err && <Skeleton rows={4} height={24} />}
      {t && (
        <>
          <div className="tk-moves" role="group" aria-label="Move to">
            <span className="field-label">Move to</span>
            {COLUMNS.map(([v, l]) => <button key={v} type="button" className={t.status === v ? 'primary' : ''} aria-pressed={t.status === v} disabled={busy || t.status === v} onClick={() => run('PUT', `/tasks/${id}`, { status: v })}>{l}</button>)}
          </div>
          <dl className="tk-facts">
            <div><dt>Assigned to</dt><dd><Who name={t.assignee} /></dd></div>
            <div><dt>Due</dt><dd><Due t={t} /></dd></div>
            <div><dt>Priority</dt><dd><PriorityBadge p={t.priority} /></dd></div>
            <div><dt>Category</dt><dd>{t.category || <span className="muted">None</span>}</dd></div>
            {t.completedAt && <div><dt>Completed</dt><dd>{when(t.completedAt)}</dd></div>}
          </dl>
          <section><h3>Description</h3>{t.description ? <p className="tk-text">{t.description}</p> : <p className="muted">No description.</p>}</section>
          <section>
            <h3>Checklist {t.checklist.length > 0 && <span className="muted">({done}/{t.checklist.length})</span>}</h3>
            {t.checklist.length > 0 && <div className="tk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={t.checklist.length} aria-valuenow={done}><span style={{ width: `${(done / t.checklist.length) * 100}%` }} /></div>}
            <ul className="tk-checks">{t.checklist.map((c) => (
              <li key={c.id} className={c.done ? 'done' : ''}>
                <label><input type="checkbox" checked={c.done} disabled={busy} onChange={(e) => run('PUT', `/tasks/${id}/checklist/${c.id}`, { done: e.target.checked })} /> <span>{c.text}</span></label>
                <button type="button" className="icon-btn" aria-label={`Remove ${c.text}`} disabled={busy} onClick={() => run('DELETE', `/tasks/${id}/checklist/${c.id}`)}><Icon name="x" size={15} /></button>
              </li>
            ))}</ul>
            <form className="tk-inline" onSubmit={addItem}>
              <input value={item} onChange={(e) => setItem(e.target.value)} maxLength={300} placeholder="Add a checklist item" aria-label="New checklist item" />
              <button disabled={busy || !item.trim()}>Add</button>
            </form>
          </section>
          <section>
            <h3>Comments {t.comments.length > 0 && <span className="muted">({t.comments.length})</span>}</h3>
            {t.comments.length === 0 && <p className="muted">No comments yet.</p>}
            <ul className="tk-comments">{t.comments.map((c) => (
              <li key={c.id}>
                <div className="tk-c-head"><span className="tk-avatar" aria-hidden="true">{initials(c.author)}</span><strong>{c.author}</strong><span className="muted">{when(c.createdAt)}</span>
                  {c.canDelete && <button type="button" className="tk-linkbtn" disabled={busy} onClick={() => run('DELETE', `/tasks/${id}/comments/${c.id}`)}>Delete</button>}</div>
                <p className="tk-text">{c.body}</p>
              </li>
            ))}</ul>
            <form className="tk-post" onSubmit={post}>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Write a comment" aria-label="New comment" />
              <button className="primary" disabled={busy || !note.trim()}>Post</button>
            </form>
          </section>
        </>
      )}
    </Drawer>
  );
}
