import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, readDocument, pdfToText, isPdf, entityTypeFrom, stateCodeFromText, parseFreeAddress, UNSUPPORTED_MESSAGE } from '../src/extract.js';
import { gstinCheckChar } from '../src/gstin.js';
import { makePdf } from './support/minipdf.js';

const withCheck = (base14) => base14 + gstinCheckChar(base14);
const GSTIN = withCheck('36AAGCG1002R1Z');      // a well-formed GSTIN with the right check character

// Text as a PDF text layer gives it, modelled on the prototype's sample documents (GST REG-06, INC-11 and MCA master data).
const GST_LINES = [
  'Form GST REG-06', '[See Rule 10(1)]', 'Registration Certificate', 'Government of India',
  `Registration Number : ${GSTIN}`,
  '1. Legal Name GENESIS TECH SYSTEMS PRIVATE LIMITED',
  '2. Trade Name, if any GENESIS TECH',
  '3. Additional trade names, if any',
  '4. Address of Principal Place of Business',
  'Floor No.: 3 Building No./Flat No.: 8-2-120/86 Name Of Premises/Building: SILICON TOWERS',
  'Road/Street: ROAD NO 2 City/Town/Locality/Village: MADHAPUR, HYDERABAD District: Hyderabad',
  'State: Telangana PIN Code: 500081',
  '5. Date of liability 12/09/2023',
  '6. Constitution of Business Private Limited Company',
  '7. Particulars of Approving Authority',
  'Annexure B', 'Details of Proprietor / Partners / Directors',
  '1 Name VIKRAM CHANDUPATLA Designation/Status DIRECTOR Resident of State Telangana',
  '2 Name SANDYA RANI Designation/Status MANAGING DIRECTOR Resident of State Telangana',
];

const COI_LINES = [
  'Certificate of Incorporation', '[Pursuant to sub-section (2) of section 7 of the Companies Act, 2013]',
  'I hereby certify that LUMEN TECH INNOVATION PRIVATE LIMITED is incorporated on this Twelfth day of September',
  'Two thousand twenty-six under the Companies Act, 2013 (18 of 2013) and that the company is private limited.',
  'The Corporate Identity Number of the company is U62090TS2026PTC222614.',
  'The Permanent Account Number (PAN) of the company is AAHCL0838R*',
  'The Tax Deduction and Collection Account Number (TAN) of the company is HYDL10451A*',
  'Given under my hand at Hyderabad this Twelfth day of September Two thousand twenty-six.',
  'Mailing Address of the company as per record of Registrar of Companies is:',
  'LUMEN TECH INNOVATION PRIVATE LIMITED',
  'FLAT NO G4, SRI RESIDENCY, ROAD NO 5, KONDAPUR, HYDERABAD, Telangana, India - 500084',
  '* as issued by the Income Tax Department',
];

const MCA_LINES = [
  'Master Data',
  'CIN', 'U62090TS2026PTC222614',
  'Company Name', 'LUMEN TECH INNOVATION PRIVATE LIMITED',
  'ROC Code', 'ROC-Hyderabad',
  'Registration Number', '222614',
  'Date of Incorporation', '12/09/2026',
  'Registered Address', 'FLAT NO G4 SRI RESIDENCY', 'ROAD NO 5 KONDAPUR', 'HYDERABAD, Telangana-500084',
  'Address other than R/o where all or any books of account and papers are maintained',
  'Email Id', 'LUMENTECHINNOVATION[at]GMAIL[dot]COM',
  'Whether Listed or not', 'Unlisted',
  'Directors', 'DIN/PAN Name Designation',
  '1', '11943123', 'SANDYARANI', 'KYAVERI', 'Director', 'Promoter',
  '2', '09876543', 'RAVI KUMAR', 'Managing Director', 'Promoter',
];

test('GST registration certificate: legal name, GSTIN, PAN, address, constitution, date and directors', () => {
  const r = parseDocument('gst', GST_LINES.join('\n'));
  assert.equal(r.kind, 'gst');
  assert.deepEqual(r.notes, []);
  assert.equal(r.found.gstin, GSTIN);
  assert.equal(r.found.pan, 'AAGCG1002R');
  assert.equal(r.found.stateCode, '36');
  assert.equal(r.found.legalName, 'GENESIS TECH SYSTEMS PRIVATE LIMITED');
  assert.equal(r.found.tradeName, 'GENESIS TECH');
  assert.equal(r.found.constitution, 'Private Limited Company');
  assert.equal(r.found.entityType, 'private_limited');
  assert.equal(r.found.pin, '500081');
  assert.equal(r.found.loc, 'HYDERABAD');
  assert.equal(r.found.addr1, 'Floor 3, 8-2-120/86, SILICON TOWERS, ROAD NO 2, MADHAPUR');
  assert.equal(r.found.registrationDate, '2023-09-12');
  assert.deepEqual(r.found.directors, [{ name: 'VIKRAM CHANDUPATLA', designation: 'DIRECTOR' }, { name: 'SANDYA RANI', designation: 'MANAGING DIRECTOR' }]);
});

