// DOM helpers for the overlay: a tiny element builder and in-place updates.
// All player-supplied text is inserted as text nodes, never as HTML.

// Tiny element builder. Extra props: key (stable id used to keep focus/scroll across redraws) and
// onEnter (run when Enter is pressed in a text box). Event handlers are stored on the element and
// called through one listener per event type, so updating the page in place (see morph) can swap
// them without replacing the element.
function dispatch(e) {
  const fn = e.currentTarget.__handlers && e.currentTarget.__handlers[e.type];
  if (fn) fn(e);
}
function listen(el, type) {
  el.__types ||= new Set();
  if (el.__types.has(type)) return;
  el.__types.add(type);
  el.addEventListener(type, dispatch);
}
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'key') el.dataset.key = v;
    else if (k === 'onEnter') el.__onEnter = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      const type = k.slice(2).toLowerCase();
      (el.__handlers ||= {})[type] = v;
      listen(el, type);
    }
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
      el[k] = v;
      el.setAttribute(k, v === true ? '' : String(v)); // mirrored so redraws can be compared as HTML
    } else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/**
 * Updates a live element to match a freshly built one, keeping the live nodes wherever the
 * structure matches. A button under the mouse survives any redraw, so a click that straddles one
 * still lands; focus, text selection, scroll and hover are kept as well.
 */
export function morph(from, to) {
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
  for (const a of [...to.attributes]) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  for (const k of ['checked', 'disabled', 'selected']) if (from[k] !== undefined && from[k] !== to[k]) from[k] = to[k];
  if ('value' in to && from.value !== to.value && from !== from.getRootNode().activeElement) from.value = to.value;
  from.__handlers = to.__handlers;
  from.__onEnter = to.__onEnter;
  if (to.__types) for (const t of to.__types) listen(from, t);
  morphChildren(from, to);
}

export function morphChildren(from, to) {
  const olds = [...from.childNodes];
  const news = [...to.childNodes];
  news.forEach((n, i) => {
    const o = olds[i];
    if (!o) { from.appendChild(n); return; }
    const same = o.nodeType === n.nodeType && o.nodeName === n.nodeName && (o.nodeType !== 1 || o.dataset.key === n.dataset.key);
    if (!same) { from.replaceChild(n, o); return; }
    if (o.nodeType === 1) morph(o, n);
    else if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
  });
  for (let i = news.length; i < olds.length; i++) olds[i].remove();
}

/** Shows `nodes` in `layer`, updating what's already there in place. */
export function patch(layer, ...nodes) {
  const next = document.createElement('div');
  for (const n of nodes.flat()) if (n) next.append(n);
  morphChildren(layer, next);
}

export const lobbyCode = (id) => { try { return BigInt(id).toString(36).toUpperCase(); } catch { return String(id); } };
export const parseCode = (code) => {
  const c = String(code).trim();
  if (/^\d{15,20}$/.test(c)) return c;
  if (!/^[0-9a-z]{6,14}$/i.test(c)) return null;
  let n = 0n;
  for (const ch of c.toLowerCase()) n = n * 36n + BigInt(parseInt(ch, 36));
  return n.toString();
};
export const stars = (r) => (r > 0 ? `★ ${r.toFixed(1)}` : '');
export const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));
