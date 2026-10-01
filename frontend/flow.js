/* ════════════════════════════════════════════════════════════════
   FLOW MONITOR — live visualisation of what happens when you ask VC·AI a question.

   The backend streams one TRACE event per pipeline stage (start/end, real timestamps, real data: timings,
   retrieved chunks + scores, matched keywords...). This file replays them as an animated graph.

   Speed control:  LIVE  show events as they arrive (true timing)
                   2× 1× ½×  "teaching" speeds: each stage stays on screen for a minimum dwell time so it can be read
                   STEP  wait for NEXT before every stage
   The speed controls PLAYBACK. The backend itself is never slowed down.

   SECURITY: every value shown comes from the server and is inserted with textContent only — never innerHTML.
════════════════════════════════════════════════════════════════ */
const FLOW_NODES = [
  {id:'rate_limit', label:'RATE LIMIT', preds:[]},
  {id:'guardrails', label:'GUARDRAILS', preds:['rate_limit']},
  {id:'embed',      label:'EMBED',      preds:['guardrails']},
  {id:'dense',      label:'VECTOR',     preds:['embed']},
  {id:'keyword',    label:'KEYWORD',    preds:['embed']},
  {id:'fuse',       label:'FUSE + GATE',preds:['dense','keyword']},
  {id:'prompt',     label:'PROMPT',     preds:['fuse']},
  {id:'llm',        label:'LLM',        preds:['prompt']},
];
/* Two hand-placed layouts (box = 124x44). "wide" for normal windows, "tall" for narrow/mobile ones. */
const FLOW_LAYOUTS = {
  wide: {w:640, h:262, pos:{
    rate_limit:[14,14], guardrails:[258,14], embed:[502,14],
    dense:[330,110], keyword:[502,110],
    fuse:[440,206], prompt:[226,206], llm:[14,206]},
    paths:{
      'rate_limit>guardrails':'M138 36 H258', 'guardrails>embed':'M382 36 H502',
      'embed>dense':'M564 58 V84 H392 V110', 'embed>keyword':'M564 58 V110',
      'dense>fuse':'M392 154 V180 H502 V206', 'keyword>fuse':'M564 154 V180 H502',
      'fuse>prompt':'M440 228 H350', 'prompt>llm':'M226 228 H138'}},
  tall: {w:300, h:416, pos:{
    rate_limit:[88,10], guardrails:[88,66], embed:[88,122],
    dense:[14,186], keyword:[162,186],
    fuse:[88,250], prompt:[88,306], llm:[88,362]},
    paths:{
      'rate_limit>guardrails':'M150 54 V66', 'guardrails>embed':'M150 110 V122',
      'embed>dense':'M150 166 V176 H76 V186', 'embed>keyword':'M150 166 V176 H224 V186',
      'dense>fuse':'M76 230 V240 H150 V250', 'keyword>fuse':'M224 230 V240 H150',
      'fuse>prompt':'M150 294 V306', 'prompt>llm':'M150 350 V362'}},
};
const SVGNS = 'http://www.w3.org/2000/svg';
const TOOL_LABELS = {search_portfolio:'SEARCH', load_skill:'LOAD SKILL', list_projects:'LIST PROJECTS', get_project:'GET PROJECT'};

/* Agent mode draws a chain that GROWS as the model decides: rate limit -> guardrails -> think -> tool -> think ...
   Wide windows snake across 3 columns; narrow ones stack vertically. */
