// Applies the saved light/dark choice before the page paints (no flash).
// Loaded as a normal script in <head>; the toggle button itself is added by ui.js.
// Only a UI preference is stored here - never tokens or personal data.
(function () {
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (e) { /* storage blocked: fall back to the system setting */ }
})();
