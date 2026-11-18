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

/* ── Saved chat session (this browser only) ─────────────────────────────────────────────────────────────────────
   The conversation is kept in localStorage so a refresh does not lose it. There is no login and nothing is stored on
   the server: the backend still keeps no questions or answers. The session expires 24 h after the LAST message
   (sliding), and never lives longer than 7 days. Everything read back is validated (it is user-editable storage) and
   only ever inserted with textContent. Storage can be unavailable or full (private windows, blocked site data): every
   access is guarded and the chat simply works without saving. */
const AISession = {
  KEY: 'vc-ai-chat-v1',
  TTL_MS: 24 * 3600e3,         // sliding: counted from the last message
  MAX_AGE_MS: 7 * 24 * 3600e3, // hard cap: counted from the first message
  MAX_MESSAGES: 30,            // 15 question/answer pairs
  MAX_CHARS: 60000,            // whole saved document
  data: null,                  // {v, created, updated, messages:[{role, content, sources?}]}

  store(){ try{ return window.localStorage || null; }catch(e){ return null; } },
  available(){
    const st = this.store(); if(!st) return false;
    try{ st.setItem('vc-ai-probe', '1'); st.removeItem('vc-ai-probe'); return true; }catch(e){ return false; }
  },
  expired(d, now){ return now - d.updated > this.TTL_MS || now - d.created > this.MAX_AGE_MS; },
  isStale(){ return !!(this.data && this.expired(this.data, Date.now())); },

  sanitize(list){
    if(!Array.isArray(list)) return [];
    const out = [];
    for(const m of list){
      if(!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if(typeof m.content !== 'string' || !m.content.trim() || m.content.length > 8000) continue;
      const e = {role: m.role, content: m.content};
      if(Array.isArray(m.sources)){
        e.sources = m.sources.filter(s=>s && Number.isInteger(s.n) && s.n > 0 && s.n < 100 && typeof s.label === 'string')
          .slice(0, 8).map(s=>({n: s.n, label: s.label.slice(0, 200)}));
      }
      out.push(e);
    }
    const kept = out.slice(-this.MAX_MESSAGES);
    while(kept.length && kept[0].role !== 'user') kept.shift();   // never start mid-exchange
    return kept;
  },

  /** The saved messages, or [] (and the key is removed) when there is nothing valid and fresh. */
  load(){
    const st = this.store(); if(!st) return [];
    try{
      const raw = st.getItem(this.KEY); if(!raw) return [];
      const d = JSON.parse(raw);
      const msgs = this.sanitize(d && d.v === 1 ? d.messages : null);
      if(!msgs.length || !isFinite(d.created) || !isFinite(d.updated) || this.expired(d, Date.now())){
        st.removeItem(this.KEY); return [];
      }
      this.data = {v: 1, created: d.created, updated: d.updated, messages: msgs};
      return msgs;
    }catch(e){
      try{ st.removeItem(this.KEY); }catch(_){}
      return [];
    }
  },

  /** Record one finished exchange (a failed or blocked turn is never recorded). */
  append(question, answer, sources){
    const now = Date.now();
    if(!this.data || this.expired(this.data, now)) this.data = {v: 1, created: now, updated: now, messages: []};
    const msgs = this.data.messages;
    msgs.push({role: 'user', content: question}, {role: 'assistant', content: answer, sources: sources || []});
    while(msgs.length > this.MAX_MESSAGES) msgs.splice(0, 2);
    this.data.updated = now;
    const st = this.store(); if(!st) return;
    let json = JSON.stringify(this.data);
    while(json.length > this.MAX_CHARS && msgs.length > 2){ msgs.splice(0, 2); json = JSON.stringify(this.data); }
    try{ st.setItem(this.KEY, json); }catch(e){ /* full or blocked: keep chatting without saving */ }
  },

  clear(){
    this.data = null;
    try{ const st = this.store(); if(st) st.removeItem(this.KEY); }catch(e){}
  },
};

/* Retrieval runs for every question, so the server's source list can include sources the answer never used (a greeting
   still retrieves something). Show only the ones the answer actually cites: [1], [2] or [1, 2]. */
function aiCitedSources(answer, sources){
  const cited = new Set();
  String(answer).replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (_, list)=>{
    list.split(',').forEach(n=>cited.add(parseInt(n, 10))); return '';
  });
  return (sources || []).filter(s=>cited.has(s.n));
}

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
async function aiAsk(message, onDelta, onSources, onActions){
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
        if(Array.isArray(evt.actions)){ if(onActions) onActions(evt.actions); continue; }   // ids only: Actions owns every label
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

/* ── Page actions in the chat (see actions.js) ─────────────────────────────────────────────────────────────────── */

/* A line of buttons under a message: "Want the one-page version?  [OPEN READ ME]". Only ids that exist in Actions are
   drawn (so a bad id from anywhere is simply ignored), and the wording is Actions' own. The first offer is the one a
   typed "yes" answers, for the next message only. */
function chatAppendActions(row, ids){
  const good = ids.filter(id=>Actions.has(id));
  if(!good.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'chat-actions';
  const q = document.createElement('span');
  q.className = 'chat-actions-q';
  q.textContent = Actions.registry[good[0]].offer || 'Want me to do that?';
  wrap.appendChild(q);
  good.forEach(id=>{
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chat-link'; b.textContent = Actions.registry[id].label;
    b.addEventListener('click', ()=>{ Actions.pending = null; Actions.run(id); });
    wrap.appendChild(b);
  });
  row.appendChild(wrap);
  Actions.pending = good[0];
  const log = document.getElementById('chat-log'); log.scrollTop = log.scrollHeight;
}

/* A command typed on its own, or "yes" to the offer on screen. No server call, no model call, nothing saved: this is
   the page answering, not a conversation turn. */
function chatDoAction(text, id, fromYes){
  const sugg = document.getElementById('chat-suggest'); if(sugg) sugg.remove();
  chatAppend('user', text);
  const a = Actions.registry[id];
  if(a.confirm && !fromYes){
    // leaves the desktop: show a button instead of going straight away
    const body = chatAppend('ai', 'Sure. Open the Read Me page?');
    body.classList.add('chat-note');
    chatAppendActions(body.parentElement, [id]);
  }else{
    const body = chatAppend('ai', a.done);
    body.classList.add('chat-note');
    Actions.run(id);
  }
  chatRenderMeta();
}

function chatOpen(){
  openWin('win-chat');
  if(AI.online === null) aiPing();
  const log = document.getElementById('chat-log'); if(log) log.scrollTop = log.scrollHeight;   // restored history: start at the latest
  setTimeout(()=>{ const i = document.getElementById('chat-in'); if(i) i.focus(); }, 80);
}

/* The note under the log, and the NEW CHAT button (only useful once there is a conversation). */
function chatRenderMeta(){
  const note = document.getElementById('chat-saved'), btn = document.getElementById('chat-clear');
  const started = document.querySelectorAll('#chat-log .chat-msg').length > 1;
  if(btn) btn.hidden = !started;
  if(note) note.textContent = AISession.available() ? 'Chat is saved on this device for 24 h' : 'Chat is not saved in this browser';
}

function chatRenderSuggestions(){
  const sugg = document.getElementById('chat-suggest');
  if(!sugg) return;
  sugg.textContent = '';
  ((typeof CONFIG!=='undefined' && CONFIG.chatSuggestions) || []).forEach(q=>{
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chat-chip'; b.textContent = q;
    b.addEventListener('click', ()=>chatSend(q));
    sugg.appendChild(b);
  });
}

/* Start over: forget the saved session, the model's context and everything on screen except the greeting. */
function chatReset(){
  if(AI.busy) return;
  AISession.clear();
  AI.history = [];
  Actions.pending = null;
  document.querySelectorAll('#chat-log .chat-msg').forEach((el, i)=>{ if(i > 0) el.remove(); });
  let sugg = document.getElementById('chat-suggest');
  if(!sugg){
    sugg = document.createElement('div'); sugg.id = 'chat-suggest';
    document.getElementById('chat-log').appendChild(sugg);
  }
  chatRenderSuggestions();
  chatRenderMeta();
  const i = document.getElementById('chat-in'); if(i) i.focus();
}

/* On page load: put a saved conversation back on screen and back into the model's context. */
function chatRestore(){
  const msgs = AISession.load();
  if(msgs.length){
    const sugg = document.getElementById('chat-suggest'); if(sugg) sugg.remove();
    msgs.forEach(m=>{
      const body = chatAppend(m.role === 'user' ? 'user' : 'ai', m.content);
      if(m.role === 'assistant' && m.sources && m.sources.length) chatAppendSources(body.parentElement, m.sources);
    });
    AI.history = msgs.map(m=>({role: m.role, content: m.content})).slice(-AI.MAX_HISTORY);
  }
  chatRenderMeta();
}

async function chatSend(preset){
  const input = document.getElementById('chat-in');
  const sendBtn = document.getElementById('chat-send');
  const text = (preset || input.value).trim();
  if(!text || AI.busy) return;
  if(AISession.isStale()) chatReset();     // the tab sat open past the session's lifetime: start fresh
  input.value = '';
  // Page actions never reach the model: a command typed on its own, or "yes" to the offer on screen (good for one message).
  const offered = Actions.pending; Actions.pending = null;
  const yes = !!(offered && Actions.isYes(text));
  const typed = yes ? offered : Actions.match(text);
  if(typed){ chatDoAction(text, typed, yes); input.focus(); return; }
  const sugg = document.getElementById('chat-suggest');
  if(sugg) sugg.remove();

  chatAppend('user', text);
  const out = chatAppend('ai', '…');
  let started = false, sources = [], proposed = [];
  const clearBtn = document.getElementById('chat-clear');
  sendBtn.disabled = true; input.disabled = true; if(clearBtn) clearBtn.disabled = true;
  try{
    const answer = await aiAsk(text, chunk=>{
      if(!started){ out.textContent = ''; started = true; }
      out.textContent += chunk;
      const log = document.getElementById('chat-log');
      log.scrollTop = log.scrollHeight;
    }, s=>{ sources = s; }, a=>{ proposed = a; });
    const cited = aiCitedSources(answer, sources);
    if(cited.length) chatAppendSources(out.parentElement, cited);
    AISession.append(text, answer, cited);
    // Buttons: what the model proposed (agent mode) plus offers driven by what the VISITOR asked. Not saved with the chat.
    chatAppendActions(out.parentElement, Actions.merge(proposed, Actions.offersFor(text)));
  }catch(e){
    out.textContent = e.message;
    out.classList.add('chat-err');
    if(e.message.indexOf('offline') >= 0){ AI.online = false; aiRenderStatus(); }
  }finally{
    sendBtn.disabled = false; input.disabled = false; if(clearBtn) clearBtn.disabled = false;
    chatRenderMeta();
    input.focus();
  }
}

function chatKey(e){ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); chatSend(); } }

function chatInit(){
  try{ AI.mode = localStorage.getItem('vc-ai-mode') === 'agent' ? 'agent' : 'pipeline'; }catch(e){}
  const ag = document.getElementById('chat-agent');
  if(ag) ag.addEventListener('change', e=>AI.setMode(e.target.checked ? 'agent' : 'pipeline'));
  aiRenderMode();
  chatRenderSuggestions();
  chatRestore();
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
    const answer = await aiAsk(question, chunk=>{
      if(!started){ ans.textContent = ''; started = true; }
      ans.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    }, s=>{ sources = s; });
    sources = aiCitedSources(answer, sources);
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
