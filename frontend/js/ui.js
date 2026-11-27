// Small DOM helpers. All user data is inserted with textContent (never innerHTML),
// so a name or description containing <script> is shown as plain text.
import { currentUser, signOut } from './auth.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(node, ...children) {
  node.replaceChildren(...children.flat().filter(Boolean));
  return node;
}

export function notice(target, message, kind = 'error') {
  const box = typeof target === 'string' ? $(target) : target;
  if (!box) return;
  clear(box, message ? el('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message) : null);
}

export const STATUS_LABEL = {
  available: 'Available', on_hold: 'On hold', reserved: 'Reserved', adopted: 'Adopted', archived: 'Archived',
  submitted: 'Submitted', under_review: 'Under review', approved: 'Approved', rejected: 'Rejected',
  withdrawn: 'Withdrawn', completed: 'Completed', booked: 'Booked', cancelled: 'Cancelled', no_show: 'No-show', open: 'Open'
};

export const badge = (status) => el('span', { class: `badge s-${status}` }, STATUS_LABEL[status] || status);

export function age(months) {
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const y = Math.floor(months / 12);
  return `${y} year${y === 1 ? '' : 's'}`;
}

export const fmt = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Inline SVG icons, built with createElementNS (no innerHTML).
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  paw: ['c:5.5,10,1.8', 'c:9.5,5.5,1.8', 'c:14.5,5.5,1.8', 'c:18.5,10,1.8', 'p:M12 12c-3 0-5.5 3.2-5.5 5.6 0 1.6 1.3 2.4 2.8 2.4 1.1 0 1.8-.6 2.7-.6s1.6.6 2.7.6c1.5 0 2.8-.8 2.8-2.4C17.5 15.2 15 12 12 12z'],
  moon: ['p:M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  sun: ['c:12,12,4', 'p:M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4']
};
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const part of ICONS[name]) {
    const [kind, data] = part.split(':');
    const node = document.createElementNS(SVG_NS, kind === 'c' ? 'circle' : 'path');
    if (kind === 'c') { const [cx, cy, r] = data.split(','); node.setAttribute('cx', cx); node.setAttribute('cy', cy); node.setAttribute('r', r); }
    else node.setAttribute('d', data);
    svg.append(node);
  }
  return svg;
}

// Light / dark theme. The saved choice is applied early by js/theme.js; this adds the toggle.
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function themeToggle() {
  const b = el('button', { type: 'button', class: 'theme-toggle' });
  const paint = () => {
    const dark = isDark();
    b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    b.title = b.getAttribute('aria-label');
    b.replaceChildren(icon(dark ? 'sun' : 'moon'));
  };
  b.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage blocked: still switches for this page */ }
    paint();
  });
  paint();
  return b;
}

export function header(active) {
  const user = currentUser();
  const link = (href, label, key) => el('a', { href, class: active === key ? 'active' : undefined }, label);
  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' },
    link('index.html', 'Animals', 'animals'),
    user && !user.isStaff ? link('my.html', 'My adoption', 'my') : null,
    user && user.isStaff ? link('staff.html', 'Staff dashboard', 'staff') : null,
    user
      ? el('span', { class: 'who' },
          el('span', { class: 'avatar', 'aria-hidden': 'true' }, (user.name || '?').trim().charAt(0).toUpperCase()),
          el('span', {}, user.name), el('span', { class: 'role' }, user.role),
          el('button', { class: 'link', type: 'button', onclick: () => { signOut(); location.href = 'index.html'; } }, 'Sign out'))
      : link('login.html', 'Sign in', 'login'),
    themeToggle());
  const bar = el('header', { class: 'top' },
    el('a', { href: 'index.html', class: 'brand' }, el('span', { class: 'logo' }, icon('paw')), 'Shelter Adoption Portal'),
    nav);
  document.body.prepend(bar);
  return user;
}

export function busy(button, on) {
  if (!button) return;
  button.disabled = on;
  button.classList.toggle('busy', on);
}

// Wrap a form submit: prevents double-submits and shows errors in `out`
export function onSubmit(form, out, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    notice(out, null);
    try { await handler(new FormData(form)); } catch (err) { notice(out, err.message); } finally { busy(btn, false); }
  });
}

export function photoOf(animal, cls = 'photo') {
  const p = animal.photos && animal.photos[0];
  if (p) return el('img', { class: cls, src: p.url, alt: `Photo of ${animal.name}`, loading: 'lazy' });
  const species = ['dog', 'cat', 'rabbit', 'bird'].includes(animal.species) ? animal.species : 'other';
  return el('div', { class: `${cls} placeholder ph-${species}`, 'aria-hidden': 'true' }, icon('paw'));
}

// A button that runs an async action. With `confirmText`, the first click only
// arms it ("Sure?") and a second click within 4 s runs it (no blocking dialogs).
export function actionButton(label, fn, { cls = '', confirmText, onError, onDone } = {}) {
  let armed = false;
  let timer;
  const b = el('button', { type: 'button', class: cls });
  b.textContent = label;
  b.addEventListener('click', async () => {
    if (confirmText && !armed) {
      armed = true;
      b.textContent = confirmText;
      b.classList.add('armed');
      timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer);
    busy(b, true);
    try { await fn(); if (onDone) await onDone(); } catch (err) { (onError || ((e) => notice('#msg', e.message)))(err); }
    finally { busy(b, false); armed = false; b.textContent = label; b.classList.remove('armed'); }
  });
  return b;
}
