/*!
 * calc-core.js — the one calculator engine shared by all 13 sites. Vanilla JS, no build step, no deps.
 *
 * A site defines window.CALCS = { key: CALC, ... } in its own calculator.js, where:
 *   CALC = {
 *     id, title,
 *     inputs: [ { id, label, type: 'number'|'date'|'select'|'radio'|'checkbox'|'repeater', ... } ],
 *     compute(values) -> { summary: [{label, value, strong?}], rows?: [{label, value}], notes?: [string], warnings?: [string] }
 *     render?(root)   -> optional: a fully custom tool (ADHD routine builder, workout log) bypasses the form
 *   }
 * The engine renders the form, recomputes live on every change, formats money/percent, builds a shareable
 * link (inputs in the URL hash, only when "Copy link" is pressed) and prints cleanly.
 *
 * RULE: compute() must be a pure function of its inputs. That is what lets tests/run-tests.mjs check
 * every calculator headlessly before launch.
 */
(function () {
  'use strict';
  const root = document.getElementById('calculator');
  if (!root) return;
  // one calculator.js per site exports window.CALCS; each page picks its tool with <div id="calculator" data-calc="key">
  const C = (window.CALCS || {})[root.dataset.calc];
  if (!C) { root.textContent = `Calculator "${root.dataset.calc}" not found in calculator.js`; return; }

  const cur = C.currency || { code: 'USD', locale: 'en-US' };
  const fmt = {
    money: v => (v == null || isNaN(v)) ? '—' : new Intl.NumberFormat(cur.locale, { style: 'currency', currency: cur.code, maximumFractionDigits: 2 }).format(v),
    money0: v => (v == null || isNaN(v)) ? '—' : new Intl.NumberFormat(cur.locale, { style: 'currency', currency: cur.code, maximumFractionDigits: 0 }).format(v),
    pct: v => (v == null || isNaN(v)) ? '—' : `${(Math.round(v * 10) / 10).toLocaleString(cur.locale)}%`,
    num: v => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString(cur.locale, { maximumFractionDigits: 2 }),
  };
  window.CALC_FMT = fmt;

  if (typeof C.render === 'function') { C.render(root, fmt); return; }

  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return n;
  };

  // ── state: defaults, overridden by the URL hash ───────────────────────────
  const state = {};
  for (const i of C.inputs) state[i.id] = i.type === 'repeater' ? JSON.parse(JSON.stringify(i.default || [])) : i.default;
  // a page can open the tool on its own scenario: <div id="calculator" data-calc="payback" data-preset='{"state":"TX"}'>
  try { if (root.dataset.preset) Object.assign(state, JSON.parse(root.dataset.preset)); } catch (_) { /* ignore a malformed preset */ }
  try {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h) Object.assign(state, JSON.parse(h));
    // a shared link has been read: drop the entries from the address bar
    if (h) history.replaceState(null, '', location.pathname + location.search);
  } catch (_) { /* ignore a malformed hash */ }

  const form = el('form', { class: 'calc-form', onsubmit: e => e.preventDefault(), novalidate: true });
  const out = el('div', { class: 'calc-result', 'aria-live': 'polite' });

  const visible = i => !i.showIf || i.showIf(state);

  function field(i) {
    const wrap = el('div', { class: `calc-field calc-${i.type}`, 'data-id': i.id });
    const id = `f-${i.id}`;
    if (i.type === 'number') {
      wrap.append(el('label', { for: id, text: i.label }));
      const box = el('div', { class: 'calc-input' });
      if (i.prefix) box.append(el('span', { class: 'affix', text: i.prefix }));
      box.append(el('input', { id, type: 'number', inputmode: 'decimal', min: i.min, max: i.max, step: i.step || 'any', value: state[i.id] ?? '',
        oninput: e => { state[i.id] = e.target.value === '' ? null : Number(e.target.value); update(); } }));
      if (i.suffix) box.append(el('span', { class: 'affix', text: i.suffix }));
      wrap.append(box);
    } else if (i.type === 'date') {
      wrap.append(el('label', { for: id, text: i.label }));
      wrap.append(el('div', { class: 'calc-input' }, el('input', { id, type: 'date', value: state[i.id] || '',
        onchange: e => { state[i.id] = e.target.value; update(); } })));
    } else if (i.type === 'select') {
      wrap.append(el('label', { for: id, text: i.label }));
      const s = el('select', { id, onchange: e => { state[i.id] = e.target.value; rebuild(); } });
      const opts = typeof i.options === 'function' ? i.options(state) : i.options;   // options may depend on another field (state → city)
      if (!opts.some(o => String(o.value) === String(state[i.id]))) state[i.id] = opts.length ? opts[0].value : '';
      for (const o of opts) s.append(el('option', { value: o.value, selected: String(state[i.id]) === String(o.value) }, o.label));
      wrap.append(s);
    } else if (i.type === 'radio') {
      const fs = el('fieldset', {}, [el('legend', { text: i.label })]);
      for (const o of i.options) {
        const rid = `${id}-${o.value}`;
        fs.append(el('label', { class: 'calc-radio', for: rid }, [
          el('input', { id: rid, type: 'radio', name: id, value: o.value, checked: String(state[i.id]) === String(o.value), onchange: () => { state[i.id] = o.value; rebuild(); } }), ` ${o.label}`]));
      }
      wrap.append(fs);
    } else if (i.type === 'checkbox') {
      wrap.append(el('label', { class: 'calc-check', for: id }, [
        el('input', { id, type: 'checkbox', checked: !!state[i.id], onchange: e => { state[i.id] = e.target.checked; rebuild(); } }), ` ${i.label}`]));
    } else if (i.type === 'repeater') {
      wrap.append(el('div', { class: 'calc-label', text: i.label }));
      const table = el('div', { class: 'calc-repeater' });
      (state[i.id] || []).forEach((row, r) => {
        const line = el('div', { class: 'calc-row' });
        for (const col of i.columns) {
          line.append(el('input', { 'aria-label': col.label, placeholder: col.label, type: col.type || 'text', step: 'any', value: row[col.id] ?? '',
            oninput: e => { row[col.id] = col.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value; update(); } }));
        }
        line.append(el('button', { type: 'button', class: 'calc-remove', 'aria-label': 'Remove row', onclick: () => { state[i.id].splice(r, 1); rebuild(); } }, '×'));
        table.append(line);
      });
      table.append(el('button', { type: 'button', class: 'calc-add', onclick: () => { state[i.id].push({}); rebuild(); } }, i.addLabel || '+ Add row'));
      wrap.append(table);
    }
    if (i.help) wrap.append(el('p', { class: 'calc-help', text: i.help }));
    return wrap;
  }

  function rebuild() {
    form.innerHTML = '';
    for (const i of C.inputs) if (visible(i)) form.append(field(i));
    update();
  }

  function update() {
    let r;
    try { r = C.compute(JSON.parse(JSON.stringify(state)), fmt); }
    catch (e) { r = { warnings: [`Could not calculate: ${e.message}`] }; }
    out.innerHTML = '';
    if (r.warnings && r.warnings.length) out.append(el('div', { class: 'calc-warn', role: 'alert' }, r.warnings.map(w => el('p', { text: w }))));
    if (r.summary && r.summary.length) {
      const box = el('div', { class: 'calc-summary' });
      for (const s of r.summary) box.append(el('div', { class: `calc-stat${s.strong ? ' strong' : ''}` }, [el('span', { class: 'k', text: s.label }), el('span', { class: 'v', text: s.value })]));
      out.append(box);
    }
    if (r.rows && r.rows.length) {
      const t = el('table', { class: 'calc-table' }, [el('tbody', {}, r.rows.map(row => el('tr', { class: row.total ? 'total' : '' }, [el('th', { scope: 'row', text: row.label }), el('td', { text: row.value })])))]);
      out.append(el('div', { class: 'calc-table-wrap' }, t));
    }
    if (r.notes && r.notes.length) out.append(el('ul', { class: 'calc-notes' }, r.notes.map(n => el('li', { text: n }))));
  }

  // The inputs go into the link only when the visitor asks for a shareable link. They are never written to the
  // address bar while typing, so page-view analytics cannot pick up salaries, balances or other entries.
  const shareUrl = () => `${location.origin}${location.pathname}#${encodeURIComponent(JSON.stringify(state))}`;
  const copyBtn = el('button', { type: 'button', onclick: () => {
    const done = () => { copyBtn.textContent = 'Link copied'; setTimeout(() => { copyBtn.textContent = 'Copy link to this result'; }, 2000); };
    if (navigator.clipboard) navigator.clipboard.writeText(shareUrl()).then(done, () => window.prompt('Copy this link:', shareUrl()));
    else window.prompt('Copy this link:', shareUrl());
  } }, 'Copy link to this result');

  root.append(form, out,
    el('div', { class: 'calc-actions' }, [
      copyBtn,
      el('button', { type: 'button', onclick: () => window.print() }, 'Print'),
    ]));
  rebuild();
})();
