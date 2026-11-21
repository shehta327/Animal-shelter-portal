import { api, qs } from './api.js';
import { el, $, clear, notice, header, age, badge, fmt, onSubmit, busy } from './ui.js';

const user = header('animals');
const id = new URLSearchParams(location.search).get('id') || '';

async function main() {
  let animal;
  try {
    animal = await api(`/api/animals/${encodeURIComponent(id)}`);
  } catch (e) {
    return notice('#msg', e.status === 404 ? 'This animal could not be found.' : e.message);
  }
  document.title = `${animal.name} - Shelter Adoption Portal`;
  renderAnimal(animal);
  if (!user) {
    $('#adopt').hidden = false;
    clear($('#adopt'), el('p', {}, 'Want to adopt ', animal.name, '? ',
      el('a', { href: `login.html?next=${encodeURIComponent(`animal.html?id=${animal.id}`)}` }, 'Sign in or create an account'), ' to apply.'));
    return;
  }
  if (!user.isStaff) await renderAdopter(animal);
}

function renderAnimal(a) {
  const gallery = a.photos.length
    ? el('div', { class: 'gallery' }, a.photos.map((p) => el('img', { src: p.url, alt: `Photo of ${a.name}` })))
    : el('div', { class: 'gallery' }, el('div', { class: 'photo placeholder big' }, 'No photo yet'));
  const fact = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
  clear($('#animal'),
    gallery,
    el('div', {},
      el('h1', {}, a.name, ' ', badge(a.status)),
      el('dl', { class: 'facts' },
        fact('Species', a.species), fact('Breed', a.breed || '-'), fact('Sex', a.sex), fact('Age', age(a.ageMonths)), fact('Size', a.size),
        fact('Vaccinated', a.vaccinated ? 'Yes' : 'No'), fact('Neutered', a.neutered ? 'Yes' : 'No')),
      el('div', { class: 'tags' }, a.temperament.map((t) => el('span', { class: 'tag' }, t.replace('_', ' ')))),
      el('p', { class: 'desc' }, a.description || '')));
}

async function renderAdopter(animal) {
  const mine = (await api(`/api/applications${qs({ animalId: animal.id })}`)).items;
  const active = mine.find((x) => ['submitted', 'under_review', 'approved'].includes(x.status));
  const box = $('#adopt');
  box.hidden = false;

  if (active) {
    clear(box, el('h2', {}, 'Your application'),
      el('p', {}, 'Status: ', badge(active.status), active.visitCompletedAt ? ' · visit completed' : ' · next step: book a visit below'),
      el('a', { href: 'my.html' }, 'See all my applications'));
    if (!active.visitCompletedAt && animal.status === 'available') await renderSlots(animal);
    return;
  }
  if (animal.status !== 'available') {
    clear(box, el('p', {}, `${animal.name} is not available for new applications.`));
    return;
  }
  const out = el('div');
  const form = el('form', { class: 'form' },
    el('h2', {}, `Apply to adopt ${animal.name}`),
    el('label', {}, 'Housing', el('select', { name: 'housingType', required: true },
      el('option', { value: '' }, 'Choose...'), el('option', { value: 'apartment' }, 'Apartment'), el('option', { value: 'house' }, 'House'),
      el('option', { value: 'house_with_garden' }, 'House with garden'), el('option', { value: 'other' }, 'Other'))),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'hasOtherPets' }), 'I have other pets'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'hasChildren' }), 'There are children at home'),
    el('label', {}, 'Experience with pets', el('textarea', { name: 'experience', maxlength: 1000, rows: 3 })),
    el('label', {}, 'Message to the shelter', el('textarea', { name: 'message', maxlength: 1000, rows: 3 })),
    out,
    el('button', { type: 'submit' }, 'Submit application'));
  clear(box, form);
  onSubmit(form, out, async (f) => {
    await api('/api/applications', {
      method: 'POST',
      body: {
        animalId: animal.id,
        housingType: f.get('housingType'),
        hasOtherPets: f.get('hasOtherPets') === 'on',
        hasChildren: f.get('hasChildren') === 'on',
        experience: f.get('experience').trim(),
        message: f.get('message').trim()
      }
    });
    notice('#msg', 'Application submitted. Now book a meet-and-greet visit.', 'ok');
    await renderAdopter(animal);
  });
}

async function renderSlots(animal) {
  const box = $('#visits');
  box.hidden = false;
  const [slots, bookings] = await Promise.all([
    api(`/api/visits/slots${qs({ animalId: animal.id })}`),
    api(`/api/visits/bookings${qs({ animalId: animal.id, status: 'booked' })}`)
  ]);
  if (bookings.items.length) {
    const b = bookings.items[0];
    clear(box, el('h2', {}, 'Your visit'), el('p', {}, `Booked for ${fmt(b.startsAt)}. `, el('a', { href: 'my.html' }, 'Manage')));
    return;
  }
  const out = el('div');
  const list = slots.items.length
    ? el('ul', { class: 'slots' }, slots.items.map((s) => el('li', {},
        el('span', {}, fmt(s.startsAt), ` (${s.durationMinutes} min, ${s.placesLeft} place${s.placesLeft === 1 ? '' : 's'} left)`),
        el('button', {
          type: 'button',
          onclick: async (e) => {
            busy(e.target, true);
            try {
              await api('/api/visits/bookings', { method: 'POST', body: { slotId: s.id } });
              notice('#msg', 'Visit booked. A confirmation email is on its way.', 'ok');
              await renderSlots(animal);
            } catch (err) { notice(out, err.message); busy(e.target, false); }
          }
        }, 'Book'))))
    : el('p', { class: 'muted' }, 'No visit times are open yet. Check back soon.');
  clear(box, el('h2', {}, 'Book a meet-and-greet visit'), list, out);
}

main().catch((e) => notice('#msg', e.message));
