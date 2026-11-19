import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = join(import.meta.dirname, "..", "frontend");
const vercel = JSON.parse(readFileSync(join(import.meta.dirname, "..", "vercel.json"), "utf8"));
const pages = readdirSync(FRONTEND).filter((f) => /\.(html|js|css)$/.test(f));
const read = (f: string) => readFileSync(join(FRONTEND, f), "utf8");

describe("Read Me page", () => {
  it("exists, and the old name is gone from everything a visitor can see", () => {
    expect(existsSync(join(FRONTEND, "readme.html"))).toBe(true);
    expect(existsSync(join(FRONTEND, "recruiter.html"))).toBe(false);
    for (const f of pages) expect(read(f), f).not.toMatch(/recruiter/i);
  });

  it("every entry point links to it (menu bar, menu, chat window, first-visit chooser, tour)", () => {
    const index = read("index.html");
    expect(index).toMatch(/class="mb-readme" href="readme\.html"[^>]*>READ ME/);
    expect(index).toMatch(/location\.href='readme\.html'">Read Me</);
    expect(index).toMatch(/class="chat-readme" href="readme\.html">Short on time\?/);
    expect(index).toMatch(/<b>READ ME<\/b>/);
    const tour = read("tour.js");
    expect(tour).toContain("location.href = 'readme.html'");
    expect(tour).toContain("target: '.mb-readme'");
    for (const cls of ["mb-readme", "chat-readme"]) expect(read("style.css")).toContain(`.${cls}`);
  });

  it("is audience-neutral: no 'not technical' framing, no job-seeking line, and a way back to the desktop", () => {
    const html = read("readme.html");
    const all = pages.map(read).join("\n");
    expect(all).not.toMatch(/not technical/i);
    expect(html).not.toMatch(/Hiring for AI/);
    expect(html).toMatch(/Let&rsquo;s talk/);
    expect(html).toContain('href="index.html?mode=os">Open the desktop');
  });

  it("every local .html link in the frontend points at a file that exists", () => {
    const links = new Set<string>();
    for (const f of pages) for (const m of read(f).matchAll(/(?:href=["']|location\.href\s*=\s*['"])([\w./-]+\.html)(?:\?[^"']*)?["']/g)) links.add(m[1]!);
    expect([...links].length).toBeGreaterThan(1);
    for (const l of links) expect(existsSync(join(FRONTEND, l)), `broken link: ${l}`).toBe(true);
  });
});

describe("old links keep working", () => {
  it("Vercel permanently redirects /recruiter.html and /recruiter to /readme.html, and serves /readme", () => {
    expect(vercel.redirects).toEqual(expect.arrayContaining([
      { source: "/recruiter.html", destination: "/readme.html", permanent: true },
      { source: "/recruiter", destination: "/readme.html", permanent: true },
    ]));
    expect(vercel.rewrites).toEqual(expect.arrayContaining([{ source: "/readme", destination: "/readme.html" }]));
    expect(vercel.rewrites).toEqual(expect.arrayContaining([{ source: "/mcp", destination: "/api/mcp" }])); // not clobbered
  });

  it("the Docker/nginx path redirects too, and the image ships the renamed page", () => {
    expect(readFileSync(join(FRONTEND, "nginx.conf"), "utf8")).toMatch(/location = \/recruiter\.html \{ return 301 \/readme\.html; \}/);
    expect(readFileSync(join(FRONTEND, "Dockerfile"), "utf8")).toContain("readme.html");
  });
});
