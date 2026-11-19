/**
 * The page actions the assistant may OFFER a visitor. The ids are a fixed allowlist, shared with frontend/actions.js (a
 * test keeps the two in sync). The assistant can only PROPOSE: the server sends ids, the page renders a button with its
 * own label, and nothing happens unless the visitor clicks it (or answers "yes" to that specific offer). No action takes
 * a free-form argument, none sends anything, and none opens an external link.
 */
export const ACTIONS: Record<string, string> = {
  "theme-dark": "switch the site to dark mode",
  "theme-light": "switch the site to light mode",
  "open-about": "open the About window",
  "open-skills": "open the Skills window",
  "open-experience": "open the Experience window",
  "open-projects": "open the Projects window",
  "open-terminal": "open the Terminal window",
  "open-contact": "open the Contact window",
  "open-flow": "open the Flow Monitor, which shows how an answer is produced",
  "open-activity": "open the Activity window (usage statistics)",
  "tour": "start the short guided tour of the desktop",
  "new-chat": "clear this conversation and start a new chat",
  "readme": "open the one-page Read Me version of the site (this leaves the desktop)",
};

export const ACTION_IDS = Object.keys(ACTIONS);
export const MAX_ACTIONS = 3; // buttons offered per answer
