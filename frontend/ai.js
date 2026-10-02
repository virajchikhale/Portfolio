/* ════════════════════════════════════════════════════════════════
   VC·AI client — streams answers from the backend (/api/chat, SSE).

   SECURITY: model output is untrusted. It is ONLY ever inserted with
   textContent — never innerHTML — so it cannot inject markup or script.
════════════════════════════════════════════════════════════════ */
const AI = {
  history: [],      // [{role:'user'|'assistant', content}] — sent back for context
  busy: false,
  online: null,     // null = unknown, true/false after the first health check
  mode: 'pipeline', // pipeline = fixed retrieve->answer chain (fast, cheap) | agent = tool-calling loop
  setMode(m){
    this.mode = m === 'agent' ? 'agent' : 'pipeline';
    try{ localStorage.setItem('vc-ai-mode', this.mode); }catch(e){}
    aiRenderMode();
  },
  MAX_HISTORY: 6,   // the server only uses the last few turns anyway; sending more can exceed the proxy's body limit
  MAX_HISTORY_CHARS: 1200,  // per message: a long answer must not blow the request size up
  TIMEOUT_MS: 90000,  // longer than the server's own run limit, so the server reports the timeout, not the browser
};

function aiUrl(path){ return ((typeof CONFIG!=='undefined' && CONFIG.apiBase) || '') + path; }

/* Turn any failure into a short message that is safe to show the visitor. */
function aiErrorMessage(status, body){
  if(status === 404 || status === 405 || status === 0)
    return 'VC·AI is offline right now (no backend on this deployment).';
  if(status === 429) return 'Too many questions — please wait a moment and try again.';
  if(status === 503) return (body && (body.detail || body.error)) || 'The AI service is busy. Try again later.';
  if(status === 413) return (body && body.error) || 'That message is too long.';
  if(status === 400 || status === 422) return (body && body.error) || 'I can’t help with that question.';
  return 'Something went wrong. Please try again.';
}

/**
 * Ask a question. Calls onDelta(text) for each streamed chunk and onSources([{n,label}]) once, before the text,
 * when the answer is grounded in retrieved sources.
 * Resolves with the full answer; rejects with Error(message) (message is display-safe).
 */
async function aiAsk(message, onDelta, onSources){
  if(AI.busy) throw new Error('Still answering the previous question…');
  AI.busy = true;
  const flow = (typeof Flow !== 'undefined') ? Flow : null;
  // In slow "teaching" modes the Flow Monitor can hold the answer back until its animation reaches the LLM stage.
  const gate = flow ? flow.beginRun({q: message, mode: AI.mode}) : Promise.resolve();
  let released = false, held = '';
  gate.then(()=>{ released = true; if(held){ const h = held; held = ''; onDelta(h); } });
  const emit = chunk=>{ if(released) onDelta(chunk); else held += chunk; };
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), AI.TIMEOUT_MS);
  try{
    let res;
    try{
      res = await fetch(aiUrl('/api/chat'), {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({message, mode: AI.mode, history: AI.history.slice(-AI.MAX_HISTORY).map(m=>({role: m.role, content: m.content.slice(0, AI.MAX_HISTORY_CHARS)}))}),
        signal: ctrl.signal,
      });
    }catch(e){
      throw new Error(aiErrorMessage(0));
    }
    if(!res.ok){
      let body = null;
      try{ body = await res.json(); }catch(e){}
      // A blocked request still comes back with its trace, so the monitor can show WHERE it was stopped.
      if(flow && body && Array.isArray(body.trace)) body.trace.forEach(e=>flow.push(e));
      throw new Error(aiErrorMessage(res.status, body));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for(;;){
      const {done, value} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true});
      let i;
      while((i = buf.indexOf('\n\n')) >= 0){
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if(!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if(data === '[DONE]') continue;
        let evt;
        try{ evt = JSON.parse(data); }catch(e){ continue; }
        if(evt.trace){ if(flow) flow.push(evt.trace); continue; }
        if(evt.error) throw new Error(evt.error);
        if(Array.isArray(evt.sources)){ if(onSources) onSources(evt.sources); continue; }
        if(evt.delta){ full += evt.delta; emit(evt.delta); }
      }
    }
    if(flow) flow.endRun();
    await gate;                       // answer text is complete only once the animation has released it
    if(!full.trim()) throw new Error('No answer came back. Please try again.');
    AI.history.push({role:'user', content:message}, {role:'assistant', content:full});
    AI.history = AI.history.slice(-AI.MAX_HISTORY);
    return full;
  }catch(e){
    if(flow) flow.endRun();
    try{ await gate; }catch(_){}      // let the animation reach the failure point before the error text appears
    if(e.name === 'AbortError') throw new Error('The answer timed out. Please try again.');
    throw e;
  }finally{
    clearTimeout(timer);
    AI.busy = false;
  }
}

/* ── Health check (decides whether the UI says "online" or "offline") ── */
async function aiPing(){
  try{
    const r = await fetch(aiUrl('/api/health'), {signal: AbortSignal.timeout(4000)});
    AI.online = r.ok;
  }catch(e){ AI.online = false; }
  aiRenderStatus();
  return AI.online;
}

