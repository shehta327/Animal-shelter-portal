// Staff dashboard. The menu hides this page from adopters, but that is only
// convenience: every call below is re-checked by the backend (403 for adopters).
import { api, qs, uploadToS3 } from './api.js';
import { el, $, clear, notice, header, badge, fmt, age, onSubmit, actionButton, STATUS_LABEL } from './ui.js';

const user = header('staff');
if (!user) location.replace('login.html?next=staff.html');
else if (!user.isStaff) location.replace('index.html');

const ok = (m) => notice('#msg', m, 'ok');
const opt = (value, label, selected) => el('option', { value, selected: selected ? true : undefined }, label);
const select = (name, values, current) => el('select', { name }, values.map(([v, l]) => opt(v, l, v === current)));

// ---------- tabs
const loaders = {};
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== `tab-${b.dataset.tab}`; });
  notice('#msg', null);
  loaders[b.dataset.tab]().catch((e) => notice('#msg', e.message));
}));

// ---------- Animals (Animal Listings service)
let animalStatus = 'available';
loaders.animals = async function loadAnimals() {
  const panel = $('#tab-animals');
  const data = await api(`/api/animals${qs({ status: animalStatus, limit: 50 })}`);
  const filter = select('status', ['available', 'on_hold', 'reserved', 'adopted', 'archived'].map((s) => [s, STATUS_LABEL[s]]), animalStatus);
  filter.addEventListener('change', () => { animalStatus = filter.value; loadAnimals(); });

  const out = el('div');
  const form = el('form', { class: 'form grid-form' },
    el('h3', {}, 'Add an animal'),
    el('label', {}, 'Name', el('input', { name: 'name', required: true, maxlength: 60 })),
    el('label', {}, 'Species', select('species', [['dog', 'Dog'], ['cat', 'Cat'], ['rabbit', 'Rabbit'], ['bird', 'Bird'], ['other', 'Other']])),
    el('label', {}, 'Breed', el('input', { name: 'breed', maxlength: 60 })),
    el('label', {}, 'Sex', select('sex', [['unknown', 'Unknown'], ['male', 'Male'], ['female', 'Female']])),
    el('label', {}, 'Age (months)', el('input', { name: 'ageMonths', type: 'number', min: 0, max: 360, required: true })),
    el('label', {}, 'Size', select('size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']])),
    el('label', {}, 'Temperament tags', el('input', { name: 'temperament', placeholder: 'calm, kid_friendly', maxlength: 120 })),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'vaccinated' }), 'Vaccinated'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'neutered' }), 'Neutered'),
    el('label', { class: 'full' }, 'Description', el('textarea', { name: 'description', maxlength: 2000, rows: 3 })),
    out,
    el('button', { type: 'submit' }, 'Add animal'));
  onSubmit(form, out, async (f) => {
    const a = await api('/api/animals', {
      method: 'POST',
      body: {
        name: f.get('name').trim(), species: f.get('species'), breed: f.get('breed').trim() || undefined, sex: f.get('sex'),
        ageMonths: Number(f.get('ageMonths')), size: f.get('size'),
        temperament: f.get('temperament').split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean),
        description: f.get('description').trim(), vaccinated: f.get('vaccinated') === 'on', neutered: f.get('neutered') === 'on'
      }
    });
    ok(`${a.name} was added.`);
    animalStatus = 'available';
    await loadAnimals();
  });

  const rows = data.items.map((a) => {
    const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': `Photo for ${a.name}` });
    const actions = [];
    if (['available', 'on_hold'].includes(a.status)) {
      actions.push(actionButton(a.status === 'available' ? 'Put on hold' : 'Release hold',
        () => api(`/api/animals/${a.id}`, { method: 'PATCH', body: { status: a.status === 'available' ? 'on_hold' : 'available' } }),
        { cls: 'secondary', onDone: loadAnimals }));
      actions.push(actionButton('Archive', () => api(`/api/animals/${a.id}`, { method: 'DELETE' }),
        { cls: 'danger', confirmText: 'Confirm archive', onDone: loadAnimals }));
      actions.push(file, actionButton('Upload photo', async () => {
        const f = file.files[0];
        if (!f) throw new Error('Choose a photo first.');
        const { photo, upload } = await api(`/api/animals/${a.id}/photos`, { method: 'POST', body: { contentType: f.type } });
        await uploadToS3(upload, f);
        await api(`/api/animals/${a.id}/photos/${photo.id}`, { method: 'PATCH', body: { status: 'ready' } });
        ok(`Photo added to ${a.name}.`);
      }, { onDone: loadAnimals }));
    }
    return el('tr', {},
      el('td', {}, el('a', { href: `animal.html?id=${a.id}` }, a.name)),
      el('td', {}, `${a.species} · ${age(a.ageMonths)} · ${a.size}`),
      el('td', {}, badge(a.status)),
      el('td', {}, String(a.photos.length)),
      el('td', { class: 'actions' }, actions));
  });
  clear(panel,
    el('div', { class: 'row' }, el('h2', {}, 'Animals'), el('label', { class: 'inline' }, 'Status ', filter)),
    rows.length ? el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['Name', 'Details', 'Status', 'Photos', 'Actions'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows)) : el('p', { class: 'muted' }, 'No animals with this status.'),
    form);
};

