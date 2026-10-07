import { Router } from 'express';
import { z } from 'zod';
import { h, httpError } from '../util.js';
import { GSTIN_RE, stateFromGstin } from '../gst.js';
import { PAN_RE } from '../tds.js';

const partySchema = z.object({
  type: z.enum(['customer', 'vendor']),
  name: z.string().min(1),
  gstin: z.string().regex(GSTIN_RE).optional(),
  stateCode: z.string().regex(/^\d{2}$/).optional(),
  pan: z.string().toUpperCase().regex(PAN_RE, 'PAN must look like ABCDE1234F').optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

const itemSchema = z.object({
  name: z.string().min(1),
  hsn: z.string().optional(),
  unit: z.string().default('Nos'),
  rate: z.number().nonnegative(),
  gstPct: z.number().refine((v) => [0, 0.25, 3, 5, 12, 18, 28, 40].includes(v), 'Invalid GST slab'),
  stock: z.number().default(0),
});

export function masterRoutes(pool) {
  const r = Router();

  r.get('/parties', h(async (req, res) => {
    const type = req.query.type;
    const { rows } = await pool.query(
      `SELECT * FROM parties WHERE company_id=$1 ${type ? 'AND type=$2' : ''} ORDER BY name`,
      type ? [req.user.companyId, type] : [req.user.companyId]);
    res.json(rows);
  }));

  r.post('/parties', h(async (req, res) => {
    const b = partySchema.parse(req.body);
    const state = stateFromGstin(b.gstin) || b.stateCode;
    if (!state) throw httpError(400, 'Provide a GSTIN or a stateCode');
    const { rows } = await pool.query(
      `INSERT INTO parties (company_id,type,name,gstin,state_code,phone,email,pan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.companyId, b.type, b.name, b.gstin || null, state, b.phone || null, b.email || null, b.pan || null]);
    res.status(201).json(rows[0]);
  }));

  // The PAN is what TDS on payments to this party is reported against (it falls back to the one inside the GSTIN).
  r.put('/parties/:id/pan', h(async (req, res) => {
    const b = z.object({ pan: z.string().toUpperCase().regex(PAN_RE, 'PAN must look like ABCDE1234F').nullable() }).parse(req.body);
    const { rows } = await pool.query('UPDATE parties SET pan=$1 WHERE id=$2 AND company_id=$3 RETURNING *', [b.pan, req.params.id, req.user.companyId]);
    if (!rows[0]) throw httpError(404, 'Not found');
    res.json(rows[0]);
  }));

  r.get('/items', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM items WHERE company_id=$1 ORDER BY name', [req.user.companyId]);
    res.json(rows);
  }));

  r.post('/items', h(async (req, res) => {
    const b = itemSchema.parse(req.body);
    const { rows } = await pool.query(
      'INSERT INTO items (company_id,name,hsn,unit,rate,gst_pct,stock) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.companyId, b.name, b.hsn || null, b.unit, b.rate, b.gstPct, b.stock]);
    res.status(201).json(rows[0]);
  }));

  return r;
}
