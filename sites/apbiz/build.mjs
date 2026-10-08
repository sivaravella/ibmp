// Builds the Apbiz website into sites/apbiz/site/ (plain HTML, one stylesheet, one small script).
//   node sites/apbiz/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABOUT, STAGES, BADGES, FAQ_HOME, HERO_TAGS, MARQUEE, SERVICES, SERVICE_TAGS, SITE } from './content.mjs';
import { POSTS } from './blog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'site');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const wa = (about) => `https://wa.me/${SITE.phoneDigits}?text=${encodeURIComponent(`Hello Apbiz, I need help with ${about}.`)}`;
const service = (slug) => SERVICES.find((s) => s.slug === slug);

const ICONS = {
  receipt: 'M6 2h12v20l-3-2-3 2-3-2-3 2V2zM9 7h6M9 11h6M9 15h4',
  percent: 'M19 5L5 19M7.5 6.5a1 1 0 100 .01M16.5 17.5a1 1 0 100 .01',
  download: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14',
  building: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  wallet: 'M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm0 0V6a2 2 0 012-2h12M16 14h2',
  filecheck: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6M9 15l2 2 4-4',
  book: 'M4 4h12a3 3 0 013 3v13H7a3 3 0 01-3-3V4zM4 17a3 3 0 013-3h12',
  check: 'M5 12l5 5L20 7',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  whatsapp: 'M20 12a8 8 0 01-11.8 7L4 20l1.1-4A8 8 0 1120 12z',
  rocket: 'M5 15c-1.5 1.5-2 4-2 6 2 0 4.5-.5 6-2M14 4c3-1 6-1 7-1 0 1 0 4-1 7l-7 7-5-5 6-8zM9 14l-2-2M15 9h.01',
  store: 'M3 9l2-5h14l2 5M3 9h18M3 9v11h18V9M9 20v-6h6v6',
  briefcase: 'M3 8h18v12H3V8zM8 8V5a1 1 0 011-1h6a1 1 0 011 1v3M3 13h18',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  chat: 'M21 12a8 8 0 01-11.5 7.2L4 20l1-4.5A8 8 0 1121 12zM9 11h6M9 14h4',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9zM13.7 21a2 2 0 01-3.4 0',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
};
const icon = (n, size = 22) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;
const seal = `<svg class="seal" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>`;

const jsonld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const faqSchema = (faq) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
const crumbSchema = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE.url + url })) });
const orgSchema = { '@context': 'https://schema.org', '@type': 'ProfessionalService', name: SITE.name, legalName: SITE.legal, url: SITE.url, email: SITE.email, telephone: SITE.phone, sameAs: Object.values(SITE.social).filter((u) => u && new URL(u).pathname.length > 1), areaServed: { '@type': 'Country', name: 'India' }, description: 'Compliance services for Indian businesses: GST, income tax, TDS, company law, PF, ESI, payroll, DPIIT and Startup India, MSME, FSSAI and licences, valuation and ISO certification.' };

const FOOT_GROUPS = [['Tax, payroll and books', [['gst', 'GST'], ['income-tax', 'Income tax'], ['tds', 'TDS and TCS'], ['pf-esi', 'PF, ESI and PT'], ['payroll', 'Payroll'], ['accounting', 'Accounting']]], ['Company and licences', [['company-law', 'Company law (ROC)'], ['startup-india', 'DPIIT and Startup India'], ['valuation', 'Valuation'], ['registrations', 'Registrations'], ['msme', 'MSME and Udyam'], ['fssai-licences', 'FSSAI and licences'], ['iso-certification', 'ISO certification']]]];
const SOCIAL_ICONS = {
  linkedin: ['LinkedIn', 'M4.98 3.5a2.5 2.5 0 11-.01 5 2.5 2.5 0 01.01-5zM3 9.75h4V21H3zM9.5 9.75h3.8v1.6h.05c.55-1 1.9-2 3.9-2 4.1 0 4.75 2.7 4.75 6.2V21h-4v-4.9c0-1.2 0-2.7-1.7-2.7s-1.9 1.3-1.9 2.6V21h-4z', true],
  facebook: ['Facebook', 'M14 8.5V6.8c0-.8.2-1.3 1.4-1.3H17V2.2C16.7 2.1 15.8 2 14.7 2 12.2 2 10.5 3.5 10.5 6.3v2.2H8v3.5h2.5V22H14V12h2.7l.4-3.5H14z', true],
  instagram: ['Instagram', 'M7 3h10a4 4 0 014 4v10a4 4 0 01-4 4H7a4 4 0 01-4-4V7a4 4 0 014-4zM12 8a4 4 0 100 8 4 4 0 000-8zM17.5 6.5h.01', false],
  x: ['X', 'M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.2L4.8 21H1.6l7.5-8.6L1.2 3h6.6l4.6 5.7L17.5 3zm-1.1 16h1.8L6.7 4.9H4.8L16.4 19z', true],
  youtube: ['YouTube', 'M21.6 7.2a2.5 2.5 0 00-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 002.4 7.2C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 001.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 001.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3z', true],
};
const socialLink = (name, href, label, d, filled) => `<a href="${href}" rel="noopener me" aria-label="${label}" title="${label}"><svg width="20" height="20" viewBox="0 0 24 24" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true"><path d="${d}"/></svg></a>`;
const RINGS = '<svg class="rings" viewBox="0 0 600 600" fill="none" aria-hidden="true"><circle cx="300" cy="300" r="110"/><circle cx="300" cy="300" r="180"/><circle cx="300" cy="300" r="250"/><circle cx="300" cy="300" r="290"/></svg>';
const SOCIALS = [
  ...Object.entries(SOCIAL_ICONS).filter(([k]) => SITE.social[k]).map(([k, [label, d, filled]]) => socialLink(k, SITE.social[k], label, d, filled)),
  socialLink('whatsapp', wa('compliance'), 'WhatsApp', ICONS.whatsapp, false),
  socialLink('email', `mailto:${SITE.email}`, 'Email', 'M3 6h18v12H3zM3 7l9 6 9-6', false),
].join('');
const NAV_MENU = SERVICES.map((s) => `<a href="/services/${s.slug}/">${esc(s.name)}</a>`).join('');

