// Launcher window view: renders the state pushed by the main process (src/main/launcher.js).
'use strict';

const $ = (id) => document.getElementById(id);

function render(state) {
  $('ver').textContent = state.version ? `Version ${state.version} · unofficial fan-made mod` : '';

  const list = $('steps');
  list.replaceChildren();
  for (const step of state.steps) {
    const li = document.createElement('li');
    li.className = step.status;
    const ico = document.createElement('span');
    ico.className = 'ico';
    const text = document.createElement('span');
    text.textContent = step.label;
    if (step.detail) {
      const d = document.createElement('span');
      d.className = 'detail';
      d.textContent = step.detail;
      text.append(d);
    }
    li.append(ico, text);
    list.append(li);
  }

  $('progress').hidden = state.progress == null;
  if (state.progress != null) $('fill').style.width = `${Math.max(2, Math.min(100, state.progress))}%`;

  const m = state.message;
  $('msg').hidden = !m;
  if (m) {
    $('msg').className = `msg ${m.kind || ''}`;
    $('msgTitle').textContent = m.title || '';
    $('msgText').textContent = m.text || '';
    const actions = $('msgActions');
    actions.replaceChildren();
    for (const a of m.actions || []) {
      const b = document.createElement('button');
      b.className = `act${a.primary ? ' primary' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => window.launcher.action(a.id));
      actions.append(b);
    }
  }
}

$('close').addEventListener('click', () => window.launcher.action('quit'));
$('min').addEventListener('click', () => window.launcher.action('minimize'));
window.launcher.onState(render);
window.launcher.ready();
