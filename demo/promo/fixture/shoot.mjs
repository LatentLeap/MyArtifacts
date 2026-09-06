// Publishes kiln.html to a fresh demo server, pins three Annotations as the Reader, and takes the
// README screenshot. Run from the repo root: node demo/promo/fixture/shoot.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '/Users/jake/.claude/skills/ndemo/node_modules/playwright/index.mjs';

const U = 'http://localhost:8827';
execSync('sh demo/walkthrough/serve.sh', { stdio: 'inherit' });
const T = readFileSync('demo/walkthrough/fixtures/token', 'utf8').trim();
const api = async (path, init) => {
  const r = await fetch(U + path, init);
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};
const auth = { Authorization: `Bearer ${T}` };
const { artifact } = await api('/api/artifacts?canvas=1200', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/html' }, body: readFileSync('demo/promo/fixture/kiln.html') });
const reader = await api(`/api/artifacts/${artifact}/readers`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Maya Ortiz' }) });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: 'en-US' });
const p = await ctx.newPage();
await p.goto(`http://${artifact}.usercontent.localhost:8828/v/1`);
const sigs = await p.evaluate((ids) => {
  const hash = (str) => { let a = 0x811c9dc5, b = 0x050c5d1f; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x01000193) >>> 0; } return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); };
  return ids.map((id) => { const el = document.getElementById(id); const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2048); return hash(el.tagName.toLowerCase() + '\n' + (text || el.outerHTML.slice(0, 2048))); });
}, ['hero-title', 'glaze-tenmoku', 'price-wheel']);

const PINS = [
  ['#hero-title', { x: 0.78, y: 0.22 }, "Can we say six weeks? The fall course got shorter."],
  ['#glaze-tenmoku', { x: 0.62, y: 0.28 }, "Ours fires almost black — this reads too brown."],
  ['#price-wheel', { x: 0.18, y: 0.5 }, "Wheel I is $320 now, not $290."],
];
const ids = [];
for (const [i, [path, pin, text]] of PINS.entries()) {
  const a = await api(`${new URL(reader.url).pathname}/annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, anchor: { path, pin, sig: sigs[i] }, text }) });
  ids.push(a.annotation);
}
await p.goto(`${reader.url}#${ids[0]}`);
await p.waitForTimeout(1500);
await p.screenshot({ path: 'docs/media/reader.png' });
// The video's copy: taller, no card open, plus where each bubble sits (CSS px) for the animation.
const tall = await ctx.newPage();
await tall.setViewportSize({ width: 1280, height: 1600 });
await tall.goto(reader.url);
await tall.waitForTimeout(1500);
await tall.screenshot({ path: 'demo/promo/public/reader.png' });
const bubbles = await tall.evaluate(() => [...document.querySelectorAll('.bub')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }));
await b.close();
console.log(JSON.stringify({ artifact, reader: reader.url, ids, bubbles }));
