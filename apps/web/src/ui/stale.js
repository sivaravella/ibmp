// A screen is a separate file with a content hash in its name. After a new version is deployed (or the server restarts on a rebuild),
// a tab that was opened earlier asks for files that no longer exist the first time it opens a screen it had not loaded yet.
// That is not a bug in the screen, so it is retried, and if the files really are gone the page reloads itself once to pick up the new version.
export const isChunkError = (e) => /dynamically imported module|importing a module script failed|error loading dynamically|unable to preload|ChunkLoadError|MIME type/i.test(String(e?.message ?? e));

const KEY = 'ibmp_stale_reload';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reload to get the new version, unless we already did in the last 30 seconds (then the files are genuinely missing: say so, do not loop). */
export function reloadForNewVersion() {
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 30_000) return false;
  sessionStorage.setItem(KEY, String(Date.now()));
  location.reload();
  return true;
}

/** React.lazy for a screen: one quiet retry, then a reload onto the current version. */
export function loadScreen(loader) {
  return async () => {
    try { return await loader(); } catch (e) {
      if (!isChunkError(e)) throw e;
      await sleep(500);
      try { return await loader(); } catch (e2) {
        if (reloadForNewVersion()) return new Promise(() => {});      // the page is reloading: render nothing meanwhile
        throw e2;
      }
    }
  };
}

if (typeof window !== 'undefined') {
  // Vite raises this when it cannot preload a screen's files (also covers its stylesheets).
  window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadForNewVersion(); });
}
