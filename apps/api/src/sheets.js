// Spreadsheet helpers shared by the reports and the sales/purchase import and export: write an .xlsx or CSV, read one back.
// Money stays a plain number in the cells (not text), so Excel can add it up.
import ExcelJS from 'exceljs';

const NAVY = 'FF14243A', YELLOW = 'FFFFCB05';

/**
 * sheets: [{ name, title?, subtitle?, columns: [{ header, key, width?, numFmt?, align? }], rows: [{ [key]: value }], totals?: { [key]: value }, notes?: string[] }]
 * Returns a Buffer holding the workbook. A sheet gets an optional title block, a navy header row, and an optional bold totals row.
 */
export async function buildWorkbook(sheets, { creator = 'IBMP' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = creator; wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(String(s.name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet');
    let r = 1;
    if (s.title) { ws.getCell(r, 1).value = s.title; ws.getCell(r, 1).font = { bold: true, size: 14, color: { argb: NAVY } }; r += 1; }
    if (s.subtitle) { ws.getCell(r, 1).value = s.subtitle; ws.getCell(r, 1).font = { color: { argb: 'FF64748B' } }; r += 1; }
    if (s.title || s.subtitle) r += 1;
    const headRow = r;
    s.columns.forEach((c, i) => {
      const cell = ws.getCell(headRow, i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      cell.alignment = { vertical: 'middle', horizontal: c.align ?? (c.numFmt ? 'right' : 'left'), wrapText: true };
      ws.getColumn(i + 1).width = c.width ?? Math.max(12, Math.min(40, String(c.header).length + 4));
      if (c.numFmt) ws.getColumn(i + 1).numFmt = c.numFmt;
    });
    ws.getRow(headRow).height = 22;
    r = headRow + 1;
    for (const row of s.rows) {
      s.columns.forEach((c, i) => {
        const v = row[c.key];
        const cell = ws.getCell(r, i + 1);
        cell.value = v === undefined || v === '' ? null : v;
        if (c.numFmt) cell.numFmt = c.numFmt;
        if (row.__bold) cell.font = { bold: true };
        if (row.__fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row.__fill } };
      });
      r += 1;
    }
    if (s.totals) {
      s.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = s.totals[c.key] ?? null;
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
        if (c.numFmt) cell.numFmt = c.numFmt;
      });
      r += 1;
    }
    for (const n of s.notes ?? []) { r += 1; ws.getCell(r, 1).value = n; ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF64748B' } }; }
    ws.views = [{ state: 'frozen', ySplit: headRow }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** RFC 4180 CSV with a UTF-8 BOM (so Excel opens rupee signs and accents correctly). rows: array of arrays. */
export function toCsv(rows) {
  const cell = (c) => { const s = c === null || c === undefined ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** Parse CSV text (comma or semicolon separated, quotes allowed) into an array of arrays of strings. */
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = first.split(';').length > first.split(',').length ? ';' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 1; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i += 1; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const cellValue = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;                                   // dates stay Date objects; the caller formats them
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);                    // formula
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;                                   // hyperlink
    return '';
  }
  return v;
};

/**
 * Read the first worksheet of an .xlsx, or a CSV, into an array of arrays (empty rows dropped).
 * `kind` is 'xlsx' or 'csv'; decide it from the file name or the first bytes ("PK" means a zip, so xlsx).
 */
export async function readTable(buffer, kind) {
  const isXlsx = kind ? kind === 'xlsx' : buffer.slice(0, 2).toString('latin1') === 'PK';
  if (!isXlsx) return parseCsv(buffer.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let i = 1; i <= row.cellCount; i += 1) cells.push(cellValue(row.getCell(i).value));
    if (cells.some((c) => String(c).trim() !== '')) out.push(cells);
  });
  return out;
}