test('GST certificate with each label on one line and its value on the next', () => {
  const lines = [`Registration Number`, `:`, GSTIN, 'Legal Name', 'RAMA TRADERS', 'Trade Name, if any', 'RAMA TRADERS', 'Additional trade names, if any',
    'Constitution of Business', 'Proprietorship', 'Date of Liability', '01/04/2020'];
  const r = parseDocument('gst', lines.join('\n'));
  assert.equal(r.found.legalName, 'RAMA TRADERS');
  assert.equal(r.found.entityType, 'proprietorship');
  assert.equal(r.found.registrationDate, '2020-04-01');
  assert.equal(r.found.gstin, GSTIN);
});

test('a GSTIN with a wrong check character is dropped and the person is told', () => {
  const bad = GSTIN.slice(0, 14) + (GSTIN[14] === 'A' ? 'B' : 'A');
  const r = parseDocument('gst', ['Registration Number : ' + bad, 'Legal Name ACME TRADERS', 'Trade Name, if any ACME'].join('\n'));
  assert.equal(r.found.gstin, undefined);
  assert.equal(r.found.pan, undefined);
  assert.equal(r.found.legalName, 'ACME TRADERS');
  assert.match(r.notes[0], /check-digit/);
});

test('constitution maps onto our entity types', () => {
  const cases = [['Limited Liability Partnership', 'llp'], ['Partnership', 'partnership'], ['Proprietorship', 'proprietorship'], ['Private Limited Company', 'private_limited'],
    ['Public Limited Company', 'public_limited'], ['Hindu Undivided Family', 'huf'], ['Society/ Club/ Trust/ AOP', 'society'], ['Government Department', 'other']];
  for (const [c, want] of cases) assert.equal(entityTypeFrom(c, ''), want, c);
  assert.equal(entityTypeFrom('Private Limited Company', 'SOLO WORKS (OPC) PRIVATE LIMITED'), 'opc');
  assert.equal(entityTypeFrom('', 'ACME INDIA LIMITED'), 'public_limited');
  assert.equal(entityTypeFrom('', 'ACME'), undefined);
});

test('Certificate of Incorporation: name, CIN, PAN, TAN, date in words and the mailing address', () => {
  const r = parseDocument('coi', COI_LINES.join('\n'));
  assert.equal(r.kind, 'coi');
  assert.equal(r.found.legalName, 'LUMEN TECH INNOVATION PRIVATE LIMITED');
  assert.equal(r.found.cin, 'U62090TS2026PTC222614');
  assert.equal(r.found.pan, 'AAHCL0838R');
  assert.equal(r.found.tan, 'HYDL10451A');
  assert.equal(r.found.incorporatedOn, '2026-09-12');
  assert.equal(r.found.entityType, 'private_limited');
  assert.equal(r.found.pin, '500084');
  assert.equal(r.found.stateCode, '36');
  assert.equal(r.found.loc, 'HYDERABAD');
  assert.equal(r.found.addr1, 'FLAT NO G4, SRI RESIDENCY, ROAD NO 5, KONDAPUR');
});

test('Certificate of Incorporation of an LLP uses the LLPIN', () => {
  const r = parseDocument('coi', ['Certificate of Incorporation', 'Form 16', 'LLP Identification Number : AAB-1234',
    'it is hereby certified that BRIGHT PATH ADVISORS LLP is incorporated on this Third day of March Two thousand and twenty-one',
    'under the Limited Liability Partnership Act, 2008.', 'The Permanent Account Number (PAN) of the LLP is AABFQ3097L*'].join('\n'));
  assert.equal(r.found.cin, 'AAB-1234');
  assert.equal(r.found.entityType, 'llp');
  assert.equal(r.found.legalName, 'BRIGHT PATH ADVISORS LLP');
  assert.equal(r.found.incorporatedOn, '2021-03-03');
  assert.equal(r.found.pan, 'AABFQ3097L');
});