// ---------- Applications (Adoption Applications service)
let appStatus = '';
const NEXT = {
  submitted: [['under_review', 'Start review'], ['rejected', 'Reject']],
  under_review: [['approved', 'Approve'], ['rejected', 'Reject']],
  approved: [['completed', 'Complete adoption'], ['rejected', 'Reject']]
};
loaders.applications = async function loadApps() {
  const panel = $('#tab-applications');
  const data = await api(`/api/applications${qs({ status: appStatus })}`);
  const filter = select('status', [['', 'All'], ...['submitted', 'under_review', 'approved', 'completed', 'rejected', 'withdrawn'].map((s) => [s, STATUS_LABEL[s]])], appStatus);
  filter.addEventListener('change', () => { appStatus = filter.value; loadApps(); });
  const detail = el('div', { id: 'app-detail' });

  const rows = data.items.map((a) => el('tr', {},
    el('td', {}, a.animalName),
    el('td', {}, a.adopterName),
    el('td', {}, badge(a.status)),
    el('td', {}, a.visitCompletedAt ? 'Done' : 'Not yet'),
    el('td', {}, fmt(a.createdAt)),
    el('td', { class: 'actions' },
      (NEXT[a.status] || []).map(([to, label]) => actionButton(label,
        () => api(`/api/applications/${a.id}/status`, { method: 'PATCH', body: { status: to } }).then((r) => ok(
          `Application ${STATUS_LABEL[to].toLowerCase()}.${r.autoRejected ? ` ${r.autoRejected} other application(s) were closed automatically.` : ''}`)),
        { cls: to === 'rejected' ? 'danger' : '', confirmText: to === 'rejected' || to === 'completed' ? 'Confirm' : undefined, onDone: loadApps })),
      actionButton('Details', () => showApp(a.id, detail), { cls: 'secondary' }))));
  clear(panel,
    el('div', { class: 'row' }, el('h2', {}, 'Applications'), el('label', { class: 'inline' }, 'Status ', filter)),
    rows.length ? el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['Animal', 'Adopter', 'Status', 'Visit', 'Submitted', 'Actions'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows)) : el('p', { class: 'muted' }, 'No applications.'),
    detail);
};

async function showApp(id, box) {
  const a = await api(`/api/applications/${id}`);
  const out = el('div');
  const form = el('form', { class: 'form inline-form' },
    el('label', {}, 'Internal note', el('input', { name: 'note', required: true, maxlength: 500 })), out, el('button', { type: 'submit' }, 'Add note'));
  onSubmit(form, out, async (f) => { await api(`/api/applications/${id}/notes`, { method: 'POST', body: { note: f.get('note').trim() } }); await showApp(id, box); });
  clear(box, el('div', { class: 'card pad' },
    el('h3', {}, `${a.adopterName} → ${a.animalName} `, badge(a.status)),
    el('p', {}, `Housing: ${a.housingType.replace(/_/g, ' ')} · other pets: ${a.hasOtherPets ? 'yes' : 'no'} · children: ${a.hasChildren ? 'yes' : 'no'}`),
    a.experience ? el('p', {}, el('strong', {}, 'Experience: '), a.experience) : null,
    a.message ? el('p', {}, el('strong', {}, 'Message: '), a.message) : null,
    el('h4', {}, 'History'),
    el('ul', { class: 'history' }, a.history.map((h) => el('li', {}, `${fmt(h.at)} · ${h.actorRole} · ${h.kind === 'status' ? `${h.fromStatus || 'new'} → ${h.toStatus}` : h.kind}${h.note ? ` · ${h.note}` : ''}`))),
    form));
}

