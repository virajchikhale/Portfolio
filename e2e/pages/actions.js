/* Page actions in the chat: typed commands run locally (no server call), offers are buttons, "yes" is good for one
   message, the allowlist holds, and in agent mode a model-proposed action is only ever a button. TS backend only. */
(async () => {
  const R = []; const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (n, c, x = '') => { R.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  — ' + x : '')); fetch('/report', {method: 'POST', body: JSON.stringify(R)}); };
  const log = () => document.getElementById('chat-log');
  const msgs = () => [...log().querySelectorAll('.chat-msg')];
  const last = () => msgs().at(-1);
  const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
  const theme = () => document.body.dataset.theme;
  const saved = () => { try { return JSON.parse(localStorage.getItem('vc-ai-chat-v1')); } catch (e) { return null; } };
  // count real chat requests, and capture navigation instead of leaving the page
  const realFetch = window.fetch.bind(window); let chatCalls = 0;
  window.fetch = (u, ...a) => { if (String(u).includes('/api/chat')) chatCalls++; return realFetch(u, ...a); };
  let nav = null; Actions.go = url => { nav = url; };
  try {
    let waited = 0;
    while (!document.getElementById('os').classList.contains('visible') && waited < 15000) { await sleep(100); waited += 100; }
    ok('the OS boots', document.getElementById('os').classList.contains('visible'));
    Flow.setMode('live'); AI.setMode('pipeline'); openWin('win-chat'); try { localStorage.removeItem('vc-ai-chat-v1'); } catch (e) {}

    // ── typed commands: instant, local, free ──
    setTheme('light');
    await chatSend('dark mode');
    ok('"dark mode" switches the theme, with no server call', theme() === 'dark' && chatCalls === 0, 'calls=' + chatCalls);
    ok('...and the page answers in the chat', last().textContent.includes('Switched to dark mode.'));
    await chatSend('can you switch to light mode please?');
    ok('"can you switch to light mode please?" switches back', theme() === 'light' && chatCalls === 0);
    await chatSend('turn on dark mode'); await chatSend('turn off dark mode');
    ok('"turn off dark mode" means light mode', theme() === 'light' && chatCalls === 0);
    closeAll(); await chatSend('open projects'); await sleep(100);
    ok('"open projects" opens the Projects window', shown('win-projects') && chatCalls === 0);
    await chatSend('show me the skills'); await sleep(100);
    ok('"show me the skills" opens Skills', shown('win-skills') && chatCalls === 0);
    await chatSend('start the tour'); await sleep(200);
    ok('"start the tour" starts the tour', Tour.active === true && chatCalls === 0); Tour.end(); await sleep(150);
    ok('local commands are not part of the conversation: nothing sent to the model, nothing saved', AI.history.length === 0 && saved() === null);

    // ── questions still go to the model ──
    await chatSend('what is his dark mode experience?');
    ok('a QUESTION that mentions dark mode goes to the model and does not switch the theme', chatCalls === 1 && theme() === 'light' && last().textContent.length > 20, 'calls=' + chatCalls);
    await chatSend('show me his projects');
    ok('"show me his projects" is a question, not a command', chatCalls === 2);
    ok('a normal answer is saved, as before', saved() && saved().messages.length === 4);

    // ── Read Me: always a button first ──
    closeAll(); chatReset(); chatCalls = 0; nav = null;   // (an already-open window is never offered again, so start clean)
    await chatSend('open the read me');
    ok('"open the read me" does NOT navigate on its own', nav === null && chatCalls === 0);
    const btn = last().querySelector('.chat-actions button');
    ok('...it offers a button instead', !!btn && btn.textContent === 'OPEN READ ME' && Actions.pending === 'readme');
    await chatSend('yes');
    ok('typing "yes" confirms it: navigates to readme.html, no server call', nav === 'readme.html' && chatCalls === 0, String(nav));
    nav = null; chatReset(); await chatSend('read me'); last().querySelector('.chat-actions button').click();
    ok('clicking the button navigates too', nav === 'readme.html');

    // ── offers after an answer, driven by what the visitor asked ──
    nav = null; closeAll(); chatReset(); chatCalls = 0;
    await chatSend('Give me a quick summary');
    const offer = last().querySelector('.chat-actions');
    ok('"Give me a quick summary" is answered, then offers the Read Me as a button', chatCalls === 1 && offer && offer.querySelector('button').textContent === 'OPEN READ ME' && nav === null);
    ok('the offer is not saved with the chat', saved().messages.every(m => !('actions' in m)) && JSON.stringify(saved()).indexOf('OPEN READ ME') < 0);
    await chatSend('yes please');
    ok('"yes please" accepts the offer without another model call', nav === 'readme.html' && chatCalls === 1);

    // ── "yes" is good for the NEXT message only, and only for what is on screen ──
    nav = null; closeAll(); chatReset(); chatCalls = 0;
    await chatSend('Give me a quick summary'); await chatSend('What are his skills?');
    ok('asking something else first: the old offer is gone, the newest one is pending', nav === null && Actions.pending === 'open-skills', String(Actions.pending));
    await chatSend('What is the weather in Paris?');
    ok('an unrelated question leaves nothing pending', Actions.pending === null);
    const before = chatCalls; await chatSend('yes');
    ok('"yes" with nothing pending is just a message for the model', chatCalls === before + 1 && nav === null);

    // ── a window that is already open is not offered again ──
    closeAll(); openWin('win-skills'); chatReset(); await chatSend('What are his skills?'); await sleep(50);
    ok('no "open Skills" offer while the Skills window is already open', Actions.pending === null && !last().querySelector('.chat-actions'));
    closeAll();

    // ── the allowlist holds in the browser ──
    chatReset(); chatAppend('ai', 'x'); const row = last();
    chatAppendActions(row, ['readme', 'evil', '__proto__', 'javascript:alert(1)', 'constructor']);
    ok('unknown ids from anywhere draw no button; known ones use the page\'s own label',
      row.querySelectorAll('.chat-actions button').length === 1 && row.querySelector('.chat-actions button').textContent === 'OPEN READ ME');
    ok('Actions.run refuses unknown ids and prototype names', !Actions.run('__proto__') && !Actions.run('javascript:alert(1)') && !Actions.run('toString') && nav === null);

    // ── hostile text ──
    chatReset(); chatCalls = 0;
    await chatSend('<img src=x onerror=window.__pwn=1> projects summary');
    ok('markup in the question is shown as text, and nothing executed', !window.__pwn && !log().querySelector('img') && log().textContent.includes('<img src=x'));
    ok('...while the visitor-driven offers still appear', !!last().querySelector('.chat-actions'));

    // ── restore: offers do not come back after a reload ──
    const wipeDom = () => msgs().forEach((el, i) => { if (i > 0) el.remove(); });
    wipeDom(); chatRestore();
    ok('after a reload the saved messages return but no buttons do', msgs().length >= 3 && log().querySelectorAll('.chat-actions').length === 0);

    // ── agent mode: the model proposes, the visitor disposes ──
    chatReset(); AI.setMode('agent'); nav = null; chatCalls = 0;
    await chatSend('can you tell me about the read me page and his work?');
    const ab = last().querySelector('.chat-actions button');
    ok('agent mode: a model-proposed action appears as a button', chatCalls === 1 && !!ab && ab.textContent === 'OPEN READ ME', 'calls=' + chatCalls);
    ok('...it did NOT run by itself', nav === null);
    ok('the Flow Monitor trace shows the model offered an action', JSON.stringify((Flow.last && Flow.last.events) || []).includes('suggest_action'));
    ok('the model\'s own text did not become a command or a label', !last().querySelector('.chat-text').textContent.includes('suggest_action'));
    ab.click();
    ok('only the click runs it', nav === 'readme.html');

    // ── NEW CHAT forgets a pending offer ──
    AI.setMode('pipeline'); chatReset(); await chatSend('Give me a quick summary'); chatReset();
    ok('NEW CHAT clears a pending offer', Actions.pending === null);
  } catch (e) { R.push('FAIL harness exception: ' + e.message + ' ' + (e.stack || '').split('\n')[0]); }
  ok('no uncaught JS errors', window.__errs.length === 0, JSON.stringify(window.__errs));
  await fetch('/report', {method: 'POST', body: JSON.stringify(R)});
})();
