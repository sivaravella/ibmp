// Builds the Apbiz website into sites/apbiz/site/ (plain HTML and one stylesheet, no scripts).
//   node sites/apbiz/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABOUT, DATES, FAQ_HOME, SERVICES, SITE } from './content.mjs';

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
};
const icon = (n, size = 22) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;

const jsonld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const faqSchema = (faq) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
const crumbSchema = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE.url + url })) });
const orgSchema = { '@context': 'https://schema.org', '@type': 'ProfessionalService', name: SITE.name, legalName: SITE.legal, url: SITE.url, email: SITE.email, telephone: SITE.phone, areaServed: { '@type': 'Country', name: 'India' }, description: 'Compliance services for Indian businesses: GST, income tax, TDS, company law, PF, ESI and payroll.' };

const FOOT_SERVICES = SERVICES.map((s) => `<li><a href="/services/${s.slug}/">${esc(s.name)}</a></li>`).join('');
const NAV_MENU = SERVICES.map((s) => `<a href="/services/${s.slug}/">${esc(s.name)}</a>`).join('');

function page({ path: p, title, desc, body, schema = [], noindex = false }) {
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
<meta name="theme-color" content="#0f2747">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
${schema.map(jsonld).join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="container bar">
    <a class="brand" href="/" aria-label="Apbiz home"><span class="mark">A</span><span>Apbiz</span></a>
    <nav class="main" aria-label="Main">
      <div class="has-menu"><a href="/services/" aria-haspopup="true">Services <span class="caret" aria-hidden="true"></span></a><div class="menu">${NAV_MENU}<a class="all" href="/services/">All services</a></div></div>
      <a href="/due-dates/">Due dates</a>
      <a href="/about/">About</a>
      <a href="/contact/">Contact</a>
    </nav>
    <a class="btn wa small" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 18)} WhatsApp us</a>
    <details class="mnav"><summary aria-label="Menu"><span></span></summary>
      <div class="sheet">
        <p>Services</p>${NAV_MENU}
        <p>Company</p><a href="/due-dates/">Due dates</a><a href="/about/">About</a><a href="/contact/">Contact</a>
      </div>
    </details>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="container cols">
    <div class="fbrand">
      <a class="brand light" href="/"><span class="mark">A</span><span>Apbiz</span></a>
      <p>Compliance for Indian businesses: GST, income tax, TDS, company law, PF, ESI and payroll, filed on time and explained clearly.</p>
      <p><a class="plain" href="${wa('compliance')}" rel="noopener">WhatsApp ${esc(SITE.phone)}</a><br><a class="plain" href="mailto:${SITE.email}">${SITE.email}</a></p>
    </div>
    <div><h3>Services</h3><ul>${FOOT_SERVICES}</ul></div>
    <div><h3>Resources</h3><ul><li><a href="/due-dates/">Compliance due dates</a></li><li><a href="/services/">All services</a></li><li><a href="${SITE.software}" rel="noopener">IBMP software</a></li></ul>
      <h3>Company</h3><ul><li><a href="/about/">About Apbiz</a></li><li><a href="/contact/">Contact</a></li><li><a href="${SITE.software}/privacy">Privacy Policy</a></li><li><a href="${SITE.software}/terms">Terms of Service</a></li></ul></div>
  </div>
  <div class="container legal">
    <p>&copy; 2026 ${esc(SITE.legal)}. All rights reserved.</p>
    <p>The information on this website is general and is not legal or tax advice for your situation. Tax rates, limits and due dates change, so we confirm the current position for you before you rely on it.</p>
  </div>
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
const cta = (title, text, about = 'compliance') => `<section class="cta"><div class="container"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn wa big" href="${wa(about)}" rel="noopener">${icon('whatsapp', 20)} Chat with us on WhatsApp</a><p class="alt">or write to <a href="mailto:${SITE.email}">${SITE.email}</a></p></div></section>`;
const serviceCard = (s) => `<a class="svc" href="/services/${s.slug}/"><span class="ico">${icon(s.icon, 24)}</span><h3>${esc(s.name)}</h3><p>${esc(s.short)}</p><span class="more">Learn more ${icon('arrow', 16)}</span></a>`;