/* Keep every AGENT switch (chat window, Flow Monitor) in step with AI.mode. */
function aiRenderMode(){
  ['chat-agent', 'flow-agent'].forEach(id=>{ const el = document.getElementById(id); if(el) el.checked = AI.mode === 'agent'; });
}

function aiRenderStatus(){
  const el = document.getElementById('chat-status');
  if(!el) return;
  // A drawn dot (CSS) rather than a symbol character, which some platforms render as a colour emoji.
  const state = AI.online === null ? 'wait' : AI.online ? 'on' : 'off';
  el.textContent = '';
  const dot = document.createElement('span'); dot.className = 'st-dot ' + state;
  el.append(dot, document.createTextNode(AI.online === null ? 'checking' : AI.online ? 'online' : 'offline'));
}

/* ── Chat window ───────────────────────────────────────── */
function chatAppend(role, text){
  const log = document.getElementById('chat-log');
  const row = document.createElement('div');
  row.className = 'chat-msg ' + role;
  const who = document.createElement('div');
  who.className = 'chat-who';
  who.textContent = role === 'user' ? 'YOU' : 'VC·AI';
  const body = document.createElement('div');
  body.className = 'chat-text';
  body.textContent = text;            // textContent only — see SECURITY note
  row.append(who, body);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return body;
}

/* Under an answer: "Sources: [1] Work experience \u203A Data Science Intern \u2026" (labels come from our own
   corpus, but are still inserted as text only). */
function chatAppendSources(row, sources){
  const el = document.createElement('div');
  el.className = 'chat-sources';
  el.textContent = 'Sources: ' + sources.map(x=>'['+x.n+'] '+x.label).join('  \u00B7  ');
  row.appendChild(el);
  const log = document.getElementById('chat-log');
  log.scrollTop = log.scrollHeight;
}

function chatOpen(){
  openWin('win-chat');
  if(AI.online === null) aiPing();
  setTimeout(()=>{ const i = document.getElementById('chat-in'); if(i) i.focus(); }, 80);
}

async function chatSend(preset){
  const input = document.getElementById('chat-in');
  const sendBtn = document.getElementById('chat-send');
  const text = (preset || input.value).trim();
  if(!text || AI.busy) return;
  input.value = '';
  const sugg = document.getElementById('chat-suggest');
  if(sugg) sugg.remove();

  chatAppend('user', text);
  const out = chatAppend('ai', '…');
  let started = false, sources = [];
  sendBtn.disabled = true; input.disabled = true;
  try{
    await aiAsk(text, chunk=>{
      if(!started){ out.textContent = ''; started = true; }
      out.textContent += chunk;
      const log = document.getElementById('chat-log');
      log.scrollTop = log.scrollHeight;
    }, s=>{ sources = s; });
    if(sources.length) chatAppendSources(out.parentElement, sources);
  }catch(e){
    out.textContent = e.message;
    out.classList.add('chat-err');
    if(e.message.indexOf('offline') >= 0){ AI.online = false; aiRenderStatus(); }
  }finally{
    sendBtn.disabled = false; input.disabled = false;
    input.focus();
  }
}

function chatKey(e){ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); chatSend(); } }

function chatInit(){
  try{ AI.mode = localStorage.getItem('vc-ai-mode') === 'agent' ? 'agent' : 'pipeline'; }catch(e){}
  const ag = document.getElementById('chat-agent');
  if(ag) ag.addEventListener('change', e=>AI.setMode(e.target.checked ? 'agent' : 'pipeline'));
  aiRenderMode();
  const sugg = document.getElementById('chat-suggest');
  if(sugg){
    sugg.textContent = '';
    ((typeof CONFIG!=='undefined' && CONFIG.chatSuggestions) || []).forEach(q=>{
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chat-chip'; b.textContent = q;
      b.addEventListener('click', ()=>chatSend(q));
      sugg.appendChild(b);
    });
  }
  aiRenderStatus();
}

/* ── Terminal: `ask <question>` ───────────────────────────── */
async function askInTerminal(question, promptLabel){
  const out = document.getElementById('term-out');
  const block = document.createElement('div');
  block.className = 'term-block';
  const cmd = document.createElement('span');
  cmd.className = 't-cmd';
  cmd.textContent = promptLabel + ' ask ' + question;
  const ans = document.createElement('span');
  ans.className = 't-out';
  ans.style.whiteSpace = 'pre-wrap';
  ans.textContent = '…';
  block.append(cmd, ans);
  out.appendChild(block);
  out.scrollTop = out.scrollHeight;

  let started = false, sources = [];
  try{
    await aiAsk(question, chunk=>{
      if(!started){ ans.textContent = ''; started = true; }
      ans.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    }, s=>{ sources = s; });
    if(sources.length){
      const src = document.createElement('span');
      src.className = 't-out';
      src.style.whiteSpace = 'pre-wrap';
      src.style.color = '#777';
      src.textContent = 'sources: ' + sources.map(x=>'['+x.n+'] '+x.label).join(' | ');
      block.appendChild(src);
    }
  }catch(e){
    ans.className = 't-err';
    ans.textContent = e.message;
  }
  out.scrollTop = out.scrollHeight;
}
