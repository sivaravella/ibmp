import { useState } from 'react';

/** Whether the sidebar is folded down to icons. Remembered in this browser. */
export function useNavCollapsed() {
  const [collapsed, set] = useState(() => localStorage.getItem('ibmp_nav_collapsed') === '1');
  const toggle = () => set((c) => { localStorage.setItem('ibmp_nav_collapsed', c ? '0' : '1'); return !c; });
  return [collapsed, toggle];
}