// ---------- home ----------
function home() {
  const calendar = `<div class="calcard" aria-label="Illustrative compliance calendar">
    <div class="calhead"><strong>Your compliance calendar</strong><span>Illustration</span></div>
    <ul>
      <li><span class="d">7th</span><span class="t">TDS and TCS payment</span><span class="pill ok">Filed</span></li>
      <li><span class="d">11th</span><span class="t">GSTR-1 sales return</span><span class="pill ok">Filed</span></li>
      <li><span class="d">15th</span><span class="t">PF and ESI contributions</span><span class="pill wip">In progress</span></li>
      <li><span class="d">20th</span><span class="t">GSTR-3B and tax payment</span><span class="pill next">Upcoming</span></li>
      <li><span class="d">31st</span><span class="t">TDS quarterly return</span><span class="pill next">Upcoming</span></li>
    </ul>
    <p>Every date that applies to your business, tracked and reminded.</p>
  </div>`;
  const body = `
<section class="hero">
  <div class="container herogrid">
    <div>
      <p class="eyebrow">Compliance services for Indian businesses</p>
      <h1>Indian compliance, filed on time and explained clearly.</h1>
      <p class="lead">Apbiz looks after GST, income tax, TDS, company law, PF, ESI and payroll for startups, traders and growing companies, so you can run the business instead of the calendar.</p>
      <div class="actions"><a class="btn wa big" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 20)} Chat on WhatsApp</a><a class="btn ghost big" href="/services/">Explore services</a></div>
      <ul class="trust"><li>${icon('check', 18)} One team for every filing</li><li>${icon('check', 18)} Reminders before every due date</li><li>${icon('check', 18)} Plain-language advice</li></ul>
    </div>
    ${calendar}
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="head"><p class="eyebrow dark">What we handle</p><h2>Everything a growing Indian business has to file.</h2><p>Eight service areas, one point of contact. Start with what you need today and add more as you grow.</p></div>
    <div class="grid4">${SERVICES.map(serviceCard).join('')}</div>
  </div>
</section>

<section class="section alt">
  <div class="container">
    <div class="head"><p class="eyebrow dark">Why Apbiz</p><h2>Compliance that stays out of your way.</h2></div>
    <div class="grid4 why">
      <div><h3>One accountable team</h3><p>GST, tax, company law and payroll handled together, so nothing falls between advisers and your numbers agree across every filing.</p></div>
      <div><h3>A calendar built for you</h3><p>We map exactly which filings apply to your business and put every due date on one calendar, with reminders ahead of time.</p></div>
      <div><h3>Plain language</h3><p>You get an explanation of what is being filed and why, in words a business owner can use, not only an acknowledgement number.</p></div>
      <div><h3>Records ready for scrutiny</h3><p>Banks, investors, auditors and officers ask for the same papers. We keep them organised so that you can hand them over the same day.</p></div>
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="head"><p class="eyebrow dark">How it works</p><h2>Three steps, then it runs.</h2></div>
    <ol class="steps">
      <li><span class="n">1</span><h3>Tell us about your business</h3><p>What you sell, where you are registered and how many people you employ. A short WhatsApp conversation is enough to begin.</p></li>
      <li><span class="n">2</span><h3>We set up your calendar</h3><p>We list every filing that applies, take over the ones you hand to us and agree what we need from you and when.</p></li>
      <li><span class="n">3</span><h3>You stay informed, not busy</h3><p>Reminders before every deadline, a confirmation after every filing and a tidy record whenever you need it.</p></li>
    </ol>
  </div>
</section>

<section class="section alt">
  <div class="container">
    <div class="head"><p class="eyebrow dark">Who we work with</p><h2>Built for how Indian businesses actually run.</h2></div>
    <div class="grid4 who">
      <div><h3>Startups and private limited companies</h3><p>Incorporation, annual ROC filings and clean books before the first investor asks for them.</p></div>
      <div><h3>Traders and SMEs</h3><p>GST on every invoice, TDS on the right payments and no surprises at the year-end.</p></div>
      <div><h3>LLPs, firms and professionals</h3><p>Partner returns, LLP filings, tax audit support and planning for practices and partnerships.</p></div>
      <div><h3>Exporters and online sellers</h3><p>LUT, refunds, e-invoicing, e-way bills and marketplace tax collection handled correctly.</p></div>
    </div>
  </div>
</section>

<section class="section">
  <div class="container twocol">
    <div class="head left"><p class="eyebrow dark">Due dates</p><h2>The dates that matter, in one place.</h2><p>Most Indian businesses meet the same recurring deadlines. Here are the monthly ones. The full list, by month, quarter and year, is on our due-dates page.</p><a class="btn dark" href="/due-dates/">See all due dates</a></div>
    <div class="tablewrap"><table><thead><tr><th>Date</th><th>What is due</th></tr></thead><tbody>${DATES[0][1].map(([d, w]) => `<tr><td>${esc(d)}</td><td>${esc(w)}</td></tr>`).join('')}</tbody></table></div>
  </div>
</section>

<section class="section alt">
  <div class="container narrow">
    <div class="head"><p class="eyebrow dark">Questions</p><h2>Frequently asked questions.</h2></div>
    ${faqHtml(FAQ_HOME)}
  </div>
</section>

<section class="section">
  <div class="container software">
    <div><p class="eyebrow dark">Software</p><h2>Prefer to keep your own books?</h2><p>IBMP is our software for Indian businesses: GST invoices and returns, purchases, ledger, payroll, TDS and a compliance calendar with reminders, in one place. Use it yourself, or let us work inside it for you.</p><a class="btn dark" href="${SITE.software}" rel="noopener">Try IBMP</a></div>
  </div>
</section>
${cta('Tell us what you need.', 'One message on WhatsApp is the easiest way to start. Tell us about your business and we will tell you which filings apply.')}`;
  page({ path: '/', title: 'Apbiz: GST, Income Tax, TDS and Company Compliance in India', desc: 'Apbiz handles GST, income tax, TDS, ROC and company law, PF, ESI and payroll for Indian businesses. Filed on time and explained in plain language.', body, schema: [orgSchema, faqSchema(FAQ_HOME)] });
}

