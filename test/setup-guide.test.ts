import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REMOTE_SECRETS } from "../src/remote/env.js";

/**
 * The setup guide exists three times: docs/setup-guide.md, docs/setup-guide.html (the same guide as a page) and the
 * shorter sections of the README. These tests keep the copies from drifting: a command changed in one place fails here
 * until the others follow.
 */
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const readme = read("../README.md");
const md = read("../docs/setup-guide.md");
const html = read("../docs/setup-guide.html");

/** The text of every fenced code block in a Markdown file (indented fences inside lists included). */
function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^[ \t]*```[a-z]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm)].map((m) => m[1]!.split("\n").map((l) => l.trim()).join("\n").trim());
}

/** What a reader sees in the body of the page (<main>, so the contents list does not count): no tags, entities decoded, each line trimmed. */
function pageText(page: string): string {
  const start = page.indexOf("<main");
  const end = page.indexOf("</main>");
  assert.ok(start >= 0 && end > start, "the HTML guide has no <main> element");
  const text = page.slice(start, end).replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return text.split("\n").map((l) => l.trim()).join("\n");
}

const headings = (markdown: string, level: string): string[] =>
  [...markdown.matchAll(new RegExp(`^${level} (.+)$`, "gm"))].map((m) => m[1]!.replace(/`/g, ""));

test("the HTML guide shows every command and every sample output of the Markdown guide", () => {
  const blocks = codeBlocks(md);
  assert.ok(blocks.length >= 20, `expected the guide's code blocks, found ${blocks.length}`);
  const text = pageText(html);
  for (const block of blocks) assert.ok(text.includes(block), `docs/setup-guide.html lacks this block from docs/setup-guide.md:\n${block}`);
});

test("the HTML guide has every section and step of the Markdown guide, in the same order", () => {
  const text = pageText(html);
  let from = 0;
  for (const heading of [...md.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.replace(/`/g, ""))) {
    const at = text.indexOf(heading, from);
    assert.ok(at >= 0, `docs/setup-guide.html lacks the heading "${heading}" (or has it out of order)`);
    from = at + heading.length;
  }
});

test("the steps are numbered 1 to n without gaps, and the HTML guide has an anchor and a checkbox for each", () => {
  const steps = headings(md, "###").filter((h) => h.startsWith("Step "));
  assert.ok(steps.length >= 10);
  steps.forEach((h, i) => assert.ok(h.startsWith(`Step ${i + 1}. `), `step ${i + 1} is titled "${h}"`));
  for (let n = 1; n <= steps.length; n++) {
    assert.ok(html.includes(`id="step-${n}"`), `no id="step-${n}" in the HTML guide`);
    assert.ok(html.includes(`data-step="${n}"`), `no checkbox for step ${n} in the HTML guide`);
  }
  assert.ok(!html.includes(`id="step-${steps.length + 1}"`), "the HTML guide has more steps than the Markdown guide");
});

test("the guide covers the shared server's secrets and the commands a first setup needs", () => {
  for (const secret of REMOTE_SECRETS) assert.ok(md.includes(secret), `the guide never mentions ${secret}`);
  for (const cmd of [
    "npm install", "npm run build", "npm link", "skylight-mcp login", "skylight-mcp doctor", "npx wrangler login",
    "npm run remote:deploy:staging", "skylight-mcp remote setup --env staging", "skylight-mcp remote login --env staging",
    "skylight-mcp remote status --env staging", "skylight-mcp remote revoke",
  ]) assert.ok(md.includes(cmd), `the guide lacks \`${cmd}\``);
});

test("the README and the guide give the same clone command", () => {
  const clone = /^git clone \S+ \S+$/m.exec(readme)?.[0];
  assert.ok(clone, "README has no git clone line");
  assert.ok(md.includes(clone), `the guide does not use the README's clone command: ${clone}`);
});

test("the README points to both guide files and says how to open the HTML one", () => {
  assert.ok(readme.includes("(docs/setup-guide.md)"), "README does not link docs/setup-guide.md");
  assert.ok(readme.includes("(docs/setup-guide.html)"), "README does not link docs/setup-guide.html");
  assert.ok(readme.includes("open docs/setup-guide.html"), "README does not say how to open the HTML guide from a clone");
  for (const section of ["## Install", "## Login", "## Claude Desktop setup", "## Use from Claude, ChatGPT and Gemini on any device"]) {
    const start = readme.indexOf(`\n${section}\n`);
    assert.ok(start >= 0, `README lacks ${section}`);
    const body = readme.slice(start, readme.indexOf("\n## ", start + section.length + 2));
    assert.match(body, /docs\/setup-guide\.html#step-\d+/, `README "${section}" does not point to its step in the HTML guide`);
  }
});

test("every heading of the Markdown guide the README links to exists", () => {
  // GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens.
  const slugs = new Set([...md.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-")));
  const targets = [...readme.matchAll(/docs\/setup-guide\.md#([a-z0-9-]+)/g)].map((m) => m[1]!);
  assert.ok(targets.length >= 4);
  for (const slug of targets) assert.ok(slugs.has(slug), `README links to docs/setup-guide.md#${slug}, which is not a heading of the guide`);
});

test("every step the README points to exists in the HTML guide", () => {
  const targets = [...readme.matchAll(/docs\/setup-guide\.html#([a-z0-9-]+)/g)].map((m) => m[1]!);
  assert.ok(targets.length >= 4);
  for (const id of targets) assert.ok(html.includes(`id="${id}"`), `README links to #${id}, which the HTML guide does not have`);
});

test("links to GitHub in the HTML guide go to the repository the README tells you to clone", () => {
  const repo = /^git clone (\S+) \S+$/m.exec(readme)?.[1];
  assert.ok(repo, "README has no git clone line");
  const links = [...html.matchAll(/href="(https:\/\/github\.com\/[^"]*)"/g)].map((m) => m[1]!);
  assert.ok(links.length >= 3, "the HTML guide should link to the README on GitHub");
  for (const link of links) assert.ok(link === repo || link.startsWith(`${repo}#`) || link.startsWith(`${repo}/`), `${link} is not in ${repo}`);
});

test("the HTML guide is one self-contained file: nothing is loaded from the network", () => {
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, "external script");
  assert.doesNotMatch(html, /<link[^>]*rel=["']?stylesheet/i, "external stylesheet");
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i, "CSS loaded from the network");
  assert.doesNotMatch(html, /<(img|iframe|video|audio|source)[^>]*\ssrc=["']?https?:/i, "media loaded from the network");
});
