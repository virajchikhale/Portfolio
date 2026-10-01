/* ════════════════════════════════════════════════════════════════
   ██████╗ ██████╗ ███╗   ██╗███████╗██╗ ██████╗
  ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝
  ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
  ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
  ╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝
  Edit this one object to update your entire portfolio.
════════════════════════════════════════════════════════════════ */
const CONFIG = {

  /* ── OS branding ─────────────────────────────────────────── */
  meta: {
    osName: 'VC\u00B7OS',
    version: '1.0',
    year: '2025',
  },

  /* ── Personal info ───────────────────────────────────────── */
  user: {
    name: 'Viraj Chikhale',
    role: 'AI/ML Engineer',
    tagline: 'Building Agentic AI',
    location: 'Pune, India \uD83C\uDDEE\uD83C\uDDF3',
    bio: 'Software Engineer with 2+ years of experience specializing in AI-driven applications, multi-agent orchestration, and full-stack development. Building the next layer of AI \u2014 where models think, plan & act.',
    email: 'chikhaleviraj.work@gmail.com',
    promptUser: 'viraj',
  },

  /* ── Optional integrations (all work on static hosting) ──────
     resumeUrl       : e.g. 'assets/Viraj_Chikhale_Resume.pdf' (put the PDF in the repo)
     contactEndpoint : e.g. a Formspree / Web3Forms URL. Empty = fall back to mailto:
     proxyUrl        : CORS proxy used by the IE window, e.g. your own Cloudflare Worker URL + '?url='
  ─────────────────────────────────────────────────────────── */
  resumeUrl: '',
  /* Backend for VC\u00B7AI chat. '' = same origin (Docker/nginx proxies /api).
     On a static host (GitHub Pages) set the full URL of your deployed API, e.g. 'https://api.example.com'.
     If unreachable, the chat degrades to an "offline" message. */
  apiBase: '',
  chatSuggestions: [
    'What projects has Viraj built?',
    'What is his tech stack?',
    'Tell me about the agentic AI project',
    'How can I contact him?',
  ],
  contactEndpoint: '',
  proxyUrl: '',

  /* ── Experience (window is empty until you fill this in) ──────
     { role:'AI Engineer', company:'Company', period:'2023 \u2013 Present', location:'Pune',
       points:['Built X that did Y (metric)', '...'] }
  ─────────────────────────────────────────────────────────── */
  experience: [],

  /* ── Stats shown in About window ─────────────────────────── */
  stats: [
    { value: '2+', label: 'YRS EXP' },
    { value: '5+', label: 'PROD APPS' },
    { value: '9.14', label: 'CGPA' },
  ],

  /* ── Social / link badges ────────────────────────────────── */
  links: [
    { label: '\uD83D\uDD17 GitHub', url: 'https://github.com/virajchikhale', action: 'ie' },
    { label: '\uD83D\uDCBC LinkedIn', url: 'https://linkedin.com/in/viraj-chikhale-024a92201/', action: 'ie' },
    { label: '\u2709\uFE0F Email', url: null, action: 'contact' },
    { label: '>_ Terminal', url: null, action: 'terminal' },
  ],

  /* ── Skills ──────────────────────────────────────────────── */
  skills: [
    {
      category: '\uD83E\uDD16 AI / ML',
      items: ['LangChain', 'LangGraph', 'CrewAI', 'RAG', 'NLP', 'Prompt Eng.', 'Scikit-learn'],
    },
    {
      category: '\uD83D\uDD0C AGENTS & TOOLS',
      items: ['Multi-Agent Systems', 'Tool Calling', 'Agent Workflows', 'Memory Handling', 'Task Routing'],
    },
    {
      category: '\uD83D\uDCBB LANGUAGES',
      items: ['Python', 'JavaScript', 'C++', 'PHP', 'SQL'],
    },
    {
      category: '\uD83C\uDF10 WEB & BACKEND',
      items: ['FastAPI', 'React', 'Next.js', 'HTML5', 'CSS3', 'Bootstrap', 'AJAX', 'jQuery'],
    },
    {
      category: '\uD83D\uDDC4 DATABASES',
      items: ['PostgreSQL', 'MySQL', 'Oracle'],
    },
    {
      category: '\uD83D\uDEE0 TOOLS & PLATFORMS',
      items: ['Git', 'GitHub', 'Tableau', 'Power BI', 'Streamlit', 'VS Code'],
    },
  ],

  /* ── Projects ──────────────────────────────────────────────
     Per-project optional fields (shown automatically when set):
       repo    : direct link to the repository (NOT your profile page)
       demo    : live demo / video URL
       writeup : case study / blog post URL
       metrics : ['Recall@5: 0.82 on <dataset> (baseline 0.64)', ...]
     The old `links` array still works.
  ─────────────────────────────────────────────────────────── */
  projects: [
    {
      icon: '\uD83E\uDD16',
      name: 'VC\u00B7OS Portfolio',
      desc: 'Mac OS 1984-inspired interactive portfolio with draggable windows, terminal, dock, menu bar & IE browser \u2014 hand-coded from scratch.',
      tags: ['HTML', 'CSS', 'JavaScript', 'Canvas'],
      links: [
        { label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
      ],
    },
    {
      icon: '\uD83D\uDD17',
      name: 'Agentic AI Workflow Engine',
      desc: 'Multi-agent orchestration system with task routing, tool calling, and memory handling using LangGraph/CrewAI patterns and intelligent fallback mechanisms.',
      tags: ['Python', 'LangChain', 'LangGraph', 'CrewAI'],
      links: [
        { label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
      ],
    },
    {
      icon: '\uD83D\uDCCD',
      name: 'Context-Aware Place Recommendations',
      desc: 'Intelligent recommendation engine using NLP and geospatial data to suggest places based on user mood, preferences, and location — achieving 85% query-match accuracy.',
      tags: ['Python', 'NLP', 'Geospatial Analysis', 'Scikit-learn'],
      links: [
        { label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
      ],
    },
    {
      icon: '\uD83C\uDFAC',
      name: 'Movie Recommendation System',
      desc: 'Hybrid recommendation system combining collaborative and content-based filtering with word embeddings. Deployed as an interactive Streamlit app with 90%+ user satisfaction.',
      tags: ['Python', 'Pandas', 'NumPy', 'Scikit-learn', 'Streamlit'],
      links: [
        { label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
      ],
    },
    {
      icon: '\uD83D\uDCCA',
      name: 'Attendance Management System',
      desc: 'Enterprise-level attendance tracking system managing 2000+ students and 60+ teachers across 7 branches, with automated Excel/PDF report generation.',
      tags: ['HTML', 'CSS', 'JavaScript', 'PHP', 'MySQL', 'AJAX'],
      links: [
        { label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
      ],
    },
    {
      icon: '\uD83D\uDCDA',
      name: 'Library Management System',
      desc: 'Custom library system for a 2000+ student college with department-wise book distribution, automated fine calculations, and borrowing pattern reports.',
      tags: ['HTML', 'CSS', 'JavaScript', 'PHP', 'MySQL', 'AJAX'],
      links: [
        { label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
      ],
    },
  ],

  /* ── IE browser favorites ─────────────────────────────────── */
  favorites: [
    { cat: 'SOCIAL', label: '\uD83D\uDC08 GitHub', url: 'https://github.com/virajchikhale' },
    { cat: 'SOCIAL', label: '\uD83D\uDCBC LinkedIn', url: 'https://linkedin.com/in/viraj-chikhale-024a92201/' },
    { cat: 'WEB', label: '\uD83D\uDD0D Google', url: 'https://google.com' },
    { cat: 'WEB', label: '\uD83D\uDCDA Wikipedia', url: 'https://wikipedia.org' },
  ],

  /* ── Desktop marquee text ──────────────────────────────────── */
  marquee: '★ VIRAJ CHIKHALE \u00a0\u00a0 AI/ML ENGINEER \u00a0\u00a0 \u25cf \u00a0\u00a0 PYTHON \u00b7 JAVASCRIPT \u00b7 LANGCHAIN \u00b7 LANGGRAPH \u00b7 CREWAI \u00b7 FASTAPI \u00b7 REACT \u00b7 NEXT.JS \u00b7 POSTGRESQL \u00b7 AGENTIC AI \u00a0\u00a0 \u25cf \u00a0\u00a0 BUILDING THE FUTURE ONE TOKEN AT A TIME \u00a0\u00a0 ★ \u00a0\u00a0 GITHUB: VIRAJCHIKHALE \u00a0\u00a0 \u25cf \u00a0\u00a0 VC\u00B7OS v1.0 \u00a0\u00a0 ★ \u00a0\u00a0',

  /* ── Boot messages ────────────────────────────────────────── */
  bootMessages: [
    'INITIALIZING VC\u00B7OS...',
    'LOADING NEURAL CORE... OK',
    'MOUNTING LLM FILESYSTEM... OK',
    'STARTING LANGCHAIN DAEMON... OK',
    'CONNECTING LANGGRAPH RUNTIME... OK',
    'LOADING FASTAPI ENGINE... OK',
    'BOOTING AGENTIC RUNTIME...',
    'CALIBRATING AI MODELS...',
    'LAUNCHING DESKTOP...',
  ],
};

/*Deployment*/
