import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';

let call, pool, seq = 0;
before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels: simulatedChannels() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const company = async () => (await call('POST', '/auth/register', { name: 'Asha Rao', email: `task${++seq}@example.com`, password: 'password123', company: `Task Co ${seq}`, sector: 'trading', stateCode: '29' })).body.token;
const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('create, read, edit and delete a task', async () => {
  const t = await company();
  const a = await ok(call('POST', '/tasks', { title: 'File GSTR-1', description: 'For October', priority: 'high', category: 'Compliance', assignee: 'Ravi', dueDate: shift(3) }, t));
  assert.deepEqual([a.status, a.priority, a.assignee, a.checklistTotal, a.commentCount, a.overdue, a.completedAt], ['todo', 'high', 'Ravi', 0, 0, false, null]);
  const g = await ok(call('GET', `/tasks/${a.id}`, undefined, t));
  assert.equal(g.title, 'File GSTR-1'); assert.deepEqual(g.checklist, []); assert.deepEqual(g.comments, []);
  const u = await ok(call('PUT', `/tasks/${a.id}`, { title: 'File GSTR-1 and 3B', assignee: '', priority: 'critical' }, t));
  assert.deepEqual([u.title, u.assignee, u.priority, u.category], ['File GSTR-1 and 3B', null, 'critical', 'Compliance']);
  assert.equal((await call('DELETE', `/tasks/${a.id}`, undefined, t)).status, 200);
  assert.equal((await call('GET', `/tasks/${a.id}`, undefined, t)).status, 404);
});

test('moving to done sets completed_at and moving back clears it', async () => {
  const t = await company();
  const a = await ok(call('POST', '/tasks', { title: 'Pay rent' }, t));
  const d = await ok(call('PUT', `/tasks/${a.id}`, { status: 'done' }, t));
  assert.ok(d.completedAt); assert.equal(d.status, 'done');
  const back = await ok(call('PUT', `/tasks/${a.id}`, { status: 'inprogress' }, t));
  assert.equal(back.completedAt, null);
  const direct = await ok(call('POST', '/tasks', { title: 'Already done', status: 'done' }, t));
  assert.ok(direct.completedAt);
});

test('filters by status, priority, assignee and search; ordered by due date', async () => {
  const t = await company();
  await ok(call('POST', '/tasks', { title: 'Later', dueDate: shift(10), assignee: 'Ravi', priority: 'low' }, t));
  await ok(call('POST', '/tasks', { title: 'Sooner', dueDate: shift(1), assignee: 'Meena', priority: 'high', status: 'review' }, t));
  await ok(call('POST', '/tasks', { title: 'No date', category: 'Audit' }, t));
  const all = await ok(call('GET', '/tasks', undefined, t));
  assert.deepEqual(all.map((x) => x.title), ['Sooner', 'Later', 'No date']);
  assert.deepEqual((await ok(call('GET', '/tasks?status=review', undefined, t))).map((x) => x.title), ['Sooner']);
  assert.deepEqual((await ok(call('GET', '/tasks?priority=low', undefined, t))).map((x) => x.title), ['Later']);
  assert.deepEqual((await ok(call('GET', '/tasks?assignee=ravi', undefined, t))).map((x) => x.title), ['Later']);
  assert.deepEqual((await ok(call('GET', '/tasks?q=audit', undefined, t))).map((x) => x.title), ['No date']);
  assert.equal((await call('GET', '/tasks?status=nope', undefined, t)).status, 400);
});

test('checklist and comment flow with counts', async () => {
  const t = await company();
  const a = await ok(call('POST', '/tasks', { title: 'Year end' }, t));
  await ok(call('POST', `/tasks/${a.id}/checklist`, { text: 'Stock count' }, t));
  const withItems = await ok(call('POST', `/tasks/${a.id}/checklist`, { text: 'Bank reconciliation' }, t));
  assert.deepEqual(withItems.checklist.map((c) => c.text), ['Stock count', 'Bank reconciliation']);
  const first = withItems.checklist[0];
  const ticked = await ok(call('PUT', `/tasks/${a.id}/checklist/${first.id}`, { done: true }, t));
  assert.equal(ticked.checklist[0].done, true);
  const renamed = await ok(call('PUT', `/tasks/${a.id}/checklist/${first.id}`, { text: 'Physical stock count' }, t));
  assert.deepEqual([renamed.checklist[0].text, renamed.checklist[0].done], ['Physical stock count', true]);
  const c = await ok(call('POST', `/tasks/${a.id}/comments`, { body: 'Started on this' }, t));
  assert.deepEqual([c.comments.length, c.comments[0].author, c.comments[0].canDelete], [1, 'Asha Rao', true]);
  const row = (await ok(call('GET', '/tasks', undefined, t)))[0];
  assert.deepEqual([row.checklistTotal, row.checklistDone, row.commentCount], [2, 1, 1]);
  const left = await ok(call('DELETE', `/tasks/${a.id}/checklist/${first.id}`, undefined, t));
  assert.equal(left.checklist.length, 1);
  const noComment = await ok(call('DELETE', `/tasks/${a.id}/comments/${c.comments[0].id}`, undefined, t));
  assert.equal(noComment.comments.length, 0);
  assert.equal((await call('POST', `/tasks/${a.id}/comments`, { body: 'x'.repeat(2001) }, t)).status, 400);
  assert.equal((await call('POST', `/tasks/${a.id}/checklist`, { text: '  ' }, t)).status, 400);
});

