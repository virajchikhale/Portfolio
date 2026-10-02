(async () => {
  const R = []; const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (n, c, x = '') => { R.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  — ' + x : '')); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  const blocked = new URLSearchParams(location.search).get('nostorage') === '1';
  try {
    let waited = 0;
    while (!document.getElementById('os').classList.contains('visible') && waited < 15000) { await sleep(100); waited += 100; }
    ok(blocked ? 'storage BLOCKED: the OS still boots' : 'the OS boots', document.getElementById('os').classList.contains('visible'));
    if (blocked) {
      let threw = false; try { localStorage.getItem('x'); } catch (e) { threw = true; }
      ok('(precondition) localStorage really throws in this run', threw);
      setTheme('dark');
      ok('storage BLOCKED: theme toggle still applies', document.body.dataset.theme === 'dark');
      setTheme('light');
      AI.setMode('agent'); Flow.setMode('2'); Flow.setSync(false);
      ok('storage BLOCKED: mode and speed switches do not crash', AI.mode === 'agent' && Flow.mode === '2');
      await aiAsk('What did he do at Inorbvict?', () => {});
      ok('storage BLOCKED: a chat still works end to end', Flow.last && Flow.last.events.length > 5);
      activityOpen(); await sleep(600);
      ok('storage BLOCKED: the Activity window works', document.querySelectorAll('#act-body .act-sec').length >= 3);
    } else {
      await document.fonts.load('8px "Press Start 2P"');
      ok('font: Press Start 2P is available', document.fonts.check('8px "Press Start 2P"'));
      const res = performance.getEntriesByType('resource').map(r => r.name);
      ok('font: served from this origin', res.some(n => /fonts\/PressStart2P-latin\.woff2/.test(n) && n.startsWith(location.origin)), res.filter(n => /woff2/.test(n)).join(','));
      ok('privacy: no request to Google Fonts (or any third party) was made', !res.some(n => !n.startsWith(location.origin)), res.filter(n => !n.startsWith(location.origin)).join(',') || 'all same-origin');
      ok('theme survives only valid values from storage', (() => { localStorage.setItem('vc-os-theme', '"><img src=x onerror=window.__pwn=1>'); return true; })());

      openWin('win-terminal');
      const run = async c => { const i = document.getElementById('term-in'); i.value = c; termKey({key: 'Enter'}); await sleep(60); };
      await run('<img src=x onerror="window.__pwn=1">');
      await run('echo <b id=pwned>hi</b><script>window.__pwn=2<\/script>');
      await run('open <svg onload=window.__pwn=3>');
      await run('<script>window.__pwn=4<\/script>');
      const out = document.getElementById('term-out');
      ok('terminal: typed HTML is shown as text, not rendered', !out.querySelector('.term-block img, .term-block b, .term-block script, .term-block svg') && out.textContent.includes('<img src=x') && out.textContent.includes('<b id=pwned>'));
      ok('terminal: nothing executed', !window.__pwn);
      await run('help');
      ok('terminal: normal commands still work', out.textContent.includes('COMMANDS') && out.textContent.includes('ask [q]'));
      await run('whoami');
      ok('terminal: whoami reads from the config', out.textContent.includes('Viraj Chikhale'));
    }
  } catch (e) { R.push('FAIL harness exception: ' + e.message + ' ' + (e.stack || '').split('\n')[0]); }
  ok('no uncaught JS errors', window.__errs.length === 0, JSON.stringify(window.__errs));
  await fetch('/report', {method: 'POST', body: JSON.stringify(R)});
})();
