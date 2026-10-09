import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today, ymd } from '../util.js';

export const STATUSES = ['todo', 'inprogress', 'review', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const status = z.enum(STATUSES, { errorMap: () => ({ message: 'Status must be todo, inprogress, review or done' }) });
const priority = z.enum(PRIORITIES, { errorMap: () => ({ message: 'Priority must be low, medium, high or critical' }) });
const text = (max, label) => z.string().trim().max(max, `${label} can be at most ${max} characters`);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must look like 2026-12-31').refine((v) => !Number.isNaN(Date.parse(v)) && ymd(new Date(`${v}T00:00:00`)) === v, 'That due date does not exist');
const idOrNull = z.number().int().positive().nullable();

const createSchema = z.object({
  title: text(200, 'Title').min(1, 'Give the task a title'),
  description: text(5000, 'Description').nullish(),
  status: status.optional(),
  priority: priority.optional(),
  category: text(60, 'Category').nullish(),
  assignee: text(120, 'Assignee').nullish(),
  assigneeEmployeeId: idOrNull.optional(),
  dueDate: dueDate.nullish(),
});
const updateSchema = createSchema.partial();

const blank = (v) => (v === undefined ? undefined : (v === null || v === '' ? null : v));

const LIST_SQL = 'SELECT t.* FROM tasks t WHERE t.company_id=$1';

const withFlags = (row) => ({ ...row, due_date: row.due_date ? ymd(row.due_date) : null, overdue: !!row.due_date && ymd(row.due_date) < today() && row.status !== 'done' });

export function taskRoutes(pool) {
  const r = Router();
  // Checklist and comment counts, added to a list of task rows (kept as plain queries so they run the same on every database).
  async function counted(companyId, rows) {
    const ck = (await pool.query('SELECT c.task_id, c.done FROM task_checklist c JOIN tasks t ON t.id=c.task_id WHERE t.company_id=$1', [companyId])).rows;
    const cm = (await pool.query('SELECT m.task_id FROM task_comments m JOIN tasks t ON t.id=m.task_id WHERE t.company_id=$1', [companyId])).rows;
    return rows.map((t) => ({ ...withFlags(t),
      checklist_total: ck.filter((c) => c.task_id === t.id).length,
      checklist_done: ck.filter((c) => c.task_id === t.id && c.done).length,
      comment_count: cm.filter((c) => c.task_id === t.id).length }));
  }
  const isOwner = (req) => req.user.role === 'owner';

  async function mine(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, 'Task not found');
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id=$1 AND company_id=$2', [id, req.user.companyId]);
    if (!rows[0]) throw httpError(404, 'Task not found');
    return rows[0];
  }
  async function employeeName(companyId, id) {
    const { rows } = await pool.query('SELECT name FROM employees WHERE id=$1 AND company_id=$2', [id, companyId]);
    if (!rows[0]) throw httpError(404, 'That employee was not found in your company');
    return rows[0].name;
  }
  async function userName(userId) {
    const { rows } = await pool.query('SELECT name FROM users WHERE id=$1', [userId]);
    return rows[0]?.name || 'Owner';
  }
  async function detail(req, id) {
    const t = (await counted(req.user.companyId, (await pool.query(`${LIST_SQL} AND t.id=$2`, [req.user.companyId, id])).rows))[0];
    const checklist = (await pool.query('SELECT id, task_id, text, done, position FROM task_checklist WHERE task_id=$1 ORDER BY position, id', [id])).rows;
    const comments = (await pool.query('SELECT id, task_id, user_id, author, body, created_at FROM task_comments WHERE task_id=$1 ORDER BY created_at, id', [id])).rows
      .map((c) => ({ ...c, can_delete: isOwner(req) || c.user_id === req.user.id }));
    return { ...t, checklist, comments, can_delete: isOwner(req) };
  }

  r.get('/tasks/summary', h(async (req, res) => {
    const ts = (await pool.query(LIST_SQL, [req.user.companyId])).rows.map(withFlags);
    const t0 = today();
    const end = new Date(`${t0}T00:00:00`); end.setDate(end.getDate() + 7);
    const week = ymd(end);
    const me = await userName(req.user.id);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, ts.filter((t) => t.status === s).length]));
    res.json({
      total: ts.length, byStatus,
      overdue: ts.filter((t) => t.overdue).length,
      dueThisWeek: ts.filter((t) => t.due_date && t.status !== 'done' && t.due_date >= t0 && t.due_date <= week).length,
      myOpen: ts.filter((t) => t.status !== 'done' && t.assignee && t.assignee.toLowerCase() === me.toLowerCase()).length,
    });
  }));

  r.get('/tasks/assignees', h(async (req, res) => {
    const emps = (await pool.query('SELECT id, name FROM employees WHERE company_id=$1 AND exit_date IS NULL ORDER BY name', [req.user.companyId])).rows;
    const used = (await pool.query("SELECT DISTINCT assignee FROM tasks WHERE company_id=$1 AND assignee IS NOT NULL AND assignee<>''", [req.user.companyId])).rows;
    const names = new Map();
    for (const e of emps) names.set(e.name.toLowerCase(), { name: e.name, employee_id: e.id });
    for (const u of used) if (!names.has(u.assignee.toLowerCase())) names.set(u.assignee.toLowerCase(), { name: u.assignee, employee_id: null });
    res.json([...names.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }));

  r.get('/tasks', h(async (req, res) => {
    const args = [req.user.companyId];
    let sql = LIST_SQL;
    const { status: st, priority: pr, assignee, q } = req.query;
    if (st) { status.parse(st); args.push(st); sql += ` AND t.status=$${args.length}`; }
    if (pr) { priority.parse(pr); args.push(pr); sql += ` AND t.priority=$${args.length}`; }
    if (assignee) { args.push(String(assignee).toLowerCase()); sql += ` AND LOWER(t.assignee)=$${args.length}`; }
    if (q) { args.push(`%${String(q).toLowerCase()}%`); sql += ` AND (LOWER(t.title) LIKE $${args.length} OR LOWER(COALESCE(t.description,'')) LIKE $${args.length} OR LOWER(COALESCE(t.category,'')) LIKE $${args.length})`; }
    sql += ' ORDER BY (t.due_date IS NULL), t.due_date, t.id';
    res.json(await counted(req.user.companyId, (await pool.query(sql, args)).rows));
  }));

  r.get('/tasks/:id', h(async (req, res) => { const t = await mine(req); res.json(await detail(req, t.id)); }));

  r.post('/tasks', h(async (req, res) => {
    const b = createSchema.parse(req.body);
    let assignee = blank(b.assignee) ?? null;
    const empId = b.assigneeEmployeeId ?? null;
    if (empId) assignee = await employeeName(req.user.companyId, empId);
    const st = b.status ?? 'todo';
    const { rows } = await pool.query(
      `INSERT INTO tasks (company_id,title,description,status,priority,category,assignee,assignee_employee_id,due_date,created_by,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.user.companyId, b.title, blank(b.description) ?? null, st, b.priority ?? 'medium', blank(b.category) ?? null, assignee, empId, b.dueDate ?? null, req.user.id, st === 'done' ? new Date() : null]);
    res.status(201).json(await detail(req, rows[0].id));
  }));

  r.put('/tasks/:id', h(async (req, res) => {
    const cur = await mine(req);
    const b = updateSchema.parse(req.body);
    if (b.title !== undefined && !b.title) throw httpError(400, 'Give the task a title');
    const set = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.description !== undefined) set.description = blank(b.description);
    if (b.priority !== undefined) set.priority = b.priority;
    if (b.category !== undefined) set.category = blank(b.category);
    if (b.dueDate !== undefined) set.due_date = b.dueDate;
    if (b.assigneeEmployeeId !== undefined) {
      set.assignee_employee_id = b.assigneeEmployeeId;
      if (b.assigneeEmployeeId) set.assignee = await employeeName(req.user.companyId, b.assigneeEmployeeId);
      else if (b.assignee === undefined) set.assignee = null;
    }
    if (b.assignee !== undefined && !(b.assigneeEmployeeId)) {
      set.assignee = blank(b.assignee);
      if (b.assigneeEmployeeId === undefined) set.assignee_employee_id = null;   // a typed name replaces any earlier employee link
    }
    if (b.status !== undefined) {
      set.status = b.status;
      if (b.status === 'done' && cur.status !== 'done') set.completed_at = new Date();
      if (b.status !== 'done') set.completed_at = null;
    }
    const cols = Object.keys(set);
    const args = [...cols.map((c) => set[c]), cur.id];
    await pool.query(`UPDATE tasks SET ${[...cols.map((c, i) => `${c}=$${i + 1}`), 'updated_at=now()'].join(', ')} WHERE id=$${args.length}`, args);
    res.json(await detail(req, cur.id));
  }));

  r.delete('/tasks/:id', h(async (req, res) => {
    if (!isOwner(req)) throw httpError(403, 'Only the account owner can delete a task');
    const t = await mine(req);
    await pool.query('DELETE FROM task_checklist WHERE task_id=$1', [t.id]);
    await pool.query('DELETE FROM task_comments WHERE task_id=$1', [t.id]);
    await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
    res.json({ ok: true });
  }));

  // ---- checklist ----
  const itemText = text(300, 'Checklist item').min(1, 'Type the checklist item first');
  async function item(req, t) {
    const id = Number(req.params.itemId);
    const { rows } = await pool.query('SELECT * FROM task_checklist WHERE id=$1 AND task_id=$2', [Number.isInteger(id) ? id : 0, t.id]);
    if (!rows[0]) throw httpError(404, 'Checklist item not found');
    return rows[0];
  }
  const touch = (id) => pool.query('UPDATE tasks SET updated_at=now() WHERE id=$1', [id]);

  r.post('/tasks/:id/checklist', h(async (req, res) => {
    const t = await mine(req);
    const b = z.object({ text: itemText }).parse(req.body);
    const pos = (await pool.query('SELECT COALESCE(MAX(position),0)+1 AS p FROM task_checklist WHERE task_id=$1', [t.id])).rows[0].p;
    await pool.query('INSERT INTO task_checklist (task_id,text,position) VALUES ($1,$2,$3)', [t.id, b.text, Number(pos)]);
    await touch(t.id);
    res.status(201).json(await detail(req, t.id));
  }));

  r.put('/tasks/:id/checklist/:itemId', h(async (req, res) => {
    const t = await mine(req);
    const it = await item(req, t);
    const b = z.object({ done: z.boolean().optional(), text: itemText.optional() }).parse(req.body);
    await pool.query('UPDATE task_checklist SET done=$1, text=$2 WHERE id=$3', [b.done ?? it.done, b.text ?? it.text, it.id]);
    await touch(t.id);
    res.json(await detail(req, t.id));
  }));

  r.delete('/tasks/:id/checklist/:itemId', h(async (req, res) => {
    const t = await mine(req);
    const it = await item(req, t);
    await pool.query('DELETE FROM task_checklist WHERE id=$1', [it.id]);
    await touch(t.id);
    res.json(await detail(req, t.id));
  }));

  // ---- comments ----
  r.post('/tasks/:id/comments', h(async (req, res) => {
    const t = await mine(req);
    const b = z.object({ body: text(2000, 'Comment').min(1, 'Type a comment first') }).parse(req.body);
    await pool.query('INSERT INTO task_comments (task_id,user_id,author,body) VALUES ($1,$2,$3,$4)', [t.id, req.user.id, await userName(req.user.id), b.body]);
    res.status(201).json(await detail(req, t.id));
  }));

  r.delete('/tasks/:id/comments/:commentId', h(async (req, res) => {
    const t = await mine(req);
    const cid = Number(req.params.commentId);
    const c = (await pool.query('SELECT * FROM task_comments WHERE id=$1 AND task_id=$2', [Number.isInteger(cid) ? cid : 0, t.id])).rows[0];
    if (!c) throw httpError(404, 'Comment not found');
    if (!isOwner(req) && c.user_id !== req.user.id) throw httpError(403, 'Only the author or the account owner can delete a comment');
    await pool.query('DELETE FROM task_comments WHERE id=$1', [c.id]);
    res.json(await detail(req, t.id));
  }));

  return r;
}
