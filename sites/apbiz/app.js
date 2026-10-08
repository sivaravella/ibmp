/* Apbiz site behaviour: small, dependency-free, and optional. Without it every page still reads and works; this only adds motion.
   Nothing here collects data or talks to a server. Motion is skipped for anyone who asks their device to reduce it. */
(() => {
  const d = document, root = d.documentElement;
  root.classList.add('js');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, c = d) => c.querySelector(s), $$ = (s, c = d) => [...c.querySelectorAll(s)];

  // The header turns solid once you leave the top of the page.
  const top = $('.top');
  const onScroll = () => top && top.classList.toggle('scrolled', scrollY > 24);
  onScroll(); addEventListener('scroll', onScroll, { passive: true });

  // Sections and cards rise into view as they are scrolled to.
  const revealEls = $$('.reveal');
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach((el) => io.observe(el));
  } else revealEls.forEach((el) => el.classList.add('in'));

  // Hero: a light follows the pointer across the pattern (and wanders by itself when nobody is pointing),
  // while the floating filing tags drift at different depths, so near ones move more than far ones.
  const hero = $('.hero') || $('.phero');
  if (hero && !reduce) {
    const tags = $$('.tag', hero);
    let tx = 0.5, ty = 0.4, cx = tx, cy = ty, last = -1e9, visible = true;
    hero.addEventListener('pointermove', (e) => { const r = hero.getBoundingClientRect(); tx = (e.clientX - r.left) / r.width; ty = (e.clientY - r.top) / r.height; last = performance.now(); }, { passive: true });
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(hero);
    const tick = (t) => {
      if (visible) {
        if (t - last > 3000) { tx = 0.5 + 0.38 * Math.sin(t / 2600); ty = 0.42 + 0.26 * Math.sin(t / 1900 + 1); }
        cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
        hero.style.setProperty('--mx', (cx * 100).toFixed(2) + '%'); hero.style.setProperty('--my', (cy * 100).toFixed(2) + '%');
        const dx = cx - 0.5, dy = cy - 0.5;
        for (const g of tags) { const k = Number(g.style.getPropertyValue('--k')) || 1; g.style.transform = `translate3d(${(-dx * k * 12).toFixed(1)}px, ${(-dy * k * 9).toFixed(1)}px, 0)`; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Service explorer on the home page: a row of tabs above, the chosen service below; arrow keys and the prev/next buttons also work.
  $$('.explorer').forEach((ex) => {
    const tabs = $$('[role=tab]', ex), panels = $$('[role=tabpanel]', ex), bar = $('.eprog i', ex);
    let cur = 0;
    const show = (i, focus) => {
      cur = (i + tabs.length) % tabs.length;
      tabs.forEach((t, j) => { t.setAttribute('aria-selected', String(j === cur)); t.tabIndex = j === cur ? 0 : -1; });
      panels.forEach((p, j) => { p.hidden = j !== cur; });
      if (bar) bar.style.width = ((cur + 1) / tabs.length * 100).toFixed(1) + '%';
      if (focus) tabs[cur].focus();
      const t = tabs[cur], box = t.parentElement;
      if (box.scrollWidth > box.clientWidth) box.scrollTo({ left: t.offsetLeft - (box.clientWidth - t.offsetWidth) / 2, behavior: reduce ? 'auto' : 'smooth' });
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => show(i));
      t.addEventListener('keydown', (e) => {
        const k = e.key;
        if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); show(i + 1, true); }
        else if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); show(i - 1, true); }
        else if (k === 'Home') { e.preventDefault(); show(0, true); }
        else if (k === 'End') { e.preventDefault(); show(tabs.length - 1, true); }
      });
    });
    const prev = $('.eprev', ex), next = $('.enext', ex);
    if (prev) prev.addEventListener('click', () => show(cur - 1));
    if (next) next.addEventListener('click', () => show(cur + 1));
    show(0);
  });

  // "Built for every stage": one accordion item open at a time; the illustration on the left follows the open item.
  $$('.stagebox').forEach((box) => {
    const items = $$('.sitem', box), vis = $$('.svis', box);
    const open = (i) => items.forEach((it, j) => { const on = j === i; it.classList.toggle('open', on); $('.shead', it).setAttribute('aria-expanded', String(on)); if (vis[j]) vis[j].classList.toggle('on', on); });
    items.forEach((it, i) => $('.shead', it).addEventListener('click', () => open(i)));
    open(0);
  });

  // Cards glow where the pointer is.
  $$('.glow').forEach((c) => c.addEventListener('pointermove', (e) => { const r = c.getBoundingClientRect(); c.style.setProperty('--gx', (e.clientX - r.left) + 'px'); c.style.setProperty('--gy', (e.clientY - r.top) + 'px'); }, { passive: true }));
})();
