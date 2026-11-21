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

export function header(active) {
  const user = currentUser();
  const link = (href, label, key) => el('a', { href, class: active === key ? 'active' : undefined }, label);
  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' },
    link('index.html', 'Animals', 'animals'),
    user && !user.isStaff ? link('my.html', 'My adoption', 'my') : null,
    user && user.isStaff ? link('staff.html', 'Staff dashboard', 'staff') : null,
    user
      ? el('span', { class: 'who' }, el('span', {}, user.name), el('span', { class: 'role' }, user.role),
          el('button', { class: 'link', type: 'button', onclick: () => { signOut(); location.href = 'index.html'; } }, 'Sign out'))
      : link('login.html', 'Sign in', 'login'));
  const bar = el('header', { class: 'top' },
    el('a', { href: 'index.html', class: 'brand' }, el('span', { class: 'paw', 'aria-hidden': 'true' }, '●'), 'Shelter Adoption Portal'),
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
  return p
    ? el('img', { class: cls, src: p.url, alt: `Photo of ${animal.name}`, loading: 'lazy' })
    : el('div', { class: `${cls} placeholder`, 'aria-hidden': 'true' }, animal.species === 'cat' ? 'Cat' : animal.species === 'dog' ? 'Dog' : animal.species);
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
