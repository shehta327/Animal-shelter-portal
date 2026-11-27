import { api, qs } from './api.js';
import { el, $, clear, notice, header, age, photoOf } from './ui.js';

header('animals');

async function load(params = {}) {
  notice('#msg', null);
  const grid = $('#grid');
  clear(grid, el('p', { class: 'muted' }, 'Loading...'));
  try {
    const data = await api(`/api/animals${qs({ ...params, limit: 50 })}`, { auth: false });
    $('#count').textContent = `${data.total} animal${data.total === 1 ? '' : 's'} available`;
    clear(grid, data.items.length ? data.items.map(card) : [el('p', { class: 'muted' }, 'No animals match these filters.')]);
  } catch (e) {
    clear(grid);
    notice('#msg', e.message);
  }
}

function card(a) {
  return el('a', { class: 'card animal-card', href: `animal.html?id=${encodeURIComponent(a.id)}` },
    photoOf(a),
    el('div', { class: 'body' },
      el('h3', {}, a.name),
      el('p', { class: 'muted' }, [a.breed || a.species, age(a.ageMonths), a.size].join(' · ')),
      el('div', { class: 'tags' }, (a.temperament || []).slice(0, 3).map((t) => el('span', { class: 'tag' }, t.replace(/_/g, ' ')))),
      el('span', { class: 'cta', 'aria-hidden': 'true' }, `Meet ${a.name}`)));
}

$('#filters').addEventListener('submit', (e) => {
  e.preventDefault();
  load(Object.fromEntries(new FormData(e.target)));
});
load();