test('another company cannot read or change the tasks', async () => {
  const t1 = await company(), t2 = await company();
  const a = await ok(call('POST', '/tasks', { title: 'Secret' }, t1));
  const it = (await ok(call('POST', `/tasks/${a.id}/checklist`, { text: 'step' }, t1))).checklist[0];
  const cm = (await ok(call('POST', `/tasks/${a.id}/comments`, { body: 'hi' }, t1))).comments[0];
  assert.deepEqual(await ok(call('GET', '/tasks', undefined, t2)), []);
  const attempts = [['GET', `/tasks/${a.id}`], ['PUT', `/tasks/${a.id}`, { title: 'x' }], ['DELETE', `/tasks/${a.id}`], ['POST', `/tasks/${a.id}/checklist`, { text: 'x' }],
    ['PUT', `/tasks/${a.id}/checklist/${it.id}`, { done: true }], ['DELETE', `/tasks/${a.id}/checklist/${it.id}`], ['POST', `/tasks/${a.id}/comments`, { body: 'x' }], ['DELETE', `/tasks/${a.id}/comments/${cm.id}`]];
  for (const [m, p, b] of attempts) assert.equal((await call(m, p, b, t2)).status, 404, `${m} ${p}`);
  assert.equal((await ok(call('GET', `/tasks/${a.id}`, undefined, t1))).title, 'Secret');
});

test('validation messages and employee assignment', async () => {
  const t = await company();
  const bad = async (body, re) => { const r = await call('POST', '/tasks', body, t); assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), re); };
  await bad({}, /./);
  await bad({ title: 'x'.repeat(201) }, /200/);
  await bad({ title: 'ok', status: 'later' }, /Status must be/);
  await bad({ title: 'ok', priority: 'urgent' }, /Priority must be/);
  await bad({ title: 'ok', dueDate: '31/12/2026' }, /Due date/);
  assert.equal((await call('POST', '/tasks', { title: 'ok', assigneeEmployeeId: 99999 }, t)).status, 404);
  assert.equal((await call('PUT', '/tasks/abc', { title: 'x' }, t)).status, 404);
  // an employee of the company can be assigned; one of another company cannot
  const me = await ok(call('GET', '/auth/me', undefined, t));
  const mk = async (cid, name) => (await pool.query("INSERT INTO employees (company_id, code, name, doj, basic) VALUES ($1,'E1',$2,'2024-04-01',20000) RETURNING id", [cid, name])).rows[0].id;
  const mine = await mk(me.companyId, 'Meena Iyer');
  const t2 = await company();
  const me2 = await ok(call('GET', '/auth/me', undefined, t2));
  const theirs = await mk(me2.companyId, 'Outsider');
  const a = await ok(call('POST', '/tasks', { title: 'Payroll', assigneeEmployeeId: mine }, t));
  assert.deepEqual([a.assignee, a.assigneeEmployeeId], ['Meena Iyer', mine]);
  assert.equal((await call('POST', '/tasks', { title: 'Nope', assigneeEmployeeId: theirs }, t)).status, 404);
  const names = await ok(call('GET', '/tasks/assignees', undefined, t));
  assert.deepEqual(names.map((n) => n.name), ['Meena Iyer']);
});

test('summary, overdue flag and assignee suggestions', async () => {
  const t = await company();
  await ok(call('POST', '/tasks', { title: 'Late', dueDate: shift(-2), assignee: 'Asha Rao' }, t));
  await ok(call('POST', '/tasks', { title: 'Late but done', dueDate: shift(-2), status: 'done' }, t));
  await ok(call('POST', '/tasks', { title: 'This week', dueDate: shift(2), status: 'inprogress', assignee: 'Ravi' }, t));
  const list = await ok(call('GET', '/tasks', undefined, t));
  assert.deepEqual(list.map((x) => [x.title, x.overdue]), [['Late', true], ['Late but done', false], ['This week', false]]);
  const s = await ok(call('GET', '/tasks/summary', undefined, t));
  assert.deepEqual([s.total, s.overdue, s.dueThisWeek, s.myOpen, s.byStatus.todo, s.byStatus.inprogress, s.byStatus.done], [3, 1, 1, 1, 1, 1, 1]);
  const names = await ok(call('GET', '/tasks/assignees', undefined, t));
  assert.deepEqual(names.map((n) => n.name), ['Asha Rao', 'Ravi']);
});
