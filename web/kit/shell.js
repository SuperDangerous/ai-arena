/* ---------------------------------------------------------------------------
   App shell — builds the page chrome so a new dashboard only writes its views.

   Gives you: topbar with wordmark + tab nav, sticky sidebar for global
   filters, content area, footer, theme toggle with persistence, hash routing,
   a help popover, debounced re-render on resize, and an error state.

     createApp({
       title: 'Ledger',
       brand: { text: 'Ledger' },
       load: () => fetch('data.json').then(r => r.json()),
       pages: [{ id: 'overview', label: 'Overview', render: renderOverview }],
       sidebar: (ctx) => { … },          // optional; omit for no sidebar
       footer: (ctx) => ({ left, right }),
       actions: [{ label: 'GitHub ↗', href: '…', accent: true }],
       help: { title: 'About this data', body: ['…'] },
     });

   Each page's render(view, ctx) fills `view`; the shell clears it first.
   ctx = { data, state, app }. Mutate ctx.state.* then call app.render().

   Charts read colours at draw time, so the shell re-renders on theme change.
--------------------------------------------------------------------------- */
import { el, filterGroup, filterRow, select } from './dom.js';

export function createApp(cfg) {
  const {
    title = 'Dashboard', brand = {}, pages = [], sidebar, footer, actions = [],
    help, load, theme: defaultTheme = 'dark', storageKey = 'kit',
  } = cfg;

  const app = {
    state: { page: pages[0] && pages[0].id, ...(cfg.state || {}) },
    data: null,
    render, setPage, refresh, buildSidebar,
  };

  // ---- theme (before first paint, so there's no flash) ----
  const themeKey = storageKey + '-theme';
  document.documentElement.dataset.theme = localStorage.getItem(themeKey) || defaultTheme;
  if (title) document.title = title;

  // ---- skeleton ----
  const root = document.getElementById('app') || document.body.appendChild(el('div'));
  root.id = 'app';
  root.replaceChildren();

  const topbar = el('header', 'topbar');
  const brandEl = el('a', 'brand');
  brandEl.href = brand.href || '.';
  if (brand.mark) brandEl.insertAdjacentHTML('beforeend', brand.mark);
  if (brand.text || !brand.mark) brandEl.appendChild(el('span', 'brand-text', brand.text || title));
  topbar.appendChild(brandEl);

  const tabs = el('nav', 'tabs');
  for (const p of pages) {
    const b = el('button', 'tab' + (p.id === app.state.page ? ' active' : ''), p.label);
    b.dataset.page = p.id;
    b.addEventListener('click', () => setPage(p.id));
    tabs.appendChild(b);
  }
  if (pages.length > 1) topbar.appendChild(tabs);

  const right = el('div', 'topbar-right');
  for (const a of actions) {
    const b = el(a.href ? 'a' : 'button', 'icon-btn txt' + (a.accent ? ' accent' : ''), a.label);
    if (a.href) { b.href = a.href; b.target = a.target || '_blank'; b.rel = 'noopener'; }
    if (a.title) b.title = a.title;
    if (a.onClick) b.addEventListener('click', a.onClick);
    right.appendChild(b);
  }
  let helpPop = null;
  if (help) {
    const hb = el('button', 'icon-btn txt', help.label || 'About');
    helpPop = el('div', 'popover');
    helpPop.hidden = true;
    hb.addEventListener('click', (e) => {
      e.stopPropagation();
      helpPop.replaceChildren();
      if (help.title) helpPop.appendChild(el('h4', null, help.title));
      for (const p of help.body || []) helpPop.appendChild(typeof p === 'string' ? el('p', null, p) : p);
      helpPop.hidden = !helpPop.hidden;
    });
    document.addEventListener('click', (e) => {
      if (helpPop && !helpPop.hidden && !helpPop.contains(e.target)) helpPop.hidden = true;
    });
    right.appendChild(hb);
  }
  const themeBtn = el('button', 'icon-btn', '◐');
  themeBtn.title = 'Toggle theme';
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(themeKey, next);
    buildSidebar();
    render(); // charts sample CSS variables at draw time
  });
  right.appendChild(themeBtn);
  if (helpPop) right.appendChild(helpPop);
  topbar.appendChild(right);
  root.appendChild(topbar);

  const shell = el('div', 'shell' + (sidebar ? '' : ' no-side'));
  const side = el('aside', 'side');
  side.setAttribute('aria-label', 'Filters');
  if (sidebar) shell.appendChild(side);
  const main = el('div', 'main');
  const view = el('main', 'view');
  view.id = 'view';
  view.setAttribute('aria-live', 'polite');
  main.appendChild(view);
  const foot = el('footer', 'foot');
  const footL = el('span'), footR = el('span');
  foot.append(footL, footR);
  if (footer) main.appendChild(foot);
  shell.appendChild(main);
  root.appendChild(shell);

  // ---- behaviour ----
  function ctx() { return { data: app.data, state: app.state, app, view }; }

  function setPage(id) {
    app.state.page = id;
    if ('#' + id !== location.hash) history.replaceState(null, '', '#' + id);
    for (const b of tabs.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.page === id);
    render();
  }

  function render() {
    const page = pages.find((p) => p.id === app.state.page) || pages[0];
    view.replaceChildren();
    if (!page) return;
    try {
      page.render(view, ctx());
    } catch (e) {
      view.replaceChildren(el('div', 'empty', 'This page failed to render: ' + e.message));
      console.error(e);
    }
    if (footer) {
      const f = footer(ctx()) || {};
      footL.textContent = f.left || '';
      footR.textContent = f.right || '';
    }
  }

  function buildSidebar() {
    if (!sidebar) return;
    side.replaceChildren();
    sidebar({ ...ctx(), side, group: (label) => filterGroup(side, label), row: filterRow, select });
  }

  /** Reload data from load() and repaint everything. */
  async function refresh() {
    app.data = await load();
    buildSidebar();
    render();
  }

  addEventListener('resize', () => { clearTimeout(render._t); render._t = setTimeout(render, 150); });

  (async () => {
    try {
      if (load) app.data = await load();
      const hash = location.hash.slice(1);
      if (pages.some((p) => p.id === hash)) app.state.page = hash;
      for (const b of tabs.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.page === app.state.page);
      buildSidebar();
      render();
      // re-measure once layout has settled (charts size to their container)
      requestAnimationFrame(render);
    } catch (e) {
      view.replaceChildren(el('div', 'empty', 'Failed to load data: ' + e.message));
      console.error(e);
    }
  })();

  return app;
}
