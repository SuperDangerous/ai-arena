# Dashboard kit

The reusable half of this dashboard: design tokens, components, hand-rolled SVG
charts, and an app shell. **Domain-neutral** — nothing here knows about AI
Arena, prompts or session logs. Drop it into a finance, health, ops or IoT
dashboard and you get the same styling, charts and page structure with your own
data and business logic.

No dependencies, no build step, no framework. Plain ES modules and CSS that run
straight from a static file server.

**See it working:** [`example.html`](example.html) is a complete finance
dashboard (~150 lines) built only on this kit. Open it, then read it — it is the
intended starting point for a new app.

## Copy this

```
kit/
  tokens.css    design tokens — colours, radii, shadows, light + dark
  kit.css       components — shell, cards, tiles, tables, prose, tooltips
  charts.js     SVG charts — timeline, calendar, hbars, hours24, dotplot, sparkline
  dom.js        element builders — el, card, tile, table, filters, copy button
  format.js     number/date/currency formatters, day-range helpers
  shell.js      app shell — nav, sidebar, routing, theme, footer
  example.html  a worked example in a different domain
```

Copy the whole `kit/` folder. Then write two things: a data loader, and one
render function per page.

## Minimum viable app

```html
<link rel="stylesheet" href="kit/tokens.css">
<link rel="stylesheet" href="kit/kit.css">
<div id="app"></div>
<script type="module">
import { createApp } from './kit/shell.js';
import { card, chartDiv, tile, tiles } from './kit/dom.js';
import { makeFormat } from './kit/format.js';
import * as C from './kit/charts.js';

const fmt = makeFormat({ locale: 'en-IE', currency: 'EUR' });

createApp({
  title: 'My dashboard',
  brand: { text: 'My dashboard' },
  state: { period: 30 },
  load: () => fetch('data.json').then((r) => r.json()),
  pages: [{
    id: 'overview', label: 'Overview',
    render(view, { data, state, app }) {
      view.appendChild(tiles([ tile('Total', fmt.money(data.total)) ]));
      const c = card('Over time', 'What this chart measures.');
      C.timeline(chartDiv(c), {
        days: data.days,                                  // [{d:'2026-08-01', values:{a: 5}}]
        series: [{ key: 'a', label: 'Series A', color: C.css('--s1') }],
        fmtVal: (v, axis) => fmt.money(v, axis),
      });
      view.appendChild(c);
    },
  }],
  sidebar: ({ state, app, group, select }) => {
    const g = group('Period');
    g.appendChild(select([{ value: 30, label: 'Last 30 days' }, { value: 0, label: 'All time' }],
      state.period, (v) => { state.period = Number(v); app.render(); }));
  },
});
</script>
```

That is a complete, themed, routed dashboard.

## The rules that make it look designed

Follow these and a new app will match; break them and it will look like a
different product wearing the same paint.

1. **Never write a raw colour in a component.** Use the role tokens
   (`var(--surface)`, `var(--ink-2)`) and the series ramp (`--s1`…`--s8`, via
   `C.seriesColors(n)`). This is the whole reason light and dark both work.
2. **Explanations live in tooltips, not on the surface.** `card(title, info)`
   renders `info` behind a `?`. A card with a heading, a chart and nothing else
   is the target; subtitles are for genuinely dynamic text.
3. **Charts re-render on theme change.** Colours are sampled from CSS at draw
   time, so a theme switch must repaint — the shell does this for you. If you
   hand-wire your own chrome, do it yourself.
4. **One accent per view.** `.btn` and `.icon-btn.accent` are loud on purpose;
   two loud things on a page means neither reads as the action.
5. **Numbers get `font-variant-numeric: tabular-nums`** (the table and tile
   classes already do) so columns of figures line up.
6. **Round at a glance, keep precision in the tooltip.** `fmt.money(v, true)`
   for axes and tiles; the full value belongs in the hover.
7. **Empty is a state.** Use `empty('No data in this window')` rather than
   rendering a chart with nothing in it.

## Charts

All take `(container, options)` and replace the container's contents. Give them
a `chartDiv(card)` to live in — they measure its width.

| Function | Use it for | Key options |
|---|---|---|
| `timeline` | anything over dated buckets | `days`, `series`, `fmtVal`, `mode: 'stack'\|'lines'` |
| `calendar` | daily intensity over months | `byDay`, `weeks`, `fmtVal`, `label` |
| `hbars` | ranked categories | `rows`, `fmtVal`, `maxRows`, `tooltip` |
| `hours24` | time-of-day profile | `values` (24 numbers), `fmtVal`, `label` |
| `dotplot` | several series across shared categories | `rows`, `series`, `max`, `fmtTick` |
| `sparkline` | trend inside a tile | `values`, `color`, `stretch` |

`timeline` picks its own mark: stacked columns up to 92 buckets, stacked areas
beyond, or one line per series in `lines` mode. You do not choose.

Adding a chart? Match the house marks — thin marks, 4px rounded data-ends, 2px
gaps between stacked segments, hairline grids, and a tooltip on every mark.

## Components worth knowing

`el`, `card`, `chartDiv`, `tile`, `tiles`, `table`, `entityCell`, `seg`,
`headerSeg`, `avatar`, `copyBtn`, `insight`, `empty`, `infoBtn`,
`filterGroup`, `filterRow`, `select`.

CSS classes with no JS helper, use directly: `.prose` (readable text measure for
About pages), `.mono` (code/log panels, `.sm` and `.nowrap` variants), `.steps`
(numbered setup flows), `.chips`/`.chip`, `.tag`, `.badge`, `.grid.g2`/`.g3`/
`.g23` (responsive card grids), `.hint`, `.filterbar`.

## Rebranding

Change the token values in `tokens.css` — that is the whole job. Swap `--s1`…
`--s8` for your categorical palette, `--seq-lo`/`--seq-hi` for the heatmap ramp,
and the neutrals for your surfaces. Keep both the `:root` and
`:root[data-theme="dark"]` blocks in sync: every token defined in one must exist
in the other.

For a logo, pass `brand: { mark: '<svg …>' }` to `createApp` instead of `text`.

## What is NOT in the kit

The app around it. In this repo that means [`../app.js`](../app.js) (data
aggregation, Arena's pages) and [`../app.css`](../app.css) (prompt cards, habit
profiles, the setup pipeline). Arena also hand-wires its own chrome in
[`../index.html`](../index.html) rather than using `shell.js`, because it needs
app-specific header furniture — `shell.js` is the path for new apps, and
`example.html` is the proof it works.

When you copy the kit, leave `kit/` alone and put your own equivalents of those
files beside it. That boundary is the point: `kit/` should be updatable by
copying a newer version over the top without touching your app.
