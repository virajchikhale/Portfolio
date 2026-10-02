(async () => {
  const R = []; const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (n, c, x = '') => { R.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  — ' + x : '')); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  while (!document.getElementById('os').classList.contains('visible')) await sleep(100);
  await sleep(300);
  // EXACTLY what happened in the screenshot: open the monitor FIRST, from the dock, before anything else ran.
  ok('precondition: nothing has initialised the monitor yet', Flow.built === false && !Flow.wired);
  document.getElementById('dk-flow').click(); await sleep(300);
  ok('dock click opens the window', document.getElementById('win-flow').style.display === 'flex');
  ok('dock open: graph is built (8 nodes)', Flow.built && document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave)').length === 8);
  ok('dock open: mode hint is shown', document.getElementById('flow-mode-hint').textContent.length > 10, document.getElementById('flow-mode-hint').textContent);
  ok('dock open: a speed is highlighted', document.querySelectorAll('#flow-speed button.on').length === 1);
  document.querySelector('#flow-speed button[data-mode="2"]').click();
  ok('dock open: speed buttons are wired', Flow.mode === '2' && document.querySelector('#flow-speed button.on').dataset.mode === '2');
  // closing and reopening via the dock toggles cleanly
  document.getElementById('dk-flow').click(); await sleep(150);
  ok('dock click again closes it', document.getElementById('win-flow').style.display === 'none');
  document.getElementById('dk-flow').click(); await sleep(150);
  ok('and reopens it with the graph intact', document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave)').length === 8);
  // other open paths
  closeWin('win-flow'); openWin('win-flow'); await sleep(100);
  ok('plain openWin() also works', document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave)').length === 8);
  closeWin('win-flow'); termRun('flow'); await sleep(600);
  ok('terminal `flow` command works', document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave)').length === 8 && document.getElementById('win-flow').style.display === 'flex');
  closeWin('win-flow'); document.getElementById('chat-flow').click(); await sleep(200);
  ok('chat window FLOW button works', document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave)').length === 8);

  // retrieval-unavailable run: the monitor must say WHY and how to fix it
  Flow.setMode('live'); Flow.beginRun();
  const hint = 'Set DATABASE_URL (docker compose does this), or use VECTOR_STORE=memory for a local run.';
  for (const [id, label] of [['rate_limit', 'Rate limit'], ['guardrails', 'Guardrails'], ['embed', 'Embed'], ['dense', 'Vector'], ['keyword', 'Keyword'], ['fuse', 'Fuse']]) {
    Flow.push({id, label, phase: 'start', t: 1});
    Flow.push({id, phase: 'end', t: 2, dur: 1, status: id === 'rate_limit' || id === 'guardrails' ? 'ok' : 'skipped', detail: id === 'embed' ? 'retrieval unavailable: database_url_missing' : '', data: id === 'embed' ? {reason: 'database_url_missing', hint} : {}});
  }
  Flow.endRun(); await sleep(200);
  Flow._userPicked = true; Flow.selected = 'embed'; Flow.renderDetail('embed');
  const txt = document.getElementById('flow-detail').textContent;
  ok('skipped retrieval: node is marked skipped', document.querySelector('.fl-node[data-id="embed"]').classList.contains('skipped'));
  ok('skipped retrieval: the monitor shows the reason and the fix', txt.includes('database_url_missing') && txt.includes('How to fix') && txt.includes('DATABASE_URL'), txt.slice(0, 160));
  ok('no uncaught JS errors', window.__errs.length === 0, JSON.stringify(window.__errs));
  await fetch('/report', {method: 'POST', body: JSON.stringify(R)});
})();
