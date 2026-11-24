import { api } from './api.js';
import { el, $, clear, notice, header, badge, fmt, actionButton } from './ui.js';

const user = header('my');
if (!user) location.replace('login.html?next=my.html');
else if (user.isStaff) location.replace('staff.html');

const action = (label, fn) => actionButton(label, fn, { cls: 'secondary', confirmText: 'Click again to confirm', onDone: load });

async function load() {
  const apps = await api('/api/applications');
  clear($('#apps'), apps.items.length
    ? el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['Animal', 'Status', 'Visit', 'Submitted', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, apps.items.map((a) => el('tr', {},
          el('td', {}, el('a', { href: `animal.html?id=${encodeURIComponent(a.animalId)}` }, a.animalName)),
          el('td', {}, badge(a.status)),
          el('td', {}, a.visitCompletedAt ? 'Completed' : '-'),
          el('td', {}, fmt(a.createdAt)),
          el('td', {}, ['submitted', 'under_review', 'approved'].includes(a.status)
            ? action('Withdraw', () => api(`/api/applications/${a.id}/status`, { method: 'PATCH', body: { status: 'withdrawn' } }))
            : null)))))
    : el('p', { class: 'muted' }, 'No applications yet. ', el('a', { href: 'index.html' }, 'Browse animals')));

  try {
    const bookings = await api('/api/visits/bookings');
    clear($('#bookings'), bookings.items.length
      ? el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, ['Animal', 'When', 'Status', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, bookings.items.map((b) => el('tr', {},
            el('td', {}, b.animalName),
            el('td', {}, fmt(b.startsAt)),
            el('td', {}, badge(b.status)),
            el('td', {}, b.status === 'booked'
              ? action('Cancel visit', () => api(`/api/visits/bookings/${b.id}`, { method: 'PATCH', body: { status: 'cancelled' } }))
              : null)))))
      : el('p', { class: 'muted' }, 'No visits booked.'));
  } catch {
    clear($('#bookings'), el('p', { class: 'muted' }, 'Visits are unavailable right now.'));
  }
}

if (user && !user.isStaff) load().catch((e) => notice('#msg', e.message));
