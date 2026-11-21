import { signIn, signUp, currentUser } from './auth.js';
import { $, header, onSubmit } from './ui.js';

header('login');
if (currentUser()) location.replace('index.html');

const show = (up) => {
  $('#signin').hidden = up;
  $('#signup').hidden = !up;
  $('#tab-in').setAttribute('aria-selected', String(!up));
  $('#tab-up').setAttribute('aria-selected', String(up));
};
$('#tab-in').addEventListener('click', () => show(false));
$('#tab-up').addEventListener('click', () => show(true));

const next = (user) => {
  const back = new URLSearchParams(location.search).get('next');
  // only same-site relative pages (no open redirect)
  location.href = back && /^[a-z]+\.html(\?[\w=&%-]*)?$/.test(back) ? back : (user.isStaff ? 'staff.html' : 'index.html');
};

onSubmit($('#signin'), '#msg', async (f) => next(await signIn({ email: f.get('email').trim(), password: f.get('password') })));
onSubmit($('#signup'), '#msg', async (f) => next(await signUp({ name: f.get('name').trim(), email: f.get('email').trim(), password: f.get('password') })));