// ---------- services ----------
function servicesHub() {
  const body = `
<section class="phero"><div class="container">${crumbs([['Home', '/'], ['Services', '/services/']])}<h1>Compliance services for Indian businesses</h1><p class="lead">GST, income tax, TDS, company law, PF, ESI, payroll, registrations and accounting from one team. Choose what you need, or let us look at the whole picture.</p><div class="actions"><a class="btn wa big" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 20)} Chat on WhatsApp</a></div></div></section>
<section class="section"><div class="container"><div class="grid4">${SERVICES.map(serviceCard).join('')}</div></div></section>
<section class="section alt"><div class="container narrow"><div class="head"><h2>Not sure what applies to you?</h2><p>The filings you need depend on what you sell, where you are registered, how large you are and whether you have employees. Tell us the basics and we will list exactly what applies and when it is due.</p></div></div></section>
${cta('Get your list of filings.', 'Message us the type of business, your state and whether you have staff. We will reply with what applies to you.')}`;
  page({ path: '/services/', title: 'Compliance Services in India: GST, Tax, TDS, ROC, PF and ESI | Apbiz', desc: 'All Apbiz services: GST, income tax, TDS and TCS, company law (ROC/MCA), PF, ESI and professional tax, payroll, registrations and licences, and accounting.', body, schema: [crumbSchema([['Home', '/'], ['Services', '/services/']])] });
}

