// On a phone every table becomes a stack of cards (see "phones" in styles.css). The CSS needs each cell to know which column it belongs to,
// so this copies the header text onto the cells as data-label. It runs whenever the page changes, which is cheap: it only touches tables
// that have a header row and cells that are not yet labelled.
export function installTableLabels(root = document.getElementById('root')) {
  if (!root || typeof MutationObserver === 'undefined') return;
  let queued = false;
  const label = () => {
    queued = false;
    for (const table of root.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('thead th')].map((h) => h.textContent.trim());
      if (!heads.length) continue;
      for (const row of table.querySelectorAll('tbody tr')) {
        let i = 0;
        for (const cell of row.children) {
          if (cell.dataset.label === undefined) cell.dataset.label = (cell.colSpan > 1 ? '' : heads[i] ?? '');
          i += cell.colSpan || 1;
        }
      }
    }
  };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(label); } }).observe(root, { childList: true, subtree: true });
  label();
}
