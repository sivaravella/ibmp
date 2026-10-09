// Builds a tiny text PDF by hand (Helvetica, one line of text per entry, 50 lines to a page) for the tests of the document reader.
// No dependency: the file is plain objects with a cross-reference table.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(lines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50));
  if (!pages.length) pages.push([]);
  const objs = [];                                  // objs[n-1] = body of object n
  const pageNos = pages.map((_, i) => 4 + i * 2);
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((pl, i) => {
    const stream = `BT /F1 10 Tf 14 TL 40 800 Td ${pl.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[4 + i * 2] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