function servicePage(s) {
  const url = `/services/${s.slug}/`;
  const body = `
<section class="phero"><div class="container">${crumbs([['Home', '/'], ['Services', '/services/'], [s.name, url]])}<h1>${esc(s.h1)}</h1><p class="lead">${esc(s.lead)}</p><div class="actions"><a class="btn wa big" href="${wa(s.wa)}" rel="noopener">${icon('whatsapp', 20)} Ask about ${esc(s.name)}</a><a class="btn ghost big" href="#includes">What we do</a></div></div></section>
<div class="container article">
  <article class="prose">
    ${s.intro.map((t) => `<p>${esc(t)}</p>`).join('')}
    <h2 id="includes">What we do</h2>
    <div class="includes">${s.includes.map(([t, d]) => `<div><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
    <h2>Who this is for</h2>
    ${checks(s.who)}
    <h2>How it works</h2>
    <ol class="steps small">${s.steps.map(([t, d], i) => `<li><span class="n">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol>
    <h2>What we usually need from you</h2>
    ${checks(s.docs)}
    <h2>Frequently asked questions</h2>
    ${faqHtml(s.faq)}
    <p class="disclaimer">This page is general information and not advice for your situation. Rates, limits and due dates change, and some depend on your state or scheme, so we confirm the current rules for your case before we act.</p>
  </article>
  <aside class="side">
    <div class="box"><h3>Talk to us about ${esc(s.name)}</h3><p>Tell us about your business and what you need. We will tell you what applies and what it takes.</p><a class="btn wa full" href="${wa(s.wa)}" rel="noopener">${icon('whatsapp', 18)} Chat on WhatsApp</a><p class="small">${esc(SITE.phone)}<br><a href="mailto:${SITE.email}">${SITE.email}</a></p></div>
    <div class="box"><h3>Related services</h3><ul class="rel">${s.related.map((r) => `<li><a href="/services/${r}/">${esc(service(r).name)}</a></li>`).join('')}<li><a href="/due-dates/">Compliance due dates</a></li></ul></div>
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
function dueDates() {
  const body = `
<section class="phero"><div class="container">${crumbs([['Home', '/'], ['Due dates', '/due-dates/']])}<h1>India compliance due dates</h1><p class="lead">The recurring deadlines for GST, TDS, PF, ESI, advance tax, income tax and company filings, grouped by how often they fall.</p></div></section>
<section class="section"><div class="container narrow">
  <p class="notice"><strong>Please note.</strong> The government extends or changes dates from time to time, and some depend on your state, turnover or the scheme you have chosen. Treat this page as a guide and ask us for the exact dates for your business.</p>
  ${DATES.map(([group, rows]) => `<h2>${esc(group)}</h2><div class="tablewrap"><table><thead><tr><th>Date</th><th>What is due</th></tr></thead><tbody>${rows.map(([d, w]) => `<tr><td>${esc(d)}</td><td>${esc(w)}</td></tr>`).join('')}</tbody></table></div>`).join('')}
  <h2>Services behind these dates</h2>
  <div class="grid4 mini">${['gst', 'tds', 'income-tax', 'company-law', 'pf-esi'].map((sl) => `<a class="svc" href="/services/${sl}/"><h3>${esc(service(sl).name)}</h3><span class="more">Learn more ${icon('arrow', 16)}</span></a>`).join('')}</div>
</div></section>
${cta('Get your own compliance calendar.', 'Tell us about your business and we will send the exact dates that apply to you.')}`;
  page({ path: '/due-dates/', title: 'India Compliance Due Dates: GST, TDS, PF, ESI, Income Tax, ROC | Apbiz', desc: 'Monthly, quarterly and annual compliance due dates for Indian businesses: GSTR-1, GSTR-3B, TDS, PF, ESI, advance tax, income tax, AOC-4, MGT-7 and LLP filings.', body, schema: [crumbSchema([['Home', '/'], ['Due dates', '/due-dates/']])] });
}

function about() {
  const body = `
<section class="phero"><div class="container">${crumbs([['Home', '/'], ['About', '/about/']])}<h1>Compliance, done carefully and explained clearly.</h1><p class="lead">${esc(SITE.legal)} helps Indian businesses meet their tax, company law and labour obligations without losing sight of the business itself.</p></div></section>
<section class="section"><div class="container narrow prose">
  <h2>Who we are</h2>
  <p>Apbiz is a compliance consultancy run by ${esc(SITE.legal)}. We work with startups, traders, professionals and growing companies that need dependable help with GST, income tax, TDS, company law, PF, ESI, payroll and the registrations that sit behind them.</p>
  <h2>What we believe</h2>
  <div class="includes">
    <div><h3>Be early</h3><p>Most compliance penalties come from delay, not from difficulty. We work to a calendar and ask for what we need before the date, not on it.</p></div>
    <div><h3>Be clear</h3><p>You should understand what is filed in your name. We explain in plain words what a filing is, why it is due and what it costs.</p></div>
    <div><h3>Be careful</h3><p>We do not file anything in your name without your approval, and we tell you when the rules are unclear instead of guessing.</p></div>
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
<section class="phero"><div class="container">${crumbs([['Home', '/'], ['Contact', '/contact/']])}<h1>Talk to Apbiz</h1><p class="lead">The quickest way to reach us is WhatsApp. Tell us about your business and what you need, and we will reply with what applies and how we can help.</p><div class="actions"><a class="btn wa big" href="${wa('compliance')}" rel="noopener">${icon('whatsapp', 20)} WhatsApp ${esc(SITE.phone)}</a></div></div></section>
<section class="section"><div class="container twocol">
  <div class="prose"><h2>What to send in your first message</h2>${checks(['The type of business: proprietorship, partnership, LLP or company', 'The state you operate in and whether you have a GST number', 'The services you need, for example GST returns or ROC filings', 'Any deadline you are worried about, or notice you have received', 'The number of employees, if any'])}<p>You do not need to send documents in the first message. We will ask for those only when the work needs them.</p></div>
  <div class="box wide"><h3>Reach us</h3><ul class="rel"><li><strong>WhatsApp:</strong> <a href="${wa('compliance')}" rel="noopener">${esc(SITE.phone)}</a></li><li><strong>Email:</strong> <a href="mailto:${SITE.email}">${SITE.email}</a></li><li><strong>Company:</strong> ${esc(SITE.legal)}</li></ul><p class="small">If you have received a government notice, send us a photo or a PDF of it along with the date it arrived. Reply periods are short.</p></div>
</div></section>`;
  page({ path: '/contact/', title: 'Contact Apbiz: Talk to a Compliance Expert on WhatsApp', desc: 'Contact Apbiz for GST, income tax, TDS, ROC and payroll compliance. Message us on WhatsApp or email and we will tell you which filings apply to your business.', body, schema: [crumbSchema([['Home', '/'], ['Contact', '/contact/']])] });
}

function notFound() {
  const body = `<section class="phero"><div class="container"><h1>That page could not be found.</h1><p class="lead">It may have moved. Try the services list, or message us and we will point you to the right place.</p><div class="actions"><a class="btn dark big" href="/">Go to the home page</a><a class="btn ghost big" href="/services/">All services</a></div></div></section>`;
  page({ path: '/404.html', title: 'Page not found | Apbiz', desc: 'This page could not be found.', body, noindex: true });
}

// ---------- build ----------
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });      // empty the folder, not the folder itself (a preview server may be using it)
home(); servicesHub(); SERVICES.forEach(servicePage); dueDates(); about(); contact(); notFound();
fs.copyFileSync(path.join(here, 'styles.css'), path.join(OUT, 'styles.css'));
fs.copyFileSync(path.join(here, 'favicon.svg'), path.join(OUT, 'favicon.svg'));
const urls = ['/', '/services/', ...SERVICES.map((s) => `/services/${s.slug}/`), '/due-dates/', '/about/', '/contact/'];
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE.url}${u}</loc><lastmod>${SITE.updated}</lastmod></url>`).join('\n')}\n</urlset>\n`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);
console.log(`built ${urls.length + 1} pages into ${OUT}`);