// ---------- Visits (Visit Scheduling service)
let visitAnimal = '';
loaders.visits = async function loadVisits() {
  const panel = $('#tab-visits');
  const animals = (await api(`/api/animals${qs({ status: 'available', limit: 50 })}`)).items;
  if (!visitAnimal && animals[0]) visitAnimal = animals[0].id;
  const pick = select('animalId', animals.map((a) => [a.id, a.name]), visitAnimal);
  pick.addEventListener('change', () => { visitAnimal = pick.value; loadVisits(); });

  const [slots, bookings] = await Promise.all([
    visitAnimal ? api(`/api/visits/slots${qs({ animalId: visitAnimal, includePast: 'true' })}`) : { items: [] },
    api(`/api/visits/bookings${qs({ status: 'booked' })}`)
  ]);

  const out = el('div');
  const form = el('form', { class: 'form inline-form' },
    el('label', {}, 'Start', el('input', { name: 'startsAt', type: 'datetime-local', step: 1800, required: true })),
    el('label', {}, 'Length', select('durationMinutes', [['30', '30 min'], ['60', '60 min']])),
    el('label', {}, 'Places', el('input', { name: 'capacity', type: 'number', min: 1, max: 4, value: 1 })),
    out, el('button', { type: 'submit' }, 'Open slot'));
  onSubmit(form, out, async (f) => {
    if (!visitAnimal) throw new Error('Choose an animal first.');
    await api('/api/visits/slots', {
      method: 'POST',
      body: { animalId: visitAnimal, startsAt: new Date(f.get('startsAt')).toISOString(), durationMinutes: Number(f.get('durationMinutes')), capacity: Number(f.get('capacity')) }
    });
    ok('Visit slot opened.');
    await loadVisits();
  });

  const now = Date.now();
  clear(panel,
    el('div', { class: 'row' }, el('h2', {}, 'Visit slots'), el('label', { class: 'inline' }, 'Animal ', pick)),
    slots.items.length ? el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['When', 'Length', 'Booked', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, slots.items.map((s) => el('tr', {},
        el('td', {}, fmt(s.startsAt)), el('td', {}, `${s.durationMinutes} min`), el('td', {}, `${s.bookedCount}/${s.capacity}`), el('td', {}, badge(s.status)),
        el('td', {}, s.status === 'open' && Date.parse(s.startsAt) > now
          ? actionButton('Cancel slot', () => api(`/api/visits/slots/${s.id}`, { method: 'DELETE' }).then((r) => ok(`Slot cancelled; ${r.cancelledBookings} booking(s) notified.`)),
              { cls: 'danger', confirmText: 'Confirm cancel', onDone: loadVisits }) : null)))))
      : el('p', { class: 'muted' }, 'No slots for this animal.'),
    el('h3', {}, 'Open a new slot'), form,
    el('h2', {}, 'Upcoming and pending visits'),
    bookings.items.length ? el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['When', 'Animal', 'Adopter', 'Status', 'Outcome'].map((h) => el('th', {}, h)))),
      el('tbody', {}, bookings.items.map((b) => {
        const started = Date.parse(b.startsAt) <= now;
        const note = el('input', { placeholder: 'Note (optional)', maxlength: 500, 'aria-label': 'Outcome note' });
        const record = (to, label) => actionButton(label,
          () => api(`/api/visits/bookings/${b.id}`, { method: 'PATCH', body: { status: to, note: note.value.trim() || undefined } }).then(() => ok('Outcome recorded.')),
          { cls: to === 'no_show' ? 'secondary' : '', onDone: loadVisits });
        return el('tr', {},
          el('td', {}, fmt(b.startsAt)), el('td', {}, b.animalName), el('td', {}, b.adopterName), el('td', {}, badge(b.status)),
          el('td', { class: 'actions' }, started ? [note, record('completed', 'Completed'), record('no_show', 'No-show')]
            : actionButton('Cancel', () => api(`/api/visits/bookings/${b.id}`, { method: 'PATCH', body: { status: 'cancelled' } }),
                { cls: 'secondary', confirmText: 'Confirm cancel', onDone: loadVisits })));
      }))) : el('p', { class: 'muted' }, 'No booked visits.'));
};

if (user && user.isStaff) loaders.animals().catch((e) => notice('#msg', e.message));
