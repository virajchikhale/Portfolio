(async () => {
  const R = []; const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (n, c, x = '') => { R.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  — ' + x : '')); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  const mark = m => { R.push('..... ' + m); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
  const key = (k, target = document) => target.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true}));
  const until = async (fn, ms = 4000) => { for (let t = 0; t < ms && !fn(); t += 100) await sleep(100); return fn(); };   // the spotlight glides: wait for it to arrive
  const stored = k => { try { return localStorage.getItem(k); } catch (e) { return undefined; } };
  try {
    while (!document.getElementById('os').classList.contains('visible')) await sleep(100);
    await sleep(500);

    mark('quiet start');
    ok('open=none: no chooser and no tour start on their own', !shown('welcome') && !shown('tour') && !Welcome.open && !Tour.active);

    mark('mode chooser');
    let landed = 0;
    Welcome.show(() => landed++); await sleep(200);
    ok('chooser is shown with two choices', shown('welcome') && document.querySelectorAll('#welcome .wl-opt').length === 2);
    ok('chooser: the desktop choice has focus', document.activeElement.id === 'wl-os');
    key('ArrowRight', document.getElementById('wl-os'));
    ok('chooser: arrow keys move between the choices', document.activeElement.id === 'wl-rv');
    ok('chooser: the guide is drawn', document.getElementById('wl-guide').getContext('2d').getImageData(20, 8, 1, 1).data[3] === 255);
    ok('the tour cannot start underneath the chooser', (Tour.start(), !Tour.active));
    document.getElementById('wl-os').click(); await sleep(100);
    ok('choosing the desktop closes the chooser and continues', !shown('welcome') && landed === 1 && !Welcome.open);
    ok('the choice is remembered (when storage is available)', stored('vc-os-mode') === 'os' || stored('vc-os-mode') === undefined);
    ok('a remembered choice is not asked again', stored('vc-os-mode') === undefined || Welcome.needed() === false);
    Welcome.show(() => landed++); await sleep(50); key('Escape', document.getElementById('wl-os')); await sleep(50);
    ok('Escape stays on the desktop', !shown('welcome') && landed === 2);

    mark('landing layout');
    closeAll(); landingLayout(); await sleep(200);
    const desk = document.getElementById('desktop'), area = id => { const e = document.getElementById(id); return e.style.display === 'none' ? 0 : e.offsetWidth * e.offsetHeight; };
    const used = (area('win-chat') + area('win-about')) / (desk.clientWidth * desk.clientHeight);
    ok('landing leaves most of the desktop visible', used > 0.1 && used < 0.5, Math.round(used * 100) + '% covered');
    ok('landing opens the chat, not the Flow Monitor', shown('win-chat') && !shown('win-flow'));
    const inside = id => { const e = document.getElementById(id); return e.offsetTop >= 0 && e.offsetLeft >= 0 && e.offsetTop + e.offsetHeight <= desk.clientHeight && e.offsetLeft + e.offsetWidth <= desk.clientWidth; };
    ok('landing windows are inside the desktop', inside('win-chat') && (!shown('win-about') || inside('win-about')));

    mark('tour');
    Tour.start(); await sleep(350);
    ok('tour starts on a welcome step with no spotlight', Tour.active && shown('tour') && document.getElementById('tour-hole').classList.contains('none'));
    ok('tour has five steps', document.querySelectorAll('#tour-dots i').length === 5 && document.getElementById('tour-step').textContent === '1 / 5');
    ok('tour: BACK is disabled on the first step', document.getElementById('tour-back').disabled);
    document.getElementById('tour-next').click(); await sleep(450);
    const hole = () => document.getElementById('tour-hole').getBoundingClientRect(), box = id => document.getElementById(id).getBoundingClientRect();
    const frames = id => { const h = hole(), b = box(id); return Math.abs(h.left - b.left) < 12 && Math.abs(h.top - b.top) < 12 && Math.abs(h.right - b.right) < 12 && Math.abs(h.bottom - b.bottom) < 12; };
    ok('tour step 2 spotlights the chat window', await until(() => frames('win-chat')));
    const card = box('tour-card');
    ok('tour: the guide card stays inside the viewport', card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight);
    ok('tour: the sample-question button is offered only when the assistant is online', document.getElementById('tour-ask').hidden === (AI.online !== true));
    key('ArrowRight'); await sleep(450);
    ok('tour step 3 opens and spotlights the Flow Monitor', shown('win-flow') && Flow.built && await until(() => frames('win-flow')));
    key('ArrowLeft'); await sleep(300);
    ok('tour: the left arrow goes back', Tour.i === 1);
    key('ArrowRight'); key('ArrowRight'); await sleep(450);
    ok('tour step 4 spotlights the dock', await until(() => frames('dock')));
    key('ArrowRight'); await sleep(450);
    ok('tour: the last step replaces SKIP with a finish button', document.getElementById('tour-skip').hidden && document.getElementById('tour-next').textContent === 'START EXPLORING');
    document.getElementById('tour-next').click(); await sleep(300);
    ok('finishing closes the tour', !Tour.active && !shown('tour'));
    ok('finishing closes the window the tour opened', !shown('win-flow') && shown('win-chat'));
    ok('the tour is remembered as seen (when storage is available)', stored('vc-os-toured') === '1' || stored('vc-os-toured') === undefined);
    Tour.start(); await sleep(150); key('Escape'); await sleep(150);
    ok('Escape skips the tour', !Tour.active && !shown('tour'));
    termRun('tour'); await sleep(700);
    ok('terminal `tour` replays it', Tour.active); Tour.end();

    mark('windows');
    closeAll(); openWin('win-about'); await sleep(500);   // past the open animation, which scales the window
    const w = document.getElementById('win-about'), tb = w.querySelector('.mac-tb'), r0 = w.getBoundingClientRect();
    const at = (type, x, y) => (type === 'mousedown' ? tb : document).dispatchEvent(new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true}));
    at('mousedown', r0.left + 120, r0.top + 8); at('mousemove', r0.left + 120, r0.top + 8);
    const r1 = w.getBoundingClientRect();
    ok('drag: a window does not jump when it is picked up', Math.abs(r1.top - r0.top) < 1 && Math.abs(r1.left - r0.left) < 1, (r1.top - r0.top) + 'px');
    at('mousemove', r0.left + 150, r0.top + 48); at('mouseup', 0, 0);
    const r2 = w.getBoundingClientRect();
    ok('drag: it follows the pointer exactly', Math.abs(r2.left - r0.left - 30) < 1 && Math.abs(r2.top - r0.top - 40) < 1);
    openWin('win-projects'); openWin('win-experience'); await sleep(150);
    ok('windows open inside the desktop', inside('win-projects') && inside('win-experience'));
    closeAll(); await sleep(50);
    ok('Close All closes every window, including Experience', [...document.querySelectorAll('.mac-win')].every(e => e.style.display === 'none'));
    openWin('win-ie'); await sleep(150);
    ok('Internet Explorer opens on its home page, not a blank one', document.querySelector('#ie-page-content .ie-home-screen canvas') !== null);
  } catch (e) { R.push('FAIL harness exception: ' + e.message + ' ' + (e.stack || '').split('\n')[0]); }
  ok('no uncaught JS errors', window.__errs.length === 0, JSON.stringify(window.__errs));
  await fetch('/report', {method: 'POST', body: JSON.stringify(R)});
})();