function agentLayout(nodes, kind){
  const pos = {}, paths = {};
  if(kind === 'tall'){
    nodes.forEach((n, i)=>{ pos[n.id] = [88, 10 + i*56]; });
    nodes.forEach((n, i)=>{ if(i){ const a = pos[nodes[i-1].id], b = pos[n.id]; paths[nodes[i-1].id+'>'+n.id] = `M${a[0]+62} ${a[1]+44} V${b[1]}`; } });
    return {w:300, h:Math.max(416, 10 + nodes.length*56), pos, paths};
  }
  const cols = [14, 258, 502];
  nodes.forEach((n, i)=>{ const r = Math.floor(i/3), c = i % 3; pos[n.id] = [cols[r % 2 === 0 ? c : 2 - c], 14 + r*96]; });
  nodes.forEach((n, i)=>{
    if(!i) return;
    const a = pos[nodes[i-1].id], b = pos[n.id];
    paths[nodes[i-1].id+'>'+n.id] = a[1] === b[1]
      ? (b[0] > a[0] ? `M${a[0]+124} ${a[1]+22} H${b[0]}` : `M${a[0]} ${a[1]+22} H${b[0]+124}`)
      : `M${a[0]+62} ${a[1]+44} V${b[1]}`;
  });
  const rows = Math.ceil(nodes.length / 3);
  return {w:640, h:Math.max(262, 14 + (rows-1)*96 + 44 + 14), pos, paths};
}