test('MCA master data: CIN, name, email, address, date and directors', () => {
  const r = parseDocument('mca', MCA_LINES.join('\n'));
  assert.equal(r.kind, 'mca');
  assert.equal(r.found.cin, 'U62090TS2026PTC222614');
  assert.equal(r.found.legalName, 'LUMEN TECH INNOVATION PRIVATE LIMITED');
  assert.equal(r.found.email, 'lumentechinnovation@gmail.com');
  assert.equal(r.found.incorporatedOn, '2026-09-12');
  assert.equal(r.found.pin, '500084');
  assert.equal(r.found.stateCode, '36');
  assert.equal(r.found.entityType, 'private_limited');
  assert.equal(r.found.addr1, 'FLAT NO G4 SRI RESIDENCY, ROAD NO 5 KONDAPUR');
  assert.equal(r.found.loc, 'HYDERABAD');
  assert.deepEqual(r.found.directors, [
    { name: 'SANDYARANI KYAVERI', din: '11943123', designation: 'Director' },
    { name: 'RAVI KUMAR', din: '09876543', designation: 'Managing Director' },
  ]);
});

test('nothing is invented: an unrelated text gives no details', () => {
  const r = parseDocument('gst', 'Invoice 42\nPlease pay 5000 rupees by Friday.\nThank you');
  assert.deepEqual(r.found, {});
});

test('a document of the wrong kind is recognised when the stated kind finds nothing', () => {
  const r = parseDocument('gst', COI_LINES.join('\n'));
  assert.equal(r.kind, 'coi');
  assert.equal(r.found.cin, 'U62090TS2026PTC222614');
});

test('free-text addresses are split into line, city, state and PIN', () => {
  const a = parseFreeAddress('12/4 MG ROAD, INDIRANAGAR, BENGALURU, Karnataka, India - 560038');
  assert.deepEqual([a.addr1, a.loc, a.stateCode, a.pin], ['12/4 MG ROAD, INDIRANAGAR', 'BENGALURU', '29', '560038']);
  assert.equal(stateCodeFromText('Tamil Nadu')?.code, '33');
  assert.equal(stateCodeFromText('Andhra Pradesh')?.code, '37');
  assert.equal(stateCodeFromText('Andaman & Nicobar Islands')?.code, '35');
  assert.equal(stateCodeFromText('nowhere'), null);
});

// ---- the full path: bytes of a real PDF -> text -> fields ----

test('a real text PDF goes through the reader end to end', async () => {
  const pdf = makePdf(GST_LINES);
  assert.ok(isPdf(pdf));
  const text = await pdfToText(pdf);
  assert.match(text, /Registration Number : 36AAGCG1002R1Z/);
  const r = await readDocument({ buffer: pdf, kind: 'gst' });
  assert.equal(r.supported, true);
  assert.equal(r.kind, 'gst');
  assert.equal(r.found.gstin, GSTIN);
  assert.equal(r.found.legalName, 'GENESIS TECH SYSTEMS PRIVATE LIMITED');
  assert.match(r.message, /Read \d+ details from your GST registration certificate/);
});

test('a PDF with text split into brackets and escapes is read', async () => {
  const r = await readDocument({ buffer: makePdf(MCA_LINES.concat(['Note (a) \\ end'])), kind: 'mca' });
  assert.equal(r.found.cin, 'U62090TS2026PTC222614');
  assert.equal(r.found.directors.length, 2);
});

test('an image or any non-PDF is not parsed', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const r = await readDocument({ buffer: png, kind: 'gst' });
  assert.deepEqual(r, { kind: 'gst', supported: false, found: {}, message: UNSUPPORTED_MESSAGE });
  const jpg = await readDocument({ buffer: Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), kind: 'coi' });
  assert.equal(jpg.supported, false);
});

test('a damaged PDF is a plain 400', async () => {
  const bad = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nthis is not a pdf at all, just junk after a header');
  await assert.rejects(() => readDocument({ buffer: bad, kind: 'gst' }), (e) => e.status === 400 && /could not read this PDF/.test(e.message));
});

test('a PDF with no text (a scan) says so instead of guessing', async () => {
  const r = await readDocument({ buffer: makePdf([]), kind: 'gst' });
  assert.equal(r.supported, false);
  assert.match(r.message, /scan/);
});

test('an empty upload is a 400', async () => {
  await assert.rejects(() => readDocument({ buffer: Buffer.alloc(0), kind: 'gst' }), (e) => e.status === 400);
});
