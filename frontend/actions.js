/* ════════════════════════════════════════════════════════════════
   ACTIONS: things VC·AI can DO on this page.

   The model (or a retrieved document) can only PROPOSE an action; it never runs one. Rules:
     * Every action is an id from the fixed registry below. There are no arguments, no external links and nothing that
       sends data: the worst a wrong id can do is nothing (unknown ids are rejected here, even though the server checks too).
     * A command the visitor TYPES on its own ("dark mode", "open projects") runs at once, in the browser, with no server
       call and no model call, so it is instant and free.
     * Anything suggested by the model, or offered from what the visitor asked, appears as a BUTTON. The click is the
       consent. Typing "yes" counts as that click only for the offer that is currently on screen, and only for the next
       message.
     * Labels and wording come from this file, never from the server or the model, so they cannot inject text.
   The ids must match lib/actions.ts (a test keeps the two in sync).
════════════════════════════════════════════════════════════════ */
const Actions = {
  pending: null,   // id the visitor can answer "yes" to: valid for the NEXT message only

  /* The only navigation anywhere in here, wrapped so tests can observe it instead of leaving the page. */
  go(url){ location.href = url; },

  registry: {
    'theme-dark':      {label: 'DARK MODE',      done: 'Switched to dark mode.',  run(){ setTheme('dark'); }},
    'theme-light':     {label: 'LIGHT MODE',     done: 'Switched to light mode.', run(){ setTheme('light'); }},
    'open-about':      {label: 'OPEN ABOUT',      win: 'win-about',      offer: 'Want to open the About window?',      done: 'Opening About.',      run(){ openWin('win-about'); }},
    'open-skills':     {label: 'OPEN SKILLS',     win: 'win-skills',     offer: 'Want to see the Skills window?',      done: 'Opening Skills.',     run(){ openWin('win-skills'); }},
    'open-experience': {label: 'OPEN EXPERIENCE', win: 'win-experience', offer: 'Want to open the Experience window?', done: 'Opening Experience.', run(){ openWin('win-experience'); }},
    'open-projects':   {label: 'OPEN PROJECTS',   win: 'win-projects',   offer: 'Want to see the Projects window?',    done: 'Opening Projects.',   run(){ openWin('win-projects'); }},
    'open-terminal':   {label: 'OPEN TERMINAL',   win: 'win-terminal',   offer: 'Want to open the Terminal?',          done: 'Opening the Terminal.', run(){ openWin('win-terminal'); }},
    'open-contact':    {label: 'OPEN CONTACT',    win: 'win-contact',    offer: 'Want to open the Contact window?',    done: 'Opening Contact.',    run(){ openWin('win-contact'); }},
    'open-flow':       {label: 'OPEN FLOW',       win: 'win-flow',       offer: 'Want to watch how an answer is made?', done: 'Opening the Flow Monitor.', run(){ flowOpen(); }},
    'open-activity':   {label: 'OPEN ACTIVITY',   win: 'win-activity',   offer: 'Want to see the usage statistics?',   done: 'Opening Activity.',   run(){ activityOpen(); }},
    'tour':            {label: 'TAKE THE TOUR',   offer: 'Want a one-minute tour of the desktop?', done: 'Starting the tour.', run(){ Tour.start(); }},
    'new-chat':        {label: 'NEW CHAT',        done: 'Starting a new chat.',    run(){ chatReset(); }},
    /* Leaves the desktop, so it is never run by a typed command alone: it always shows a button first. */
    'readme':          {label: 'OPEN READ ME',    offer: 'Want the one-page version?', done: 'Opening the Read Me.', confirm: true, run(){ Actions.go('readme.html'); }},
  },

  has(id){ return typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.registry, id); },

  /* Run one action. Unknown ids do nothing (this is the allowlist check, whoever asked). */
  run(id){
    if(!this.has(id)) return false;
    try{ this.registry[id].run(); return true; }catch(e){ return false; }
  },

  /* ── typed commands ─────────────────────────────────────────────
     Only a short message that is NOTHING BUT a command matches. "what is his dark mode experience?" and
     "tell me about the projects" are questions and go to the model. */
  norm(text){
    let t = String(text).toLowerCase().normalize('NFKC').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(?:(?:hey|hi|ok|okay|so)\s+)?(?:(?:please|pls|can you|could you|would you|will you)\s+)+/, '')
         .replace(/\s+(?:please|pls|thanks|thank you|thx)$/, '');
    return t.trim();
  },

  match(text){
    const t = this.norm(text);
    if(!t || t.split(' ').length > 8) return null;
    for(const [re, id] of this.commands) if(re.test(t)) return id;
    return null;
  },

  /* "yes" and friends: only meaningful while an offer is pending (the caller checks that). */
  isYes(text){
    return /^(?:yes|yeah|yep|yup|y|sure|sure thing|ok|okay|of course|absolutely|do it|go ahead|open it|show me|why not)$/.test(this.norm(text));
  },

  /* ── offers: buttons driven by what the VISITOR asked (never by model output) ── */
  rules: [
    ['readme',          /\b(summary|summari[sz]e|overview|tl;?dr|short on time|quick(?:ly)?|one[- ]page|in a nutshell|brief(?:ly)?|resume|cv|hiring|recruit(?:er|ing)?)\b/i],
    ['open-contact',    /\b(contact|reach|e-?mail|get in touch|connect with|hire|book a call)\b/i],
    ['open-projects',   /\bprojects?\b/i],
    ['open-skills',     /\b(skills?|tech(?:nology)? stack|technologies)\b/i],
    ['open-experience', /\b(experience|work history|career|internship|employer|jobs?)\b/i],
    ['open-about',      /\b(who is|about viraj|background|bio)\b/i],
  ],

  /* True when the action opens a window that is already on screen (no point offering it again). */
  alreadyOpen(id){
    const w = this.registry[id] && this.registry[id].win;
    const el = w && document.getElementById(w);
    return !!(el && el.style.display !== 'none' && el.style.display !== '');
  },

  /* Up to two offers for a question, best first. */
  offersFor(question){
    const out = [];
    for(const [id, re] of this.rules){
      if(re.test(String(question)) && !this.alreadyOpen(id)) out.push(id);
      if(out.length === 2) break;
    }
    return out;
  },

  /* Merge model-proposed ids (already allowlisted server-side, checked again here) with the visitor-driven offers.
     Server ids first, no duplicates, nothing unknown, at most three. */
  merge(serverActions, offers){
    const out = [];
    const ids = [...(Array.isArray(serverActions) ? serverActions.map(a => a && a.id) : []), ...offers];
    for(const id of ids){
      if(this.has(id) && !out.includes(id) && !this.alreadyOpen(id)) out.push(id);
      if(out.length === 3) break;
    }
    return out;
  },
};