const Flow = {
  mode: 'live',          // live | 2 | 1 | 0.5 | step
  sync: true,            // hold the chat answer until the animation reaches the LLM stage (teaching modes only)
  BASE_DWELL: 1000,      // ms a stage stays on screen at 1x
  cur: null,             // current/last run: {events:[], done:false}
  last: null,            // last completed run (for replay)
  nodes: {},             // id -> {status, dur, detail, data}
  token: 0,              // bumps to cancel a running player
  queue: [],
  playing: false,
  skipping: false,
  _more: null, _step: null, _gate: null,
  selected: null,
  kind: 'pipeline',      // pipeline (fixed 8-stage chain) | agent (growing chain; set by the server's meta event)
  dyn: [],               // agent mode: [{id, label}] nodes added as steps/tools start
  _finalStep: null, _started: {},
  layout: 'wide',
  built: false,
  _logLines: [],

  /* ── settings ─────────────────────────────────────────────── */
  init(){
    try{
      const m = localStorage.getItem('vc-flow-mode'); if(m) this.mode = m;
      const s = localStorage.getItem('vc-flow-sync'); if(s !== null) this.sync = s === '1';
    }catch(e){}
    if(!['live','2','1','0.5','step'].includes(this.mode)) this.mode = 'live';
  },
  setMode(m){
    this.mode = m;
    try{ localStorage.setItem('vc-flow-mode', m); }catch(e){}
    this.renderControls();
    if(this._step && m !== 'step'){ const r = this._step; this._step = null; r(); }   // leaving STEP unblocks it
  },
  setSync(v){
    this.sync = !!v;
    try{ localStorage.setItem('vc-flow-sync', this.sync ? '1' : '0'); }catch(e){}
  },
  windowOpen(){
    const w = document.getElementById('win-flow');
    return !!w && w.style.display !== 'none' && w.style.display !== '';
  },
  factor(){ return this.mode === 'step' ? 1 : (parseFloat(this.mode) || 1); },
  // Nobody is watching a hidden tab (and browsers pause its animation frames), so never make the chat wait for it.
  hurry(){ return this.mode === 'live' || this.skipping || document.hidden; },
  dwell(){ return this.hurry() ? 0 : this.BASE_DWELL / this.factor(); },
  travel(){ return this.hurry() ? 150 : Math.max(150, this.BASE_DWELL * 0.35 / this.factor()); },

  /* ── run lifecycle (called from ai.js) ─────────────────────── */
  beginRun(){
    this.token++;
    this.cur = {events: [], done: false};
    this.queue = []; this.playing = false; this.skipping = false;
    if(this._more){ const r = this._more; this._more = null; r(); }
    this._resetVisuals();
    // The chat answer waits for the animation only in teaching modes and only if the monitor is on screen.
    const gated = this.mode !== 'live' && this.sync && this.windowOpen();
    this._gate = {open: !gated, waiters: []};
    return this.answerGate();
  },
  answerGate(){
    const g = this._gate;
    if(!g || g.open) return Promise.resolve();
    return new Promise(res=>g.waiters.push(res));
  },
  _openGate(){
    const g = this._gate; if(!g || g.open) return;
    g.open = true; g.waiters.splice(0).forEach(r=>r());
  },
  push(evt){
    if(!this.cur) this.beginRun();
    // In agent mode a step is only known to be the FINAL one (the one that streams the answer) when it ends.
    if(evt.phase === 'end' && /^step_/.test(evt.id) && evt.data && evt.data.final) this._finalStep = evt.id;
    this.cur.events.push(evt);
    this.queue.push(evt);
    this._kick();
  },
  endRun(){
    if(!this.cur) return;
    this.cur.done = true;
    if(this.cur.events.length) this.last = this.cur;
    if(this._more){ const r = this._more; this._more = null; r(); }
    this._kick();
  },
  skip(){
    this.skipping = true;
    if(this._wake){ const w = this._wake; this._wake = null; w(); }
    if(this._step){ const r = this._step; this._step = null; r(); }
    if(this._more){ const r = this._more; this._more = null; r(); }
    if(!this.playing) this._drainInstantly();
    this.renderControls();
  },
  next(){ if(this._step){ const r = this._step; this._step = null; r(); this.renderControls(); } },
  replay(){
    if(!this.last) return;
    this.token++;
    this.cur = {events: this.last.events.slice(), done: true, replay: true};
    this.queue = this.last.events.slice(); this.playing = false; this.skipping = false;
    this._gate = {open: true, waiters: []};
    this._resetVisuals();
    this._kick();
  },

  /* ── player ───────────────────────────────────────────────── */
  _sleep(ms, token){
    return new Promise(res=>{
      if(ms <= 0 || this.hurry()) return res();
      const t = setTimeout(res, ms);
      this._wake = ()=>{ clearTimeout(t); res(); };
    });
  },
  _kick(){
    if(!this.built || !this.windowOpen()){
      // No monitor on screen: nothing to animate. Record state instantly so opening it later shows the run.
      this._drainInstantly();
      return;
    }
    if(this.mode === 'live'){ this._drainLive(); return; }
    if(!this.playing) this._play(this.token);
  },
  _drainInstantly(){
    while(this.queue.length) this._apply(this.queue.shift(), true);
    if(this.cur && this.cur.done){ this._openGate(); this._status(); }
    this._openGate();
  },
  _drainLive(){
    // LIVE: events are shown the moment they arrive; stages overlap exactly as they really did.
    while(this.queue.length) this._apply(this.queue.shift(), false);
    if(this.cur && this.cur.done){ this._openGate(); this._status(); }
  },
  async _play(token){
    this.playing = true;
    const active = {};                       // id -> time the stage was shown active
    try{
      while(token === this.token){
        if(!this.queue.length){
          if(this.cur && this.cur.done) break;
          await new Promise(res=>{ this._more = res; });          // wait for the next streamed event
          continue;
        }
        const evt = this.queue.shift();
        if(evt.phase === 'start'){
          if(this.mode === 'step' && !this.skipping){
            this._status('press NEXT ▶ for: ' + (evt.label || evt.id));
            await new Promise(res=>{ this._step = res; this.renderControls(); });
            if(token !== this.token) return;
          }
          await this._packet(evt.id, token);
          if(token !== this.token) return;
          this._apply(evt, false);
          active[evt.id] = performance.now();
          this._status();
        }else if(evt.phase === 'end'){
          const shown = performance.now() - (active[evt.id] || 0);
          let want = this.dwell();
          if(evt.id === 'llm' && this.cur && this.cur.replay) want = Math.min(evt.dur || 0, 2500) / this.factor() + want;
          await this._sleep(Math.max(0, want - shown), token);
          if(token !== this.token) return;
          this._apply(evt, false);
        }else{
          this._apply(evt, false);
        }
      }
    }finally{
      if(token === this.token){
        this.playing = false; this.skipping = false;
        this._openGate();
        this._status();
        this.renderControls();
      }
    }
  },

  /* ── applying one event to the model + view ───────────────── */
  _apply(evt, instant){
    if(evt.phase === 'meta'){
      // Run-level facts from the server: which graph to draw, and whether agent mode fell back to the pipeline.
      if(evt.mode === 'agent' && this.kind !== 'agent'){ this.kind = 'agent'; this.dyn = []; if(this.svg) this.build(); }
      this._note = evt.note || null;
      this._status();
      return;
    }
    if(this.kind === 'agent' && /^(step|tool)_\d+$/.test(evt.id) && !this.dyn.some(d=>d.id === evt.id)){
      this.dyn.push({id: evt.id, label: this._dynLabel(evt)});
      if(this.svg) this.build();
    }
    if(evt.phase === 'end' && /^step_/.test(evt.id) && evt.data && evt.data.final){
      const d = this.dyn.find(x=>x.id === evt.id); if(d) d.label = 'ANSWER';
    }
    const n = this.nodes[evt.id] || (this.nodes[evt.id] = {status:'idle'});
    if(evt.phase === 'start'){
      n.status = 'active'; n.detail = evt.detail || '';
      this._started[evt.id] = true;
      if(evt.id === 'llm') this._openGate();                // pipeline: the answer may start appearing now
      if(evt.id === this._finalStep) this._openGate();      // agent: the FINAL step has been reached
      this._markNode(evt.id, instant);
    }else if(evt.phase === 'end'){
      n.status = evt.status || 'ok'; n.dur = evt.dur; n.detail = evt.detail || n.detail; n.data = evt.data || {};
      if(this.kind === 'agent' && /^step_/.test(evt.id) && n.data.final && this._started[evt.id]) this._openGate();
      this._markNode(evt.id, instant);
      this._log(evt);
      // Follow the latest stage until the visitor clicks a node; then keep showing the one they picked.
      if(!this._userPicked){ this.selected = evt.id; this._markNode(evt.id, instant); this.renderDetail(evt.id); this._refreshSel(); }
      else if(this.selected === evt.id) this.renderDetail(evt.id);
    }else if(evt.phase === 'progress'){
      n.detail = evt.detail; n.ttft = evt.t;
      this._markNode(evt.id, instant);
    }
    if(evt.t != null) this._totalMs = Math.max(this._totalMs || 0, evt.t);
  },
  _refreshSel(){
    if(this.svg) this.svg.querySelectorAll('.fl-node').forEach(g=>g.classList.toggle('sel', g.dataset.id === this.selected));
  },
  _status(msg){
    const el = document.getElementById('flow-status'); if(!el) return;
    if(msg){ el.textContent = msg; return; }
    const done = this.cur && this.cur.done && !this.queue.length && !this.playing;
    if(!this.cur) el.textContent = 'Ask VC·AI a question (chat window or `ask` in the terminal) to see the flow.';
    else if(done) el.textContent = 'run complete' + (this._totalMs ? ' · ' + (this._totalMs/1000).toFixed(2) + ' s real time' : '') + (this._note ? ' · note: ' + this._note : '');
    else el.textContent = 'running…';
  },

  /* ── graph spec: fixed in pipeline mode, growing in agent mode ───── */
  nodeList(){
    if(this.kind !== 'agent') return FLOW_NODES;
    const base = [{id:'rate_limit', label:'RATE LIMIT'}, {id:'guardrails', label:'GUARDRAILS'}, ...this.dyn];
    return base.map((n, i)=>({...n, preds: i ? [base[i-1].id] : []}));
  },
  labelFor(id){ const n = this.nodeList().find(x=>x.id === id); return n ? n.label : id; },
  layoutFor(nodes){ return this.kind === 'agent' ? agentLayout(nodes, this.layout) : FLOW_LAYOUTS[this.layout]; },
  _dynLabel(evt){
    const m = /^step_(\d+)$/.exec(evt.id);
    if(m) return 'THINK ' + m[1];
    const t = /^Tool: (.+)$/.exec(evt.label || '');
    return t ? (TOOL_LABELS[t[1]] || t[1].replace(/_/g, ' ').toUpperCase().slice(0, 13)) : evt.id.toUpperCase();
  },

  /* ── view: graph ──────────────────────────────────────────── */
  build(){
    const host = document.getElementById('flow-graph'); if(!host) return;
    const w = document.getElementById('win-flow').clientWidth || 640;
    this.layout = w < 520 ? 'tall' : 'wide';
    const nodes = this.nodeList(), L = this.layoutFor(nodes);
    host.textContent = '';
    host.dataset.layout = this.layout;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', this.kind === 'agent' ? 'Agent loop: guardrails, then think and tool steps' : 'Pipeline: rate limit, guardrails, embed, vector and keyword search, fuse, prompt, LLM');
    const defs = document.createElementNS(SVGNS, 'defs');
    defs.innerHTML = '<marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fl-ah"/></marker>';
    svg.appendChild(defs);                                   // static literal, no user data
    nodes.forEach(nd=>nd.preds.forEach(p=>{
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', L.paths[p+'>'+nd.id]);
      path.setAttribute('class', 'fl-edge'); path.setAttribute('marker-end', 'url(#fl-arrow)');
      path.dataset.edge = p+'>'+nd.id;
      svg.appendChild(path);
    }));
    nodes.forEach(nd=>{
      const [x, y] = L.pos[nd.id];
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'fl-node idle'); g.dataset.id = nd.id;
      g.setAttribute('transform', `translate(${x},${y})`);
      g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button'); g.setAttribute('aria-label', nd.label);
      const r = document.createElementNS(SVGNS, 'rect'); r.setAttribute('width', 124); r.setAttribute('height', 44); r.setAttribute('class', 'fl-box');
      const t = document.createElementNS(SVGNS, 'text'); t.setAttribute('x', 62); t.setAttribute('y', 19); t.setAttribute('class', 'fl-label'); t.textContent = nd.label;
      const s = document.createElementNS(SVGNS, 'text'); s.setAttribute('x', 62); s.setAttribute('y', 35); s.setAttribute('class', 'fl-sub'); s.textContent = '';
      const m = document.createElementNS(SVGNS, 'text'); m.setAttribute('x', 112); m.setAttribute('y', 12); m.setAttribute('class', 'fl-mark'); m.textContent = '';
      g.append(r, t, s, m);
      const pick = ()=>{ this._userPicked = true; this.selected = nd.id; this.renderDetail(nd.id); this._refreshSel(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', e=>{ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); pick(); } });
      svg.appendChild(g);
    });
    const pk = document.createElementNS(SVGNS, 'circle');
    pk.setAttribute('r', 5); pk.setAttribute('class', 'fl-packet'); pk.setAttribute('cx', -20); pk.setAttribute('cy', -20);
    svg.appendChild(pk);
    host.appendChild(svg);
    this.svg = svg; this.built = true;
    Object.keys(this.nodes).forEach(id=>this._markNode(id, true));   // restore state after a relayout
  },
  _resetVisuals(){
    this.nodes = {}; this._totalMs = 0; this._logLines = []; this.selected = null; this._userPicked = false;
    this._finalStep = null; this._started = {}; this.dyn = [];
    const wasAgent = this.kind === 'agent'; this.kind = 'pipeline';
    if(this.svg && wasAgent) this.build();
    if(this.svg) this.svg.querySelectorAll('.fl-node').forEach(g=>this._markNode(g.dataset.id, true));
    const log = document.getElementById('flow-log'); if(log) log.textContent = '';
    const d = document.getElementById('flow-detail'); if(d) d.textContent = '';
    this._status();
  },
  _markNode(id, instant){
    if(!this.svg) return;
    const g = this.svg.querySelector(`.fl-node[data-id="${id}"]`); if(!g) return;
    const n = this.nodes[id] || {status:'idle'};
    g.setAttribute('class', 'fl-node ' + n.status + (this.selected === id ? ' sel' : ''));
    const sub = g.querySelector('.fl-sub'), mark = g.querySelector('.fl-mark');
    const lab = g.querySelector('.fl-label'), want = this.labelFor(id);
    if(lab.textContent !== want) lab.textContent = want;
    const marks = {ok:'✓', blocked:'✕', error:'!', empty:'∅', skipped:'–', active:'●'};
    mark.textContent = marks[n.status] || '';
    sub.textContent = n.status === 'active' ? ((id === 'llm' || /^step_/.test(id)) && n.ttft ? 'streaming…' : 'working…')
                    : n.dur != null ? (n.dur < 1000 ? Math.round(n.dur) + ' ms' : (n.dur/1000).toFixed(1) + ' s')
                    : '';
    // Edges that lead INTO a finished/active node light up.
    this.nodeList().forEach(nd=>nd.preds.forEach(p=>{
      const e = this.svg.querySelector(`.fl-edge[data-edge="${p}>${nd.id}"]`);
      const pn = this.nodes[p], cn = this.nodes[nd.id];
      if(e) e.classList.toggle('lit', !!(pn && cn && pn.status !== 'idle' && cn.status !== 'idle'));
    }));
  },
  _packet(toId, token){
    // A dot travels along each edge into the stage that is about to run.
    if(!this.svg || this.skipping || document.hidden) return Promise.resolve();
    const nd = this.nodeList().find(n=>n.id === toId);
    const edges = (nd ? nd.preds : []).filter(p=>this.nodes[p] && this.nodes[p].status !== 'idle')
      .map(p=>this.svg.querySelector(`.fl-edge[data-edge="${p}>${toId}"]`)).filter(Boolean);
    if(!edges.length) return Promise.resolve();
    const dot = this.svg.querySelector('.fl-packet'), ms = this.travel();
    return new Promise(res=>{
      const len = edges[0].getTotalLength();
      const t0 = performance.now();
      let finished = false;
      const finish = ()=>{ if(finished) return; finished = true; dot.setAttribute('cx', -20); res(); };
      // Safety net: if animation frames never arrive (background tab, headless), the run still advances.
      setTimeout(finish, ms + 250);
      const step = now=>{
        if(finished) return;
        if(token !== this.token || this.skipping) return finish();
        const f = Math.min(1, (now - t0) / ms);
        const pt = edges[0].getPointAtLength(len * f);               // the lead edge carries the dot
        dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
        if(f < 1) requestAnimationFrame(step); else finish();
      };
      requestAnimationFrame(step);
    });
  },

  /* ── view: detail panel + log ─────────────────────────────── */
  _log(evt){
    const log = document.getElementById('flow-log'); if(!log) return;
    const name = this.labelFor(evt.id);
    const line = document.createElement('div');
    line.textContent = `${String(Math.round(evt.t)).padStart(5)} ms  ${name.padEnd(11)} ${evt.status}  ${evt.detail || ''}`;
    log.appendChild(line); log.scrollTop = log.scrollHeight;
  },
  renderDetail(id){
    const box = document.getElementById('flow-detail'); if(!box) return;
    const n = this.nodes[id]; box.textContent = '';
    const label = this.labelFor(id);
    const add = (cls, text, parent)=>{ const e = document.createElement('div'); e.className = cls; e.textContent = text; (parent||box).appendChild(e); return e; };
    if(!n || n.status === 'idle'){ add('fd-title', label + ' — not reached in this run'); return; }
    add('fd-title', `${label} — ${n.status.toUpperCase()}${n.dur != null ? ' — ' + Math.round(n.dur) + ' ms' : ''}`);
    if(n.detail) add('fd-line', n.detail);
    const d = n.data || {};
    if(d.hint) add('fd-line fd-hint', 'How to fix: ' + d.hint);

    const chunkRow = (c, extra, cls, threshold)=>{
      const row = add('fd-row ' + (cls||''), '');
      add('fd-rl', (extra ? extra + ' ' : '') + c.label, row);
      if(c.score != null){
        const bar = add('fd-bar', '', row); const fill = document.createElement('i'); fill.style.width = Math.max(2, Math.round(c.score*100)) + '%'; bar.appendChild(fill);
        if(threshold != null){ const tick = document.createElement('b'); tick.style.left = Math.round(threshold*100) + '%'; bar.appendChild(tick); }
        add('fd-sc', c.score.toFixed(3), row);
      }
      if(c.text){
        const body = add('fd-text', c.text, row); body.hidden = true;
        row.addEventListener('click', ()=>{ body.hidden = !body.hidden; });
        row.title = 'click to show the chunk text';
      }
    };
    // Retrieval renderers take their data explicitly, so the pipeline's own stages AND the retrieval nested inside an
    // agent's search tool call share one implementation.
    const showDense = x=>{
      add('fd-line', `cut-off ${x.threshold} (the | tick): below it a chunk is ignored`);
      x.candidates.forEach(c=>chunkRow(c, c.passed ? '✓' : '✗', c.passed ? 'pass' : 'fail', x.threshold));
    };
    const showKeyword = x=>{
      add('fd-line', x.rare_terms && x.rare_terms.length ? 'rare terms: ' + x.rare_terms.join(', ') : 'no rare corpus terms in the question');
      (x.hits || []).forEach(c=>chunkRow(c, '→'));
    };
    const showFuse = x=>{
      x.results.forEach(c=>chunkRow(c, '[' + c.n + ']', 'pass'));
      x.results.forEach(c=>{ add('fd-line', `[${c.n}] found by: ${c.via === 'both' ? 'vector + keyword' : c.via === 'lexical' ? 'keyword' : 'vector'}`); });
      if(!x.results.length) add('fd-line', 'No source cleared the gates, so the model is told there is none and should say so.');
    };

    if(id === 'dense' && d.candidates) showDense(d);
    else if(id === 'keyword') showKeyword(d);
    else if(id === 'fuse' && d.results) showFuse(d);
    else if(id === 'embed'){ add('fd-line', `${d.provider} · ${d.model} · ${d.dim} dims`); }
    else if(id === 'prompt'){ add('fd-line', `${d.sources} source(s), about ${d.approx_tokens} tokens of prompt. (The prompt text itself is never exposed.)`); }
    else if(id === 'llm'){ add('fd-line', `${d.model || ''} · first token after ${d.ttft_ms != null ? Math.round(d.ttft_ms) + ' ms (run time)' : '—'} · ${d.chunks || 0} chunks · ${d.chars || 0} characters`); }
    else if(id === 'guardrails' && n.status === 'blocked'){ add('fd-line', 'The question was stopped here. (Which rule matched is never revealed.)'); }
    else if(/^step_\d+$/.test(id)){
      add('fd-line', d.final ? 'The model answered directly: no tool call this step.' : 'The model decided to call:');
      (d.calls || []).forEach(c=>add('fd-line', '→ ' + c.name + ' ' + JSON.stringify(c.args)));
      if(d.text_chars) add('fd-line', d.text_chars + ' characters of text streamed in this step');
    }else if(/^tool_\d+$/.test(id)){
      add('fd-line', (d.name || '') + ' ' + JSON.stringify(d.args || {}));
      if(d.skill) add('fd-line', `loaded skill "${d.skill}": ${d.chars} characters of instructions entered the context now, not up front`);
      if(d.sources && d.sources.length) add('fd-line', 'sources: ' + d.sources.map(x=>'[' + x.n + '] ' + x.label).join(' · '));
      const r = d.retrieval;
      if(r){
        if(r.dense && r.dense.candidates){ add('fd-sub', 'Vector search inside this tool call'); showDense(r.dense); }
        if(r.keyword){ add('fd-sub', 'Keyword search inside this tool call'); showKeyword(r.keyword); }
        if(r.fuse && r.fuse.results){ add('fd-sub', 'Fused result'); showFuse(r.fuse); }
      }
      if(d.result){ add('fd-sub', 'What the model received (preview)'); add('fd-text', d.result); }
    }
  },

  /* ── controls ─────────────────────────────────────────────── */
  renderControls(){
    document.querySelectorAll('#flow-speed button').forEach(b=>b.classList.toggle('on', b.dataset.mode === this.mode));
    const next = document.getElementById('flow-next'); if(next) next.disabled = !this._step;
    const skip = document.getElementById('flow-skip'); if(skip) skip.disabled = !(this.playing || this._step);
    const rep = document.getElementById('flow-replay'); if(rep) rep.disabled = !this.last;
    const syn = document.getElementById('flow-sync'); if(syn) syn.checked = this.sync;
    const ag = document.getElementById('flow-agent'); if(ag && typeof AI !== 'undefined') ag.checked = AI.mode === 'agent';
    const hint = document.getElementById('flow-mode-hint');
    if(hint) hint.textContent = this.mode === 'live' ? 'LIVE: shown as it really happens (fast)'
      : this.mode === 'step' ? 'STEP: press NEXT for each stage'
      : `${this.mode}×: each stage stays on screen ~${(this.BASE_DWELL/this.factor()/1000).toFixed(1)} s (playback only; the real pipeline is not slowed)`;
  },
  wire(){
    document.querySelectorAll('#flow-speed button').forEach(b=>b.addEventListener('click', ()=>this.setMode(b.dataset.mode)));
    document.getElementById('flow-next').addEventListener('click', ()=>this.next());
    document.getElementById('flow-skip').addEventListener('click', ()=>this.skip());
    document.getElementById('flow-replay').addEventListener('click', ()=>this.replay());
    document.getElementById('flow-sync').addEventListener('change', e=>this.setSync(e.target.checked));
    const ag = document.getElementById('flow-agent');
    if(ag) ag.addEventListener('change', e=>{ if(typeof AI !== 'undefined') AI.setMode(e.target.checked ? 'agent' : 'pipeline'); });
    if(window.ResizeObserver){
      new ResizeObserver(()=>{
        const w = document.getElementById('win-flow').clientWidth;
        if(this.built && w && ((w < 520) !== (this.layout === 'tall'))) this.build();
      }).observe(document.getElementById('win-flow'));
    }
  },
  /* Called by openWin() for EVERY way the window can be opened: dock, desktop icon, menu, the FLOW button,
     the `flow` terminal command. (Opening it from the dock used to skip setup and show an empty window.) */
  afterOpen(){
    if(!this.wired){ this.wired = true; this.wire(); }
    this.build();
    // Show the most recent run in its final state (instantly), so opening the monitor is never an empty box.
    if(this.last && this.queue.length === 0 && !this.playing){
      this.nodes = {}; this._logLines = []; this._finalStep = null; this._started = {}; this.dyn = [];
      if(this.kind === 'agent'){ this.kind = 'pipeline'; this.build(); }
      const log = document.getElementById('flow-log'); if(log) log.textContent = '';
      this.last.events.forEach(e=>this._apply(e, true));
    }
    this.renderControls(); this._status();
  },
  open(){ openWin('win-flow'); },          // openWin() calls afterOpen()
};
Flow.init();
function flowOpen(){ Flow.open(); }
