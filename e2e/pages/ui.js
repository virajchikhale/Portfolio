(async () => {
  const R = []; const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (n, c, x = '') => { R.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  — ' + x : '')); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  const mark = m => { R.push('..... ' + m); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  const Q = 'What did he do at Inorbvict?';
  const nodeEls = () => [...document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave)')];
  const ids = () => nodeEls().map(e => e.dataset.id);
  try {
    while (!document.getElementById('os').classList.contains('visible')) await sleep(100);
    await sleep(300);

    mark('network: nothing leaves the page by default');
    const seen = []; const origFetch = window.fetch;
    window.fetch = (u, o) => { seen.push(String(u)); return origFetch(u, o); };
    ieOpen('https://example.org/some/page'); await sleep(1800);
    ok('IE: live preview is OFF by default', CONFIG.ieLivePreview === false);
    ok('IE: typed address is NOT sent to any third party', !seen.some(u => /allorigins|google\.com|r\.jina|corsproxy/.test(u)), seen.join(' | ') || 'no requests');
    ok('IE: explains why and offers a link instead', document.getElementById('ie-page-content').textContent.includes('not sent to third-party') || document.getElementById('ie-page-content').textContent.includes('third-party'));
    const imgs = [...document.querySelectorAll('#ie-page-content img')].map(i => i.src);
    ok('IE: no remote images were requested (no favicon service)', imgs.every(s => !/^https?:/.test(s)), imgs.join(','));

    mark('xss in preview cards');
    const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2<\/script>';
    ieRenderOGCard('https://evil.example/a', {title: evil, desc: evil, siteName: evil, image: 'x" onerror="window.__pwn=3'});
    await sleep(200);
    let box = document.getElementById('ie-page-content');
    ok('XSS: hostile title/description rendered as inert text', !box.querySelector('script') && !box.querySelector('img[onerror]') && box.textContent.includes('<img src=x'));
    ok('XSS: a quote in the image URL cannot break out of the attribute', !box.querySelector('[onerror]') && !window.__pwn);
    ieRenderOGCard('https://evil.example/a', {title: 't', desc: 'd', image: 'javascript:window.__pwn=4'});
    await sleep(100);
    ok('XSS: javascript: image URLs are dropped', !document.querySelector('#ie-page-content img') && !window.__pwn);
    ieFallbackUnknown('https://a.test/"><img src=x onerror=window.__pwn=6>', 'a.test');
    await sleep(100);
    box = document.getElementById('ie-page-content');
    ok('XSS: hostile characters in the typed URL stay inert', !box.querySelector('img[onerror]') && !window.__pwn);
    const link = box.querySelector('a.ie-action-btn');
    ok('links open safely (noopener, http(s) only)', link && /^https:/.test(link.href) && link.rel.includes('noopener') && link.target === '_blank');
    for (const bad of ['javascript:window.__pwn=7', 'data:text/html,<script>window.__pwn=8<\/script>', 'file:///etc/passwd', 'vbscript:x']) {
      ieOpen(bad); await sleep(80);
    }
    ok('only http(s) addresses can be opened (javascript:, data:, file:, vbscript: refused)', !window.__pwn && document.getElementById('ie-url').value.indexOf('javascript') < 0);
    window.fetch = origFetch;

    mark('no emoji anywhere');
    ['win-about', 'win-skills', 'win-projects', 'win-contact', 'win-experience', 'win-ie', 'win-chat', 'win-flow', 'win-activity', 'win-terminal'].forEach(id => { try { openWin(id); } catch (e) {} });
    ieOpen('about:blank'); await sleep(300);
    ieOpen('https://github.com/virajchikhale'); await sleep(1800);
    await aiAsk(Q, () => {}); Flow.setMode('live'); await sleep(200);
    const allowed = new Set(['★', '●', '■', '©']);  // text-style symbols: the marquee, game lives, and a copyright sign
    const pict = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}️]/gu;
    const found = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; if (['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) continue;
      for (const m of n.textContent.matchAll(pict)) if (!allowed.has(m[0])) found[m[0]] = (found[m[0]] || 0) + 1;
    }
    document.querySelectorAll('[title],[aria-label],[placeholder]').forEach(e => { for (const a of ['title', 'aria-label', 'placeholder']) { const v = e.getAttribute(a) || ''; for (const m of v.matchAll(pict)) if (!allowed.has(m[0])) found[m[0]] = (found[m[0]] || 0) + 1; } });
    ok('no emoji or pictographs in any window, label or tooltip', Object.keys(found).length === 0, JSON.stringify(found));
    ok('the menu-bar mark is drawn text, not the private-use Apple glyph', document.querySelector('#mb-apple .mb-logo') && !document.getElementById('mb-apple').textContent.includes(''));
    ok('project cards carry no icon prefix', ![...document.querySelectorAll('.pc-head span')].some(e => /^\s*\S+\s+\S/.test(e.textContent) && pict.test(e.textContent)));
    ok('status dot is drawn (CSS), not a glyph', !!document.querySelector('#chat-status .st-dot'));
    ok('flow marks are plain words', ![...document.querySelectorAll('.fl-mark')].some(e => /[^\x20-\x7e]/.test(e.textContent)));
    ['win-about', 'win-skills', 'win-projects', 'win-contact', 'win-experience', 'win-ie', 'win-chat', 'win-flow', 'win-activity', 'win-terminal'].forEach(id => { try { closeWin(id); } catch (e) {} });

    mark('smooth switching: nodes are reconciled, not rebuilt');
    flowOpen(); await sleep(300);
    Flow.setMode('live'); AI.setMode('pipeline'); AI.history = [];
    await aiAsk(Q, () => {}); await sleep(400);
    const rate = document.querySelector('#flow-graph .fl-node[data-id="rate_limit"]');
    const guard = document.querySelector('#flow-graph .fl-node[data-id="guardrails"]');
    const embedEl = document.querySelector('#flow-graph .fl-node[data-id="embed"]');
    ok('pipeline graph has 8 nodes', nodeEls().length === 8);
    AI.setMode('agent'); AI.history = [];
    await aiAsk(Q, () => {});
    await sleep(120);
    ok('switching to agent mode keeps the SAME rate-limit and guardrails elements (no flash)',
      document.querySelector('#flow-graph .fl-node[data-id="rate_limit"]') === rate && document.querySelector('#flow-graph .fl-node[data-id="guardrails"]') === guard);
    ok('pipeline-only nodes are fading out, not snapped away', embedEl.classList.contains('fl-leave') || !document.contains(embedEl));
    ok('agent nodes are added', ids().includes('step_1') && ids().includes('tool_1'), ids().join(','));
    await sleep(450);
    ok('faded-out nodes are removed from the DOM afterwards', !document.contains(embedEl));
    ok('no duplicate node ids at rest', new Set(ids()).size === ids().length);
    ok('new nodes finished their fade-in', !document.querySelector('#flow-graph .fl-enter'));
    const stepEl = document.querySelector('#flow-graph .fl-node[data-id="step_1"]');
    AI.setMode('agent'); AI.history = [];
    await aiAsk(Q, () => {}); await sleep(80);
    ok('a second agent run reuses stable base nodes again', document.querySelector('#flow-graph .fl-node[data-id="rate_limit"]') === rate);
    AI.setMode('pipeline'); AI.history = [];
    await aiAsk(Q, () => {}); await sleep(500);
    ok('back to pipeline: 8 nodes, base nodes still the same elements',
      nodeEls().length === 8 && document.querySelector('#flow-graph .fl-node[data-id="rate_limit"]') === rate && ids().includes('embed') && !ids().includes('step_1'), ids().join(','));
    await sleep(400);
    ok('after the transitions settle every node and edge is fully visible (opacity 1)',
      [...document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave), #flow-graph .fl-edge:not(.fl-leave)')].every(e => getComputedStyle(e).opacity === '1'),
      [...document.querySelectorAll('#flow-graph .fl-node:not(.fl-leave), #flow-graph .fl-edge:not(.fl-leave)')].filter(e => getComputedStyle(e).opacity !== '1').map(e => e.dataset.id || e.dataset.edge).join(','));
    ok('nodes have transitions (glide + fade) in CSS', getComputedStyle(rate).transitionProperty.includes('transform') && getComputedStyle(rate).transitionProperty.includes('opacity'));

    ok('controls follow the theme (custom checkbox and select, not native)',
      getComputedStyle(document.getElementById('flow-runs')).appearance === 'none' && getComputedStyle(document.getElementById('flow-agent')).appearance === 'none');
    mark('fallback: agent -> pipeline inside one run');
    Flow.setMode('live'); Flow.beginRun({q: 'synthetic', mode: 'agent'});
    Flow.push({id: 'rate_limit', phase: 'start', label: 'Rate limit', t: 0}); Flow.push({id: 'rate_limit', phase: 'end', t: 1, dur: 1, status: 'ok'});
    Flow.push({id: 'guardrails', phase: 'start', label: 'Guardrails', t: 1}); Flow.push({id: 'guardrails', phase: 'end', t: 2, dur: 1, status: 'ok'});
    Flow.push({id: 'meta', phase: 'meta', t: 2, mode: 'agent', requested: 'agent', note: null});
    Flow.push({id: 'step_1', phase: 'start', label: 'Agent step 1', t: 3}); Flow.push({id: 'step_1', phase: 'end', t: 4, dur: 1, status: 'error', detail: 'model call failed', data: {}});
    await sleep(100);
    ok('agent graph shown while the agent runs', Flow.kind === 'agent' && ids().includes('step_1'));
    const guard2 = document.querySelector('#flow-graph .fl-node[data-id="guardrails"]');
    Flow.push({id: 'meta', phase: 'meta', t: 5, mode: 'pipeline', requested: 'agent', note: 'the agent could not answer, so the fast pipeline was used'});
    Flow.push({id: 'embed', phase: 'start', label: 'Embed', t: 6}); Flow.push({id: 'embed', phase: 'end', t: 7, dur: 1, status: 'ok', data: {}});
    await sleep(500);
    ok('fallback: graph switched to the pipeline, base nodes untouched', Flow.kind === 'pipeline' && document.querySelector('#flow-graph .fl-node[data-id="guardrails"]') === guard2 && ids().includes('embed') && !ids().includes('step_1'), ids().join(','));
    Flow.endRun(); await sleep(100);
    ok('fallback: the monitor tells the visitor', document.getElementById('flow-status').textContent.includes('fast pipeline'));

    mark('run history');
    AI.setMode('pipeline'); AI.history = []; Flow.runs = []; 
    for (const q of ['first question', 'second question about skills', 'third']) { await aiAsk(q, () => {}); }
    await sleep(100);
    const sel = document.getElementById('flow-runs');
    ok('history lists this visit\'s runs, newest first', sel.options.length === 3 && sel.options[0].textContent.includes('third') && sel.options[2].textContent.includes('first question'), [...sel.options].map(o => o.textContent).join(' | '));
    ok('history selector is enabled once there are 2+ runs', sel.disabled === false);
    Flow.setMode('live'); sel.value = '2'; sel.dispatchEvent(new Event('change')); await sleep(150);
    ok('choosing an earlier run replays it', Flow.cur && Flow.cur.replay === true && Flow.cur.info.q === 'first question');
    ok('a replay is not added to the history', Flow.runs.length === 3);
    Flow.runs = []; for (let i = 0; i < 12; i++) { AI.history = []; await aiAsk('q' + i, () => {}); }
    ok('history is capped at 8 runs', Flow.runs.length === 8);
    Flow.runs[0].info.q = '<img src=x onerror=window.__pwn=9>'; Flow.renderRuns();
    ok('a question shown in the history list is inert text', !document.querySelector('#flow-runs img') && !window.__pwn);

    mark('request size');
    const bodies = []; const f2 = window.fetch;
    window.fetch = (u, o) => { if (String(u).includes('/api/chat')) bodies.push(JSON.parse(o.body)); return f2(u, o); };
    AI.history = Array.from({length: 20}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: (i % 2 ? 'a' : 'q').repeat(i % 2 ? 3000 : 700)}));  // realistic: questions are <= 800 chars, answers can be long
    await aiAsk('hello', () => {}); window.fetch = f2;
    ok('chat sends at most 6 history entries', bodies[0].history.length <= 6, bodies[0].history.length + '');
    ok('each history entry is capped at 1200 characters', bodies[0].history.every(m => m.content.length <= 1200));
    ok('the whole request stays far below the proxy limit (64 KB)', JSON.stringify(bodies[0]).length < 16000, JSON.stringify(bodies[0]).length + ' bytes');

    mark('activity window');
    activityOpen(); await sleep(900);
    ok('activity window opens and renders sections', document.querySelectorAll('#act-body .act-sec').length >= 5, document.querySelectorAll('#act-body .act-sec').length + ' sections');
    ok('activity shows counted questions', /questions\s*\d+/.test(document.getElementById('act-body').textContent.replace(/\s+/g, ' ')) && Activity.data.runs.total >= 6);
    ok('activity never shows question text', !document.getElementById('act-body').textContent.includes('Inorbvict') && !document.getElementById('act-body').textContent.includes('second question'));
    ok('activity auto-refreshes only while open', Activity.timer !== null);
    document.querySelector('#act-window button[data-w="7d"]').click(); await sleep(500);
    ok('time-window buttons work', Activity.window === '7d' && document.querySelector('#act-window button.on').dataset.w === '7d' && Activity.data.window === '7d');
    closeWin('win-activity'); await sleep(50);
    ok('closing the window stops the refresh timer', Activity.timer === null);
    eval("CONFIG.apiBase='http://localhost:9'"); activityOpen(); await sleep(900);
    ok('offline backend: a clear note, no crash', document.getElementById('act-body').textContent.includes('unavailable'));
    eval("CONFIG.apiBase=''"); closeWin('win-activity');
    Activity.data = {enabled: true, window: '24h', uptime_s: 5, runs: {total: 1, by_mode: {pipeline: 1, agent: 0}, by_outcome: {ok: 1, blocked: 0, empty: 0, error: 0, cancelled: 0}},
      latency_ms: {p50: 1, p95: 1}, ttft_ms: {p50: 1}, answers: {with_sources: 1, without_sources: 0, with_sources_pct: 100}, agent: {runs: 0, avg_steps: null, avg_tool_calls: null, fallbacks: 0}, stages_p50_ms: {'<img src=x onerror=window.__pwn=10>': 3}};
    Activity.render();
    ok('activity renders unexpected keys as text, never markup', !document.querySelector('#act-body img') && !window.__pwn);
    Activity.data = {enabled: false}; Activity.render();
    ok('activity explains when statistics are switched off', document.getElementById('act-body').textContent.includes('switched off'));

    mark('terminal commands');
    closeWin('win-activity'); termRun('stats'); await sleep(700);
    ok('terminal `stats` opens Activity', document.getElementById('win-activity').style.display === 'flex');
  } catch (e) { R.push('FAIL harness exception: ' + e.message + ' ' + (e.stack || '').split('\n')[0]); }
  ok('no uncaught JS errors', window.__errs.length === 0, JSON.stringify(window.__errs));
  await fetch('/report', {method: 'POST', body: JSON.stringify(R)});
})();