function page({ path: p, title, desc, body, schema = [], noindex = false, home = false }) {
  const url = SITE.url + p;
  const html = `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large">'}
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="Apbiz">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#14243a">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/styles.css">
<script src="/app.js" defer></script>
${schema.map(jsonld).join('\n')}
</head>
<body${home ? ' class="home"' : ''}>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="container bar">
    <a class="brand" href="/" aria-label="Apbiz home"><img class="lg-l" src="/logo-symbol.svg" width="75" height="50" alt="apbiz"><img class="lg-d" src="/logo-symbol-dark.svg" width="75" height="50" alt="" aria-hidden="true"></a>
    <nav class="main" aria-label="Main">
      <div class="has-menu"><a href="/services/" aria-haspopup="true">Services <span class="caret" aria-hidden="true"></span></a><div class="menu">${NAV_MENU}<a class="all" href="/services/">All services</a></div></div>
      <a href="/blog/">Blog</a>
      <a href="/about/">About</a>
      <a href="/contact/">Contact</a>
    </nav>
    <a class="btn outline small login" href="${SITE.software}/" rel="noopener">Login</a>
    <a class="btn wa small" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 18)} WhatsApp us</a>
    <details class="mnav"><summary aria-label="Menu"><span></span></summary>
      <div class="sheet">
        <p>Services</p>${NAV_MENU}
        <p>Platform</p><a href="${SITE.software}/" rel="noopener">Login to IBMP</a>
        <p>Company</p><a href="/blog/">Blog</a><a href="/about/">About</a><a href="/contact/">Contact</a>
      </div>
    </details>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="pattern" aria-hidden="true"></div>
  <div class="container fgrid">
    <div class="fcols">
      ${FOOT_GROUPS.map(([h, items]) => `<div><h3>${h}</h3><ul>${items.map(([s, label]) => `<li><a href="/services/${s}/">${esc(label)}</a></li>`).join("")}</ul></div>`).join("")}
      <div class="fguides"><h3>Guides</h3><ul>${POSTS.map((p) => `<li><a href="/blog/${p.slug}/">${esc(p.label)}</a></li>`).join('')}</ul></div>
      <div><h3>Company</h3><ul><li><a href="/about/">About Apbiz</a></li><li><a href="/contact/">Contact</a></li><li><a href="/services/">All services</a></li><li><a href="/blog/">Blog</a></li><li><a href="${SITE.software}/" rel="noopener">Login to IBMP</a></li></ul></div>
    </div>
  </div>
  <div class="container legal">
    <div class="lrow"><div class="lleft"><p>&copy; 2026 ${esc(SITE.legal)}. All rights reserved.</p><nav aria-label="Legal"><a href="${SITE.software}/privacy">Privacy Policy</a><a href="${SITE.software}/terms">Terms of Service</a><a href="/sitemap.xml">Sitemap</a></nav></div><div class="fsocial">${SOCIALS}</div></div>
  </div>
  <div class="wordmark" aria-hidden="true">apbiz</div>
</footer>
</body>
</html>
`;
  const file = path.join(OUT, p === '/' ? 'index.html' : p.endsWith('.html') ? p.slice(1) : path.join(p, 'index.html'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return p;
}

const crumbs = (items) => `<nav class="crumbs" aria-label="Breadcrumb">${items.map(([n, u], i) => (i === items.length - 1 ? `<span aria-current="page">${esc(n)}</span>` : `<a href="${u}">${esc(n)}</a>`)).join('<span class="sep">/</span>')}</nav>`;
const faqHtml = (faq) => `<div class="faq">${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`;
const checks = (list) => `<ul class="checks">${list.map((x) => `<li>${icon('check', 18)}<span>${esc(x)}</span></li>`).join('')}</ul>`;
const cta = (title, text, about = 'compliance') => `<section class="cta"><div class="pattern" aria-hidden="true"></div>${RINGS}<div class="container reveal"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn white big" href="${wa(about)}" rel="noopener">${icon('whatsapp', 20)} Chat with us on WhatsApp</a><p class="alt">or write to <a href="mailto:${SITE.email}">${SITE.email}</a></p></div></section>`;
const serviceCard = (s) => `<a class="svc glow reveal" href="/services/${s.slug}/"><span class="ico">${icon(s.icon, 24)}</span><h3>${esc(s.name)}</h3><p>${esc(s.short)}</p><span class="more">Learn more ${icon('arrow', 16)}</span></a>`;

// Floating tags. They live in two side gutters (home: both sides, one tag per row; inner pages: two columns on the right), so they never sit behind
// the text or the badge frame, and each row is taller than a tag plus its drift. depth 1 = far (faint, small), 3 = near (bright, large).
const HOME_ROWS = [13, 24, 35, 46, 57, 68, 79, 90];
const INNER_SLOTS = [[2, 12], [13, 22], [2, 36], [13, 46], [2, 60], [13, 70], [2, 84], [13, 92]];   // [offset from the right edge %, top %]
function floaters(tags, { inner = false, seals = true } = {}) {
  return `<div class="floaters" aria-hidden="true">${tags.map(([label, depth], i) => {
    let side = 'r', x, y;
    if (inner) [x, y] = INNER_SLOTS[i % INNER_SLOTS.length];
    else { side = i % 2 ? 'r' : 'l'; const row = Math.floor(i / 2) % HOME_ROWS.length; y = HOME_ROWS[row] + (side === 'r' ? 4 : 0); x = side === 'l' ? (row % 2 ? 3 : 1) : (row % 2 ? 1 : 3); }
    return `<span class="tag ${side} d${depth}" style="--x:${x}%;--y:${y}%;--delay:${(i * 0.37).toFixed(2)}s;--dur:${(6 + (i % 5)).toFixed(0)}s;--k:${depth}"><span class="chip">${esc(label)}${seals ? seal : ''}</span></span>`;
  }).join('')}</div>`;
}
const phero = (inner, tags) => `<section class="phero"><div class="pattern" aria-hidden="true"></div><div class="pattern lit" aria-hidden="true"></div>${tags ? floaters(tags.map((t, i) => [t, (i % 3) + 1]), { inner: true }) : ''}<div class="container">${inner}</div></section>`;

// ---------- home ----------
function home() {
  const badges = BADGES.map((b, i) => `<li style="--i:${i}"><span class="ring">${esc(b)}</span>${seal}</li>`).join('');
  const marq = (row, rev) => { const items = row.map((t) => `<span class="mtag">${esc(t)}</span>`).join(''); return `<div class="mrow${rev ? ' rev' : ''}"><div class="track">${items}${items.replace(/class="mtag"/g, 'class="mtag" aria-hidden="true"')}</div></div>`; };
  const who = [
    ['rocket', 'Startups and private limited companies', 'Incorporation, annual ROC filings and clean books before the first investor asks for them.'],
    ['store', 'Traders and SMEs', 'GST on every invoice, TDS on the right payments and no surprises at the year-end.'],
    ['briefcase', 'LLPs, firms and professionals', 'Partner returns, LLP filings, tax audit support and planning for practices and partnerships.'],
    ['globe', 'Exporters and online sellers', 'LUT, refunds, e-invoicing, e-way bills and marketplace tax collection handled correctly.'],
  ];
  const why = [
    ['One accountable team', 'GST, tax, company law and payroll handled together, so nothing falls between advisers and your numbers agree across every filing.'],
    ['Nothing missed', 'We map exactly which filings apply to your business, track every deadline and remind you ahead of time.'],
    ['Plain language', 'You get an explanation of what is being filed and why, in words a business owner can use, not only an acknowledgement number.'],
    ['Records ready for scrutiny', 'Banks, investors, auditors and officers ask for the same papers. We keep them organised so that you can hand them over the same day.'],
  ];
  // two brand themes (navy and yellow) alternate; see [data-t] in styles.css
  const TAB = { gst: 'GST', 'income-tax': 'Income tax', tds: 'TDS / TCS', 'company-law': 'Company law', 'pf-esi': 'PF / ESI / PT', payroll: 'Payroll', registrations: 'Registrations', accounting: 'Accounting', 'startup-india': 'Startup India', msme: 'MSME', 'fssai-licences': 'FSSAI and licences', valuation: 'Valuation', 'iso-certification': 'ISO' };
  const pad = (n) => String(n).padStart(2, '0');
  const tabs = SERVICES.map((s, i) => `<button type="button" role="tab" data-t="${i % 2}" id="t-${s.slug}" aria-controls="p-${s.slug}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${icon(s.icon, 20)}<span>${esc(TAB[s.slug] || s.name)}</span></button>`).join('');
  const panels = SERVICES.map((s, i) => `<article class="epanel" data-t="${i % 2}" role="tabpanel" id="p-${s.slug}" aria-labelledby="t-${s.slug}">
    <div class="eleft"><span class="ico big">${icon(s.icon, 30)}</span><p class="enum">${pad(i + 1)} / ${pad(SERVICES.length)}</p><h3>${esc(s.name)}</h3><p>${esc(s.short)}</p><div class="actions"><a class="btn dark" href="/services/${s.slug}/">Explore ${esc(TAB[s.slug] || s.name)}</a><a class="btn outline" href="${wa(s.wa)}" rel="noopener">Ask on WhatsApp</a></div></div>
    <div class="eright"><h4>What we do</h4><ul class="checks">${s.includes.slice(0, 5).map(([t]) => `<li>${icon('check', 18)}<span>${esc(t)}</span></li>`).join('')}</ul><div class="etags" aria-hidden="true">${(SERVICE_TAGS[s.slug] || []).slice(0, 6).map((t) => `<span>${esc(t)}</span>`).join('')}</div></div>
  </article>`).join('');
  const body = `
<section class="hero">
  <div class="pattern" aria-hidden="true"></div><div class="pattern lit" aria-hidden="true"></div>
  ${floaters(HERO_TAGS)}
  <div class="container heroin">
    <p class="eyebrow">Compliance services for Indian businesses</p>
    <h1>Every Indian deadline, <span class="hl">handled</span> before it arrives.</h1>
    <p class="lead">Apbiz looks after tax, company law, payroll, licences, Startup India, MSME, valuation and ISO certification for startups, traders and growing companies, so you can run the business instead of the paperwork.</p>
    <div class="ctawrap">
      <a class="btn white big" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 20)} Chat on WhatsApp</a>
      <svg class="doodle" viewBox="0 0 140 64" aria-hidden="true"><path d="M132 8C112-8 84 14 100 30c13 12-22 22-62 12"/><path d="M50 30L36 42l16 8"/></svg>
    </div>
    <div class="frame badges"><ul>${badges}</ul><p class="cap">Thirteen service areas. Every filing.</p></div>
  </div>
</section>

<section class="marquee" aria-label="Filings we handle">
  ${marq(MARQUEE[0], false)}${marq(MARQUEE[1], true)}
</section>

<section class="section handle" id="services">
  <div class="bgdeco" aria-hidden="true"><i class="orb o1"></i><i class="orb o2"></i><i class="orb o3"></i><i class="shp ring"></i><i class="shp plus"></i><i class="shp sq"></i><i class="shp dots"></i><i class="shp tri"></i></div>
  <div class="container">
    <div class="head reveal"><p class="eyebrow dark">What we handle</p><h2>Everything a growing Indian business has to file.</h2><p>Thirteen service areas, one point of contact. Pick one to see what is included.</p></div>
    <div class="explorer reveal">
      <div class="etabs" role="tablist" aria-label="Services">${tabs}</div>
      <div class="epanels">${panels}</div>
      <div class="enav" aria-label="Browse services"><button type="button" class="eprev" aria-label="Previous service">${icon("arrow", 18)}</button><div class="eprog" aria-hidden="true"><i></i></div><button type="button" class="enext" aria-label="Next service">${icon("arrow", 18)}</button></div>
    </div>
  </div>
</section>

<section class="section why">
  <div class="pattern" aria-hidden="true"></div><div class="bgdeco" aria-hidden="true"><i class="orb w1"></i><i class="orb w2"></i></div>
  <div class="container">
    <div class="head reveal"><p class="eyebrow">Why Apbiz</p><h2>Compliance that stays out of your way.</h2><p>Four things we promise every client, whatever the size of the business.</p></div>
    <div class="grid4 whygrid">${why.map(([t, d], i) => `<div class="wcard glow reveal" style="--rd:${i * 90}ms"><span class="bignum" aria-hidden="true">0${i + 1}</span><span class="wicon">${icon(["users", "clock", "chat", "folder"][i], 24)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div>
</section>

<section class="section stages">
  <div class="bgdeco" aria-hidden="true"><i class="orb s1"></i><i class="orb s2"></i>${RINGS}<i class="shp plus"></i><i class="shp dots"></i></div>
  <div class="container">
    <div class="head reveal"><h2>Built for every stage of your <span class="grad">business</span>.</h2><p>Whether you registered last month or have been filing for twenty years, Apbiz fits the way you work.</p></div>
    <div class="stagebox reveal">
      <div class="stagevis" aria-hidden="true">
        <div class="svis on" data-s="0"><div class="scard"><div class="schead"><strong>Startup set-up</strong><span class="spill">4 of 6 done</span></div>
          <ul class="srows">
            <li class="done"><i></i><span>Company incorporated</span><em>Done</em></li>
            <li class="done"><i></i><span>PAN, TAN and bank account</span><em>Done</em></li>
            <li class="done"><i></i><span>GST registration</span><em>Done</em></li>
            <li class="done"><i></i><span>Books and bank feeds</span><em>Done</em></li>
            <li class="doing"><i></i><span>DPIIT recognition</span><em>In progress</em></li>
            <li><i></i><span>Investor-ready records</span><em>Next</em></li>
          </ul><div class="sbar"><b style="width:66%"></b></div></div><p class="scap">Illustration</p></div>
        <div class="svis" data-s="1"><div class="scard"><div class="schead"><strong>This month’s filings</strong><span class="spill ok">On track</span></div>
          <ul class="srows tags">
            <li><span>GSTR-1</span><em class="t green">Filed</em></li>
            <li><span>GSTR-3B</span><em class="t green">Filed</em></li>
            <li><span>TDS return</span><em class="t amber">Reminder sent</em></li>
            <li><span>PF and ESI</span><em class="t blue">In progress</em></li>
            <li><span>Payroll</span><em class="t violet">Ready to approve</em></li>
          </ul><div class="sbar"><b style="width:72%"></b></div></div><p class="scap">Illustration</p></div>
        <div class="svis" data-s="2"><div class="scard"><div class="schead"><strong>Audit readiness</strong><span class="spill ok">Ready</span></div>
          <div class="sring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" class="trk"/><circle cx="60" cy="60" r="50" class="val"/></svg><div><b>94%</b><small>records ready</small></div></div>
          <ul class="stiles"><li><i></i>ROC filings</li><li><i></i>Books reconciled</li><li><i></i>Valuation report</li><li><i></i>ISO documents</li></ul></div><p class="scap">Illustration</p></div>
      </div>
      <div class="slist">
        ${STAGES.map((s, i) => `<div class="sitem${i === 0 ? ' open' : ''}" data-s="${i}"><button type="button" class="shead" id="sh-${i}" aria-expanded="${i === 0}" aria-controls="sb-${i}"><span class="stag">${esc(s.tag)}</span><span class="stitle">${esc(s.title)}</span><span class="chev" aria-hidden="true"></span></button><div class="sbody" id="sb-${i}" role="region" aria-labelledby="sh-${i}"><div><p>${esc(s.text)}</p><a class="slink" href="${s.link}">${esc(s.label)} ${icon('arrow', 16)}</a></div></div></div>`).join('')}
      </div>
    </div>
  </div>
</section>

<section class="section how">
  <div class="bgdeco" aria-hidden="true"><i class="orb h1"></i><i class="orb h2"></i>${RINGS}<i class="shp ring"></i><i class="shp plus"></i><i class="shp dots"></i></div>
  <div class="container">
    <div class="head reveal"><p class="eyebrow dark">How it works</p><h2>Three steps, then it runs.</h2><p>No long onboarding and no forms to fill. You start with a conversation.</p></div>
    <ol class="flow reveal">
      ${[['chat', 'Tell us about your business', 'What you sell, where you are registered and how many people you employ. A short WhatsApp conversation is enough to begin.'], ['filecheck', 'We take over your filings', 'We list every filing that applies, take over the ones you hand to us and agree what we need from you and when.'], ['bell', 'You stay informed, not busy', 'Reminders before every deadline, a confirmation after every filing and a tidy record whenever you need it.']].map(([ic, t, d], i) => `<li class="fstep" data-t="${[0, 0, 1][i]}"><span class="fn">${i + 1}</span><span class="fico">${icon(ic, 26)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}
    </ol>
  </div>
</section>

<section class="section who">
  <div class="bgdeco" aria-hidden="true"><i class="orb x1"></i><i class="orb x2"></i><i class="shp sq"></i><i class="shp tri"></i></div>
  <div class="container">
    <div class="head reveal"><p class="eyebrow dark">Who we work with</p><h2>Built for how Indian businesses actually run.</h2></div>
    <div class="grid4">${who.map(([ic, t, d], i) => `<div class="wcard whocard glow reveal" style="--rd:${i * 80}ms" data-t="${i % 2}"><span class="ico">${icon(ic, 24)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p><span class="wline" aria-hidden="true"></span></div>`).join('')}</div>
  </div>
</section>

<section class="section faq-sec">
  <div class="bgdeco" aria-hidden="true"><svg class="squig" viewBox="0 0 400 120" fill="none" stroke-linecap="round"><path d="M4 70c40-60 80 50 120 0s80-50 120 0 80 50 150-30"/></svg><i class="shp ring"></i><i class="shp dots"></i></div>
  <div class="container faqwrap">
    <div class="faqside reveal">
      <p class="eyebrow dark">Questions</p><h2>Frequently asked questions.</h2>
      <p>Straight answers to what owners ask us most. Cannot find yours? Ask us directly and we will reply in plain words.</p>
      <a class="btn wa" href="${wa('a question')}" rel="noopener">${icon('whatsapp', 18)} Ask on WhatsApp</a>
    </div>
    <div class="reveal">${faqHtml(FAQ_HOME)}</div>
  </div>
</section>

<section class="section software-sec">
  <div class="container">
    <div class="swpanel reveal">
      <div class="pattern" aria-hidden="true"></div>${RINGS}
      <div class="swtext"><p class="eyebrow">Software</p><h2>Prefer to keep your own books?</h2><p>IBMP is our software for Indian businesses: GST invoices and returns, purchases, ledger, payroll, TDS and reminders, in one place. Use it yourself, or let us work inside it for you.</p><div class="actions"><a class="btn white" href="${SITE.software}/" rel="noopener">Try IBMP</a><a class="btn ghost" href="${SITE.software}/" rel="noopener">Login</a></div></div>
      <div class="chipcloud" aria-hidden="true"><span>GST invoices</span><span>Returns</span><span>Ledger</span><span>Payroll</span><span>TDS</span><span>Reminders</span><span>E-way bills</span><span>Reports</span></div>
    </div>
  </div>
</section>
${cta('Tell us what you need.', 'One message on WhatsApp is the easiest way to start. Tell us about your business and we will tell you which filings apply.')}`;
  page({ path: '/', title: 'Apbiz: GST, Income Tax, TDS and Company Compliance in India', desc: 'Apbiz handles GST, income tax, TDS, ROC and company law, PF, ESI and payroll for Indian businesses. Filed on time and explained in plain language.', body, schema: [orgSchema, faqSchema(FAQ_HOME)], home: true });
}

// ---------- services ----------
function servicesHub() {
  const body = `
${phero(`${crumbs([['Home', '/'], ['Services', '/services/']])}<h1>Compliance services for Indian businesses</h1><p class="lead">Tax, company law, payroll, licences, Startup India, MSME, valuation and ISO certification from one team. Choose what you need, or let us look at the whole picture.</p><div class="actions"><a class="btn white big" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 20)} Chat on WhatsApp</a></div>`, ['GST', 'TDS', 'ITR', 'ROC', 'PF', 'ESI', 'PT', 'MSME'])}
<section class="section"><div class="container"><div class="grid4">${SERVICES.map(serviceCard).join('')}</div></div></section>
<section class="section alt"><div class="container narrow"><div class="head reveal"><h2>Not sure what applies to you?</h2><p>The filings you need depend on what you sell, where you are registered, how large you are and whether you have employees. Tell us the basics and we will list exactly what applies to you.</p></div></div></section>
${cta('Get your list of filings.', 'Message us the type of business, your state and whether you have staff. We will reply with what applies to you.')}`;
  page({ path: '/services/', title: 'Compliance Services in India: GST, Tax, TDS, ROC, PF and ESI | Apbiz', desc: 'All Apbiz services: GST, income tax, TDS and TCS, company law (ROC/MCA), PF, ESI and professional tax, payroll, registrations and licences, and accounting.', body, schema: [crumbSchema([['Home', '/'], ['Services', '/services/']])] });
}

function servicePage(s) {
  const url = `/services/${s.slug}/`;
  const body = `
${phero(`${crumbs([['Home', '/'], ['Services', '/services/'], [s.name, url]])}<h1>${esc(s.h1)}</h1><p class="lead">${esc(s.lead)}</p><div class="actions"><a class="btn white big" href="${wa(s.wa)}" rel="noopener">${icon('whatsapp', 20)} Ask about ${esc(s.name)}</a><a class="btn ghost big" href="#includes">What we do</a></div>`, SERVICE_TAGS[s.slug])}
<div class="container article">
  <article class="prose">
    ${s.intro.map((t) => `<p>${esc(t)}</p>`).join('')}
    <h2 id="includes">What we do</h2>
    <div class="includes">${s.includes.map(([t, d]) => `<div class="glow reveal"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
    <h2>Who this is for</h2>
    ${checks(s.who)}
    <h2>How it works</h2>
    <ol class="steps small">${s.steps.map(([t, d], i) => `<li class="reveal"><span class="n">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol>
    <h2>What we usually need from you</h2>
    ${checks(s.docs)}
    <h2>Frequently asked questions</h2>
    ${faqHtml(s.faq)}
    <p class="disclaimer">This page is general information and not advice for your situation. Rates, limits and due dates change, and some depend on your state or scheme, so we confirm the current rules for your case before we act.</p>
  </article>
  <aside class="side">
    <div class="box"><h3>Talk to us about ${esc(s.name)}</h3><p>Tell us about your business and what you need. We will tell you what applies and what it takes.</p><a class="btn wa full" href="${wa(s.wa)}" rel="noopener">${icon('whatsapp', 18)} Chat on WhatsApp</a><p class="small">${esc(SITE.phone)}<br><a href="mailto:${SITE.email}">${SITE.email}</a></p></div>
    <div class="box"><h3>Related services</h3><ul class="rel">${s.related.map((r) => `<li><a href="/services/${r}/">${esc(service(r).name)}</a></li>`).join('')}<li><a href="/services/">All services</a></li></ul></div>
  </aside>
</div>
${cta(`Need help with ${s.name}?`, 'Send us a message with the basics. We will tell you what applies, what it takes and what it costs, before you commit.', s.wa)}`;
  page({
    path: url, title: s.title, desc: s.desc, body,
    schema: [crumbSchema([['Home', '/'], ['Services', '/services/'], [s.name, url]]), faqSchema(s.faq),
      { '@context': 'https://schema.org', '@type': 'Service', name: s.name, serviceType: s.name, provider: { '@type': 'ProfessionalService', name: SITE.name, url: SITE.url }, areaServed: { '@type': 'Country', name: 'India' }, description: s.desc, url: SITE.url + url }],
  });
}

// ---------- other pages ----------
function about() {
  const body = `
${phero(`${crumbs([['Home', '/'], ['About', '/about/']])}<h1>Compliance, done carefully and explained clearly.</h1><p class="lead">${esc(SITE.legal)} helps Indian businesses meet their tax, company law and labour obligations without losing sight of the business itself.</p>`, ['GST', 'TDS', 'ROC', 'PF', 'ITR', 'ESI'])}
<section class="section"><div class="container narrow prose">
  <h2>Who we are</h2>
  <p>Apbiz is a compliance consultancy run by ${esc(SITE.legal)}. We work with startups, traders, professionals and growing companies that need dependable help with GST, income tax, TDS, company law, PF, ESI, payroll and the registrations that sit behind them.</p>
  <h2>What we believe</h2>
  <div class="includes">
    <div class="glow reveal"><h3>Be early</h3><p>Most compliance penalties come from delay, not from difficulty. We work to a schedule and ask for what we need before the date, not on it.</p></div>
    <div class="glow reveal"><h3>Be clear</h3><p>You should understand what is filed in your name. We explain in plain words what a filing is, why it is due and what it costs.</p></div>
    <div class="glow reveal"><h3>Be careful</h3><p>We do not file anything in your name without your approval, and we tell you when the rules are unclear instead of guessing.</p></div>
  </div>
  <h2>How we work</h2>
  <p>Most of the work is online: WhatsApp for quick questions, email for documents and calls when something needs talking through. The government portals themselves are online, so your location rarely matters. When a task needs someone to visit an office, we will say so before we start.</p>
  <h2>Our software</h2>
  <p>We also build IBMP, an accounting and compliance platform for Indian businesses with GST invoicing, returns, ledger, payroll, TDS and reminders. You can use it yourself or have us work inside it for you. <a href="${SITE.software}" rel="noopener">Take a look at IBMP</a>.</p>
</div></section>
${cta('Let us look after your compliance.', 'Tell us about your business on WhatsApp and we will tell you which filings apply and what it takes to keep them on time.')}`;
  page({ path: '/about/', title: ABOUT.title, desc: ABOUT.desc, body, schema: [crumbSchema([['Home', '/'], ['About', '/about/']])] });
}

function contact() {
  const body = `
${phero(`${crumbs([['Home', '/'], ['Contact', '/contact/']])}<h1>Talk to Apbiz</h1><p class="lead">The quickest way to reach us is WhatsApp. Tell us about your business and what you need, and we will reply with what applies and how we can help.</p><div class="actions"><a class="btn white big" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 20)} WhatsApp ${esc(SITE.phone)}</a></div>`, ['Hello', 'GST', 'TDS', 'ITR', 'ROC', 'PF'])}
<section class="section"><div class="container twocol">
  <div class="prose"><h2>What to send in your first message</h2>${checks(['The type of business: proprietorship, partnership, LLP or company', 'The state you operate in and whether you have a GST number', 'The services you need, for example GST returns or ROC filings', 'Any deadline you are worried about, or notice you have received', 'The number of employees, if any'])}<p>You do not need to send documents in the first message. We will ask for those only when the work needs them.</p></div>
  <div class="box wide"><h3>Reach us</h3><ul class="rel"><li><strong>WhatsApp:</strong> <a href="${wa('compliance')}" rel="noopener">${esc(SITE.phone)}</a></li><li><strong>Email:</strong> <a href="mailto:${SITE.email}">${SITE.email}</a></li><li><strong>Company:</strong> ${esc(SITE.legal)}</li></ul><p class="small">If you have received a government notice, send us a photo or a PDF of it along with the date it arrived. Reply periods are short.</p></div>
</div></section>`;
  page({ path: '/contact/', title: 'Contact Apbiz: Talk to a Compliance Expert on WhatsApp', desc: 'Contact Apbiz for GST, income tax, TDS, ROC and payroll compliance. Message us on WhatsApp or email and we will tell you which filings apply to your business.', body, schema: [crumbSchema([['Home', '/'], ['Contact', '/contact/']])] });
}

function notFound() {
  const body = `<section class="phero"><div class="pattern" aria-hidden="true"></div><div class="container"><h1>That page could not be found.</h1><p class="lead">It may have moved. Try the services list, or message us and we will point you to the right place.</p><div class="actions"><a class="btn white big" href="/">Go to the home page</a><a class="btn ghost big" href="/services/">All services</a></div></div></section>`;
  page({ path: '/404.html', title: 'Page not found | Apbiz', desc: 'This page could not be found.', body, noindex: true });
}

// ---------- blog ----------
const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
function blogIndex() {
  const cards = POSTS.map((p, i) => `<a class="post glow reveal" style="--rd:${(i % 3) * 80}ms" href="/blog/${p.slug}/"><span class="cat">${esc(p.category)}</span><h3>${esc(p.h1)}</h3><p>${esc(p.desc)}</p><span class="meta">${fmtDate(p.date)} · ${p.minutes} min read</span><span class="more">Read article ${icon('arrow', 16)}</span></a>`).join('');
  const body = `
${phero(`${crumbs([['Home', '/'], ['Blog', '/blog/']])}<h1>Compliance guides for Indian businesses</h1><p class="lead">Plain-language explanations of GST, tax, company law, licences, Startup India and certifications, written by the team that files them.</p>`, ['GST', 'ROC', 'DPIIT', 'FSSAI', 'ISO', 'ITR'])}
<section class="section"><div class="container"><div class="grid3">${cards}</div></div></section>
${cta('Have a question we have not covered?', 'Ask us on WhatsApp. We answer in plain words and tell you what applies to your business.')}`;
  page({ path: '/blog/', title: 'Blog: GST, Tax, ROC and Licence Guides for India | Apbiz', desc: 'Plain-language guides on GST returns, company compliance, DPIIT and Startup India, FSSAI, ISO certification and tax notices for Indian businesses.', body, schema: [crumbSchema([['Home', '/'], ['Blog', '/blog/']])] });
}
function blogPost(p) {
  const url = `/blog/${p.slug}/`, s = service(p.service);
  const sections = p.body.map((b) => `<h2>${esc(b.h)}</h2>${(b.p || []).map((t) => `<p>${esc(t)}</p>`).join('')}${b.list ? checks(b.list) : ''}`).join('');
  const others = POSTS.filter((o) => o.slug !== p.slug).sort((a, b) => (b.service === p.service) - (a.service === p.service)).slice(0, 4);
  const body = `
${phero(`${crumbs([['Home', '/'], ['Blog', '/blog/'], [p.category, url]])}<p class="eyebrow">${esc(p.category)} · ${fmtDate(p.date)} · ${p.minutes} min read</p><h1>${esc(p.h1)}</h1><p class="lead">${esc(p.lead)}</p>`, null)}
<div class="container article">
  <article class="prose">
    ${sections}
    <h2>Quick answers</h2>${faqHtml(p.faq)}
    <p class="disclaimer">This article is general information, not advice for your situation. Rules, limits and due dates change, so we confirm the current position before you act on it.</p>
  </article>
  <aside class="side">
    <div class="box"><h3>Need help with ${esc(s.name)}?</h3><p>Tell us about your business and we will tell you what applies and what it takes.</p><a class="btn wa full" href="${wa(s.wa)}" rel="noopener">${icon('whatsapp', 18)} Chat on WhatsApp</a><p class="small"><a href="/services/${s.slug}/">See our ${esc(s.name)} service</a></p></div>
    <div class="box"><h3>More guides</h3><ul class="rel">${others.map((o) => `<li><a href="/blog/${o.slug}/">${esc(o.h1)}</a></li>`).join('')}<li><a href="/blog/">All articles</a></li></ul></div>
  </aside>
</div>
${cta(`Talk to us about ${s.name}.`, 'Send us the basics on WhatsApp. We will reply with what applies and how we can help.', s.wa)}`;
  page({
    path: url, title: p.title, desc: p.desc, body,
    schema: [crumbSchema([['Home', '/'], ['Blog', '/blog/'], [p.category, url]]), faqSchema(p.faq),
      { '@context': 'https://schema.org', '@type': 'Article', headline: p.h1, description: p.desc, datePublished: p.date, dateModified: p.date, inLanguage: 'en-IN', mainEntityOfPage: SITE.url + url, author: { '@type': 'Organization', name: SITE.name, url: SITE.url }, publisher: { '@type': 'Organization', name: SITE.legal, url: SITE.url } }],
  });
}

// ---------- build ----------
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });      // empty the folder, not the folder itself (a preview server may be using it)
home(); servicesHub(); SERVICES.forEach(servicePage); blogIndex(); POSTS.forEach(blogPost); about(); contact(); notFound();
for (const f of ['styles.css', 'app.js', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'logo.svg', 'logo-dark.svg', 'logo-symbol.svg', 'logo-symbol-dark.svg']) fs.copyFileSync(path.join(here, f), path.join(OUT, f));
const urls = ['/', '/services/', ...SERVICES.map((s) => `/services/${s.slug}/`), '/blog/', ...POSTS.map((p) => `/blog/${p.slug}/`), '/about/', '/contact/'];
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE.url}${u}</loc><lastmod>${SITE.updated}</lastmod></url>`).join('\n')}\n</urlset>\n`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);
console.log(`built ${urls.length + 1} pages into ${OUT}`);