/* Command grammar. Each entry is [pattern over the normalised text, action id]; the first match wins. */
(function(){
  const VERB   = '(?:switch|turn|go|change|set|put|flip|enable|use|activate)(?: it| this| the site| the page| the desktop| the theme| the screen| the ui)?(?: on| to| into| over to)?';
  const OFFVRB = '(?:turn|switch|flip|set)(?: it| this)? off|disable|stop using|exit';
  const DARK = '(?:dark|night)', LIGHT = '(?:light|day|bright)';
  const mode = c => `(?:the )?${c}(?: mode| theme)?`;
  const OPEN = '(?:open|launch|go to|take me to|bring up|pull up|show me the|show the)';
  const WIN = {
    'open-about': 'about me|about', 'open-skills': 'skills?', 'open-experience': 'work experience|work history|experience',
    'open-projects': 'projects?', 'open-terminal': 'terminal', 'open-contact': 'contact form|contact window|contact',
    'open-flow': 'flow monitor|flow', 'open-activity': 'activity monitor|activity',
  };
  const c = [];
  // "turn off dark mode" is light mode, and the other way round (checked before the plain forms)
  c.push([new RegExp(`^(?:${OFFVRB}) ${mode(DARK)}$|^${DARK} (?:mode|theme) off$`), 'theme-light']);
  c.push([new RegExp(`^(?:${OFFVRB}) ${mode(LIGHT)}$|^${LIGHT} (?:mode|theme) off$`), 'theme-dark']);
  c.push([new RegExp(`^(?:${VERB} ${mode(DARK)}|${DARK} (?:mode|theme))$`), 'theme-dark']);
  c.push([new RegExp(`^(?:${VERB} ${mode(LIGHT)}|${LIGHT} (?:mode|theme))$`), 'theme-light']);
  c.push([/^(?:(?:start|take|begin|replay|restart|give me|show me)(?: me)?(?: on)?(?: a| the)? )?(?:guided )?(?:tour|walkthrough)$/, 'tour']);
  c.push([/^(?:new chat|start over|start a new chat|start a new conversation|clear(?: the| this)? (?:chat|conversation)|reset(?: the| this)? chat|forget (?:this|everything|it))$/, 'new-chat']);
  c.push([/^(?:(?:open|show(?: me)?|go to|take me to|launch|read)(?: the| his)? )?(?:read ?me|one[- ]page(?: version| page| summary)?)(?: page| view| version)?$/, 'readme']);
  for(const id of Object.keys(WIN)){
    c.push([new RegExp(`^${OPEN}(?: the| his| viraj's| my)? (?:${WIN[id]})(?: window| page| app| tab)?$`), id]);
  }
  Actions.commands = c;
})();
