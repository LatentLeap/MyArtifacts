// One process, two listeners, one directory.
//
// The Shell listener holds every API call and every page of ours. The usercontent listener
// serves Artifact bodies and nothing else, one origin per Artifact (ADR-0007) — the origin
// is decided by the socket the request arrived on and the Host it names, never by a path,
// so nothing on the Shell port can be talked into handing out Artifact bytes.
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

import { STRINGS, langOf } from './strings.ts';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Lang, Strings } from './strings.ts';

const MAX_BYTES = 16 * 1024 * 1024;
const TITLE_WINDOW = 8 * 1024;
/**
 * Spec §10's quota table, the half that is a number rather than a knob. A document is bounded so
 * one page cannot make the box hold a file for it; an Artifact's store is bounded so a link that
 * has leaked cannot fill the disk one row at a time. The organisation-wide `quota_exceeded` the
 * contract also defines is deliberately never emitted — there is no plan on this box to exceed.
 */
const DOC_BYTES = 256 * 1024;
const DOC_DEPTH = 32;
const DOCS_PER_ARTIFACT = 5000;
/**
 * No `allow-downloads`: a page's own `<a download>` is inert, and the only way a file reaches the
 * Reader is `downloads.save` — over the Bridge, named and sized to their face, and triggered by
 * the Shell on the Shell's own origin (spec §9).
 */
const SANDBOX = 'allow-scripts allow-same-origin allow-forms';
const ID = '[a-f0-9]{32}';
/**
 * Zero declaration (ADR-0010): we take a bare file, so every Artifact is offered the same four
 * and `use()` answers `null` for every other name — which the contract already requires pages to
 * handle. A read-only view still resolves `artifact`; its `publish` is what refuses.
 */
const CAPS = ['db', 'user', 'downloads', 'artifact'];
/** A Client is a short lowercase slug on the token, not a row anywhere (ADR-0008). */
/** Everything the server ships alongside itself is found from here. */
const HERE = dirname(fileURLToPath(import.meta.url));
/** A script's source, safe to inline: the closing-tag escape keeps it from ending its own script block. */
const inlineScript = (file: string) =>
  readFileSync(join(HERE, file), 'utf8').replace(/<\/script/gi, '<\\/script');
const RUNTIME_SRC = inlineScript('runtime.js');
/** The Shell page's script: the Bridge's Shell half and the annotation layer, inlined so the page is one request. */
const SHELL_SRC = inlineScript('shell.js');
/** The agent skill, the repo's only copy, served verbatim at `/skill.md` (spec §13). */
const SKILL_SRC = readFileSync(join(HERE, '..', 'skills', 'myartifacts', 'SKILL.md'), 'utf8');

export type Config = {
  dataDir: string;
  shellPort?: number;
  usercontentPort?: number;
  /** Public origin of the Shell. Defaults to the loopback address the Shell listens on. */
  shellOrigin?: string;
  /** Host suffix Artifacts are served under; each gets `<id>.<host>`. */
  usercontentHost?: string;
  /** Where a new Annotation announces itself. Unset and nothing is sent (spec §11). */
  webhookUrl?: string;
  /**
   * The per-identity token bucket (spec §10): calls a second, and how many may arrive at once.
   * Tuning, not contract — the numbers are what one Reader's page needs headroom for, and an
   * operator whose pages are chattier moves them.
   */
  ratePerSecond?: number;
  rateBurst?: number;
};

export type Running = {
  shellOrigin: string;
  usercontentOrigin: (artifact: string) => string;
  close: () => Promise<void>;
};

// --- storage -----------------------------------------------------------------

const versionPath = (dataDir: string, artifact: string, n: number) => join(dataDir, 'versions', artifact, `${n}.html`);

function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'myartifacts.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tokens (
      name       TEXT PRIMARY KEY,
      hash       TEXT NOT NULL UNIQUE,
      -- NULL is one of us; anything else confines the token to that Client (ADR-0008).
      client     TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id         TEXT PRIMARY KEY,
      -- Copied from the token (or ?client=) at publish time, never edited (ADR-0008).
      client     TEXT,
      -- A frozen Version, or NULL for live: the Reader follows the newest one (ADR-0009).
      pinned     INTEGER,
      -- Soft delete, one direction. Everything below it — Versions, files, Readers — stays.
      deleted_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS readers (
      id         TEXT PRIMARY KEY,
      artifact   TEXT NOT NULL REFERENCES artifacts(id),
      secret     TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      artifact     TEXT NOT NULL REFERENCES artifacts(id),
      n            INTEGER NOT NULL,
      canvas       INTEGER NOT NULL,
      title        TEXT,
      published_by TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (artifact, n)
    );
    -- The Artifact's document store (spec §10): one row per document, one store per Artifact,
    -- surviving every republish. Nothing here is deleted with the Artifact (ADR-0006) — the
    -- door stops answering and the rows stay.
    CREATE TABLE IF NOT EXISTS docs (
      artifact     TEXT NOT NULL REFERENCES artifacts(id),
      path         TEXT NOT NULL,
      -- Derived: the path without its last segment, so a query is one indexed-enough lookup.
      collection   TEXT NOT NULL,
      json         TEXT NOT NULL,
      -- Climbs on every write: what a lease hands back, and what tells a snapshot it changed.
      version      INTEGER NOT NULL,
      updated_at   TEXT NOT NULL,
      updated_by   TEXT NOT NULL,
      lease_holder TEXT,
      lease_until  TEXT,
      PRIMARY KEY (artifact, path)
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id         TEXT PRIMARY KEY,
      artifact   TEXT NOT NULL REFERENCES artifacts(id),
      reader     TEXT NOT NULL REFERENCES readers(id),
      -- The Version it was pinned on; the anchor is re-resolved against whatever is on screen (ADR-0011).
      version    INTEGER NOT NULL,
      -- {path, pin: {x, y}, sig}, stored as it came: bounded on the way in, never parsed (ADR-0011).
      anchor     TEXT NOT NULL,
      text       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );
  `);
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a directory that already has the table, and
  // SQLite has no `ADD COLUMN IF NOT EXISTS`. A data directory is the whole system state
  // (ADR-0006) — the process has to come up against one from before these columns.
  const added: [string, string, string][] = [
    ['artifacts', 'pinned', 'INTEGER'], ['artifacts', 'deleted_at', 'TEXT'], ['artifacts', 'client', 'TEXT'],
    ['tokens', 'client', 'TEXT'], ['tokens', 'revoked_at', 'TEXT'],
  ];
  for (const [table, name, type] of added) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  return db;
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Mints a token and returns the plaintext. It is never stored and never shown again. */
function insertToken(db: DatabaseSync, name: string, client: string | null): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO tokens (name, hash, client, created_at) VALUES (?, ?, ?, ?)').run(name, hashOf(token), client, new Date().toISOString());
  return token;
}

/** The first token, from a hand on the machine; every later one comes through the API. */
export function mintToken(dataDir: string, name: string): string {
  const db = openDb(dataDir);
  try {
    return insertToken(db, name, null);
  } finally {
    db.close();
  }
}

// --- publishing --------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
    const code = Number(ref[1] === 'x' || ref[1] === 'X' ? `0${ref.slice(1)}` : ref.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * One title out of the characters that make it up, wherever they were found. Stored decoded,
 * so whoever renders it escapes it once and only once.
 * ponytail: 200 chars is a gallery-row cap, not a spec number; nothing breaks above it.
 */
const asTitle = (text: string): string | null =>
  decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, 200) || null;

/**
 * The page's title, the way a browser would read it: the first <title> that is the
 * document's own, not one inside an <svg> — an inline SVG carrying a <title> for
 * accessibility is exactly what our pages are asked to prefer over raster images.
 */
function titleOf(body: Buffer): string | null {
  const head = body
    .subarray(0, TITLE_WINDOW)
    .toString('utf8')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<svg\b[\s\S]*$/i, ''); // an <svg> the window cut in half takes the rest with it
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  return m?.[1] ? asTitle(m[1]) : null;
}

/**
 * Document typography for a rendered Markdown page — inline, so the page stays self-contained.
 * ponytail: fixed px against a line-length cap, not the declared Canvas. A document published at
 * a 1200px Canvas therefore reads small once the Shell scales that down to a phone; the fix is
 * publishing documents at a document-width Canvas, not styling that chases the Canvas.
 */
const MARKDOWN_STYLE =
  '<style>body{max-width:46em;margin:0 auto;padding:48px 32px;font:16px/1.7 -apple-system,"PingFang SC",' +
  'Helvetica,sans-serif;color:#1a1a1a}h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .6em}h1{font-size:1.9em;margin-top:0}' +
  'h2{font-size:1.45em}h3{font-size:1.2em}p,ul,ol,blockquote,table,pre{margin:0 0 1em}a{color:#d9542b}' +
  'code{font:.9em ui-monospace,Menlo,monospace;background:#f1efec;padding:.15em .35em;border-radius:3px}' +
  'pre{background:#f1efec;padding:14px 16px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}' +
  'blockquote{border-left:3px solid #ddd;padding-left:1em;color:#5a5a5a}table{border-collapse:collapse;width:100%}' +
  'th,td{border:1px solid #e0ddd8;padding:6px 10px;text-align:left}hr{border:0;border-top:1px solid #e0ddd8;margin:2em 0}</style>';

/**
 * Markdown becomes HTML here and only here: a Version file on disk is always HTML, so
 * everything downstream — the wrapper, the CSP, the Reader — is blind to how it arrived.
 * The title is the document's first `#`, read back off the rendered heading rather than the
 * source, which is what keeps a `#` inside a fenced code block from becoming the title.
 * Raw HTML in the source passes through, as it does for an HTML publish; the CSP on the
 * usercontent origin is the boundary, not this function.
 */
function renderMarkdown(body: Buffer): { html: string; title: string | null } {
  // A leading BOM is invisible to whoever wrote the file and stops the first `#` being a heading.
  const rendered = marked.parse(body.toString('utf8').replace(/^\uFEFF/, ''), { async: false });
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(rendered);
  // A heading carries inline markup — `# **Q3** review` — and a title is characters, not markup.
  return { html: MARKDOWN_STYLE + rendered, title: h1?.[1] ? asTitle(h1[1].replace(/<[^>]*>/g, '')) : null };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON safe to drop inside a script block. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
/**
 * One language's column as a script literal for the comment client: strings as JSON, and the
 * interpolating keys as the arrow functions they already are — `String(fn)` is their source, which
 * Node hands over with the type annotations blanked out. No placeholder grammar on either side.
 */
const scriptStrings = (t: Strings['shell'] | Strings['pub']) =>
  `{${Object.entries(t).map(([k, v]) => `${k}:${typeof v === 'function' ? String(v) : scriptJson(v)}`).join(',')}}`;

/** Wrap the published fragment in our skeleton, runtime first. Claude's shape, kept on purpose. */
function wrap(fragment: string, runtime: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><script>${runtime}</script>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,-apple-system,sans-serif;background:#fdfdfc}` +
    `img{max-width:100%}[hidden]{display:none!important}</style></head><body>${fragment}</body></html>`;
}

/**
 * The Shell page that holds an Artifact: our code, our origin, the Artifact behind an iframe.
 * One page for both audiences — the Reader at `/r/{secret}` and the Publisher previewing a
 * version — because they differ only in whose name is in the header and what `ready` says.
 * The Reader's annotation layer (ticket 06) lands on this same stage.
 */
function shellPage(o: {
  n: number;
  canvas: number;
  title: string | null;
  artifactOrigin: string;
  /** Shown in the header. The Reader's name is set by the publisher and never changes. */
  who: string;
  me: { id: string; canEdit: boolean; isOwner: boolean };
  /** This view's annotations URL: the Reader's own door, or the Publisher's list of the Artifact. */
  api: string;
  /** Set on the Publisher's Version view (spec §12): a header of its own, and what decides whether
   * a page may publish itself from here — only the live Version of an unfrozen Artifact. */
  preview?: { artifact: string; pinned: number | null; latest: number };
  /** The caller's own mount: `/db` is every capability call the framed page makes, `/versions` its own publish. */
  mount: string;
  /** Where this view goes when a Version lands, minus the number. Null and it reloads in place —
   * the Reader's link re-serves whatever is live (or frozen); a preview names a Version in its own
   * address and has to be sent to the new one. */
  versionUrl: string | null;
  lang: Lang;
}): string {
  const ready = { caps: CAPS, me: o.me };
  const t = STRINGS[o.lang];
  const title = o.title ?? t.untitled;
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><title>${esc(title)} · v${o.n}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{--bar:48px;--acc:#d9542b;--mut:#6b6b6b;--line:#e6e6e6}
 *{box-sizing:border-box}
 body{margin:0;font:15px/1.45 -apple-system,"PingFang SC","Helvetica Neue",sans-serif;color:#1a1a1a;background:#f6f5f3;-webkit-text-size-adjust:100%}
 header{position:sticky;top:0;z-index:20;height:var(--bar);background:#1d1d1f;color:#fff;display:flex;align-items:center;gap:10px;padding:0 12px}
 header .t{flex:1;min-width:0;font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 header .v{font-size:12px;color:#aaa;flex:none}
 header .back{color:#ddd;text-decoration:none;font-size:13px;flex:none}
 .who{display:flex;align-items:center;gap:6px;font-size:12px;color:#ddd;max-width:45%}
 .who .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .av{width:24px;height:24px;border-radius:50%;background:var(--acc);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
 #stage{position:relative;overflow:hidden;background:#fff}
 iframe{display:block;border:0;transform-origin:0 0;background:#fff}
 button{font:inherit;cursor:pointer}textarea{font:inherit}
 .cbtn{position:relative;border:0;background:#333;color:#fff;border-radius:8px;height:32px;padding:0 10px;display:flex;align-items:center;gap:6px;font-size:13px;flex:none}
 .cbtn[aria-pressed="true"]{background:var(--acc)}.cbtn:disabled{opacity:.5;cursor:default}
 .cbtn .cnt{background:#fff;color:#1d1d1f;border-radius:999px;font-size:11px;padding:0 6px;line-height:16px;font-weight:600}
 #overlay{position:absolute;inset:0;pointer-events:none}
 body.mode #stage::after{content:"";position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px var(--acc)}
 .bub{position:absolute;width:32px;height:32px;margin:-32px 0 0 0;border-radius:16px 16px 16px 2px;background:#fff;border:2px solid var(--acc);box-shadow:0 2px 6px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;pointer-events:auto;padding:0}
 .bub .av{width:22px;height:22px;font-size:11px}
 .bub.addressed{opacity:.6;border-color:#999}.bub.addressed .av{background:#999}
 .bub.draft{border-style:dashed}.bub.draft .av{background:#fff;color:var(--acc);border:1px dashed var(--acc)}
 .bub.sel{box-shadow:0 0 0 3px rgba(217,84,43,.35),0 2px 6px rgba(0,0,0,.25)}
 .pile{position:fixed;left:50%;transform:translateX(-50%);z-index:15;background:#1d1d1f;color:#fff;font-size:12px;border-radius:999px;padding:5px 12px;border:0}
 .pile.up{top:calc(var(--bar) + 8px)}.pile.down{bottom:64px}
 .card{position:fixed;z-index:30;width:320px;max-width:calc(100vw - 16px);background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px}
 .card .author{display:flex;align-items:center;gap:8px;font-size:13px}.card .author .time{color:var(--mut);font-size:12px;margin-left:auto}
 .card .txt{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
 .card textarea{width:100%;min-height:64px;border:1px solid var(--line);border-radius:8px;padding:8px;resize:none;margin-top:8px}
 .card .row,dialog .row{display:flex;gap:6px;align-items:center;margin-top:8px}.sp{flex:1}
 dialog.ask{border:0;border-radius:12px;padding:14px 16px;width:320px;max-width:calc(100vw - 24px);box-shadow:0 8px 28px rgba(0,0,0,.18);font:inherit;color:inherit}
 dialog.ask::backdrop{background:rgba(0,0,0,.35)}
 dialog.ask .fn{margin:8px 0 0;font-weight:600;overflow-wrap:anywhere}
 .btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 12px;font-size:13px}
 .btn.pri{background:var(--acc);color:#fff;border-color:var(--acc)}.btn.ghost{border-color:transparent;color:var(--mut)}
 .hint{font-size:12px;color:var(--mut);margin-top:6px}
 .badge{font-size:11px;border-radius:4px;padding:1px 6px;background:#eee;color:#555;white-space:nowrap}
 .badge.detached{background:#fff1cc;color:#7a5a00}.badge.addressed{background:#e4f3e8;color:#1f6f3f}
 .pill{position:fixed;right:14px;bottom:14px;z-index:15;border:0;background:#1d1d1f;color:#fff;border-radius:999px;padding:10px 14px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.3)}
 .drawer{position:fixed;top:calc(var(--bar) + 8px);right:8px;width:360px;max-height:calc(100vh - var(--bar) - 16px);z-index:25;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);display:none;flex-direction:column}
 .drawer.open{display:flex}
 .drawer .dh{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);font-weight:600}.drawer .dh .cnt{font-weight:400;font-size:12px;color:var(--mut)}
 .drawer .body{overflow:auto;padding:6px 0}
 .grp{padding:10px 14px 4px;font-size:12px;color:var(--mut);letter-spacing:.02em}
 .rowi{display:flex;gap:10px;padding:10px 14px;border-top:1px solid var(--line);cursor:pointer}.rowi.addressed{opacity:.6}
 .rowi .m{flex:1;min-width:0}.rowi .top{display:flex;align-items:center;gap:6px;font-size:13px}.rowi .top .time{color:var(--mut);font-size:12px}
 .rowi .top .bg{margin-left:auto;display:flex;gap:4px}.rowi .line{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
 .tog{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line);background:none;padding:10px 14px;color:var(--mut);font-size:13px}
 .empty{padding:24px 14px;color:var(--mut);font-size:14px}
 @media (max-width:480px){.drawer{top:var(--bar);right:0;left:0;bottom:0;width:100vw;max-height:none;border:0;border-radius:0}}
</style></head><body>
<header>${o.preview ? `<a class="back" href="/a/${o.preview.artifact}">${t.back}</a>` : ''}<div class="t">${esc(title)}</div><span class="v">v${o.n}</span>${
  o.preview ? `${o.preview.pinned === null ? '' : `<span class="badge">${o.preview.pinned === o.n ? t.frozenHere : t.frozenAt(o.preview.pinned)}</span>`}<span class="badge">${t.readOnly}</span>` : ''
}
<span class="who"${o.me.isOwner ? '' : ` title="${t.shell.nameSetByPublisher}"`}><span class="av">${esc([...o.who][0] ?? '?')}</span><span class="n">${esc(o.who)}</span></span>${
  // An Annotation always comes from a Reader (CONTEXT.md): a Publisher's view has no button to make one.
  o.me.isOwner ? '' : `<button class="cbtn" id="cbtn" aria-pressed="false" aria-keyshortcuts="c" disabled title="${t.loading}">${t.shell.annotate}</button>`
}</header>
<div id="stage"><iframe id="f" src="${esc(o.artifactOrigin)}/v/${o.n}" sandbox="${SANDBOX}"></iframe><div id="overlay"></div></div>
<button class="pile up" id="pile-up" hidden></button><button class="pile down" id="pile-down" hidden></button>
<button class="pill" id="pill">${t.shell.allAnnotations}</button>
<aside class="drawer" id="drawer" aria-label="${t.shell.allAnnotations}"><div class="dh">${t.shell.annotations} <span class="cnt" id="dcnt"></span><span class="sp"></span><button class="btn ghost" id="dclose">${t.collapse}</button></div><div class="body" id="dbody"></div></aside>
<script>
const ART=${scriptJson(o.artifactOrigin)},CANVAS=${o.canvas},READY=${scriptJson(ready)},VERSION=${o.n},WHO=${scriptJson(o.who)},API=${scriptJson(o.api)},MOUNT=${scriptJson(o.mount)},VERSION_URL=${scriptJson(o.versionUrl)},WRITER=${scriptJson(!o.preview || (o.preview.latest === o.n && o.preview.pinned === null))},T=${scriptStrings(t.shell)};
${SHELL_SRC}</script></body></html>`;
}

/** Revoked, or a secret that was never issued. The two are the same page on purpose. */
const deadPage = (lang: Lang) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${STRINGS[lang].dead}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
 font:15px/1.5 -apple-system,"PingFang SC","Helvetica Neue",sans-serif;color:#1a1a1a;background:#f6f5f3}
 h1{font-size:20px;margin:0}p{margin:0;color:#6b6b6b}</style>
</head><body><h1>${STRINGS[lang].dead}</h1><p>${STRINGS[lang].askPublisher}</p></body></html>`;

// --- http plumbing -----------------------------------------------------------

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const fail = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { error: { code, message } });
const notFound = (res: ServerResponse) => fail(res, 404, 'not_found', 'no such thing');
/**
 * A page of ours. Never cached: every one of them is a view of something that just changed —
 * and every one speaks the browser's language, which `Vary` says for the cache that ignores `no-store`.
 */
const sendHtml = (res: ServerResponse, code: number, body: string) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Language' });
  res.end(body);
};
const redirect = (res: ServerResponse, to: string, cookie?: string) => {
  res.writeHead(302, { location: to, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end();
};
/** A Client is a short lowercase slug on the token, not a row anywhere (ADR-0008). The shape is ours. */
const isClient = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v);
const badClient = (res: ServerResponse) => fail(res, 400, 'invalid_argument', 'client must be a short lowercase slug');
/**
 * A token's name is also its identity inside an Artifact's document store, where Reader ids live
 * in the same namespace (spec §10). A name shaped like one would hand its holder that Reader's
 * private subtree — the one thing a Publisher is not supposed to be able to open.
 */
const looksLikeReaderId = (name: string) => new RegExp(`^${ID}$`).test(name);
/** The only two states an Annotation is ever in (CONTEXT.md). No route accepts anything else. */
const isStatus = (v: unknown): v is 'open' | 'addressed' => v === 'open' || v === 'addressed';
const badStatus = (res: ServerResponse) => fail(res, 400, 'invalid_argument', 'status must be open or addressed');

type ReaderRow = { id: string; name: string; secret: string; revoked_at: string | null; created_at: string };
/** A live link, resolved from its secret: who is calling, on which Artifact, and whether it is frozen. */
type LiveReader = { id: string; artifact: string; name: string; pinned: number | null };
type ArtifactRow = { id: string; pinned: number | null; client: string | null };
/** Who is calling: a token's name, and the Client it is confined to — null for one of us. */
type Publisher = { name: string; client: string | null };
type Anchor = { path: string; pin: { x: number; y: number }; sig: string };
type AnnotationRow = {
  id: string; artifact: string; reader: string; name: string; version: number; anchor: string; text: string;
  status: 'open' | 'addressed'; created_at: string;
};
/** An Annotation with its author's name: what every list item is made from. */
const ANNOTATION_ROW =
  'SELECT a.id, a.artifact, a.reader, r.name, a.version, a.anchor, a.text, a.status, a.created_at' +
  ' FROM annotations a JOIN readers r ON r.id = a.reader';
type VersionRow = { n: number; canvas: number; title: string | null; published_by: string; created_at: string };
type TokenRow = { name: string; client: string | null; created_at: string };
type GalleryRow = {
  artifact: string; client: string | null; pinned: number | null; latest: number; title: string | null;
  readers: number; open_annotations: number; last_published_at: string; last_published_by: string;
};

const parseJson = (body: Buffer | null): unknown => {
  try {
    return JSON.parse(body?.toString('utf8') ?? '');
  } catch {
    return null;
  }
};

/** Reads the request body, draining it either way so the connection stays usable. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_BYTES) { over = true; chunks.length = 0; } else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type Accepted = { canvas: number; body: Buffer; title: string | null };

/**
 * The publish contract, identical wherever a Version is minted: a declared Canvas, an HTML or
 * Markdown body, under the cap. Answers the caller itself when one of them is missing, and hands
 * back the HTML that goes to disk — Markdown is rendered here, so no caller downstream sees it.
 */
function accept(res: ServerResponse, url: URL, req: IncomingMessage, body: Buffer | null, inherited?: number): Accepted | null {
  // A page declares nothing: it is already laid out at its Version's width, so a page publish takes
  // that width and a `?canvas=` sent alongside `?base=` is ignored rather than re-laying the Artifact.
  const canvas = inherited ?? Number(url.searchParams.get('canvas'));
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  // The four ways a publish is refused before a byte is written.
  if (!Number.isInteger(canvas) || canvas <= 0) fail(res, 400, 'invalid_argument', 'canvas must be a width in px');
  else if (type !== 'text/html' && type !== 'text/markdown') fail(res, 415, 'unsupported_media_type', 'body must be text/html or text/markdown');
  else if (!body) fail(res, 413, 'too_large', 'over 16 MiB');
  else if (type === 'text/html') return { canvas, body, title: titleOf(body) };
  else {
    // A Markdown page has no other place to carry a title, so a document without one is
    // an incomplete publish rather than an untitled Version.
    const { html, title } = renderMarkdown(body);
    const rendered = Buffer.from(html, 'utf8');
    if (!title) fail(res, 400, 'invalid_argument', 'markdown must have a # heading to take a title from');
    // The cap is on what a Reader downloads over the cross-border hop, and rendering is the one
    // place a body grows: a table expands several-fold on its way through.
    else if (rendered.length > MAX_BYTES) fail(res, 413, 'too_large', 'over 16 MiB once rendered');
    else return { canvas, body: rendered, title };
  }
  return null;
}

/**
 * A Bearer header, or the cookie a browser holds. Spec §3 puts both on the same endpoints, and
 * both are looked up the same way — so revoking a token cuts the API call and the browser
 * session in one row, with nothing session-shaped stored anywhere to expire separately.
 */
function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(req.headers.cookie ?? '');
  return cookie?.[1] ? decodeURIComponent(cookie[1]) : null;
}

/**
 * A new Annotation's body, checked at the trust boundary and nowhere else. `path` and `sig` are
 * opaque to the Shell — bounded in length, never parsed (ADR-0011); `sig` is the runtime's 16-hex
 * digest, so a different length is a forgery or a bug, not a variant.
 */
function parseAnnotation(body: Buffer | null): { version: number; anchor: Anchor; text: string } | string {
  const { version, anchor, text } = (parseJson(body) ?? {}) as { version?: unknown; anchor?: Partial<Anchor>; text?: unknown };
  if (!Number.isInteger(version)) return 'version must be an integer';
  const { path, pin, sig } = anchor ?? {};
  if (typeof path !== 'string' || !path || path.length > 1000) return 'anchor.path must be 1–1000 characters';
  if (typeof sig !== 'string' || !/^[0-9a-f]{16}$/.test(sig)) return 'anchor.sig must be 16 hex characters';
  const ok = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
  if (!pin || !ok(pin.x) || !ok(pin.y)) return 'anchor.pin must be {x, y} fractions of the element';
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed || [...trimmed].length > 4096) return 'text must be 1–4096 characters';
  return { version: version as number, anchor: { path, pin: { x: pin.x, y: pin.y }, sig }, text: trimmed };
}


// --- the publisher's pages ---------------------------------------------------
//
// Five server-rendered pages behind one cookie (spec §12). Every mutation on them is the
// same JSON endpoint an agent's curl reaches — the page fetches it with the cookie the
// browser already holds and reloads — so there is one authorisation path, not two.

/** The browser session (spec §3): the same token a Bearer header carries, held by the Shell origin. */
const COOKIE = 'myartifacts';
/** No "remember me": a session is either this long or it is a logout. 400 days is the browser's own ceiling. */
const COOKIE_MAX_AGE = 400 * 24 * 3600;
/**
 * `SameSite=Lax` is what keeps the cookie from being spent by someone else's form: it is the
 * only thing standing between a browser session and CSRF on the very endpoints an agent uses.
 * `HttpOnly` keeps it away from the annotation layer's own script.
 */
const cookieHeader = (token: string | null, secure: boolean) =>
  `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${token === null ? 0 : COOKIE_MAX_AGE}`;

const PUBLISHER_CSS = `
 :root{--acc:#d9542b;--mut:#6b6b6b;--line:#e6e6e6}
 *{box-sizing:border-box}
 body{margin:0;font:14px/1.5 -apple-system,"PingFang SC","Helvetica Neue",sans-serif;color:#1a1a1a;background:#f6f5f3}
 header{background:#1d1d1f;color:#fff;display:flex;align-items:center;gap:16px;padding:0 16px;height:48px}
 header a{color:#ddd;text-decoration:none;font-size:13px}header a:hover{color:#fff}
 header .brand{font-weight:600;color:#fff;font-size:14px}
 header .me{font-size:12px;color:#aaa}header form{margin:0}
 .sp{flex:1}
 main{max-width:1040px;margin:0 auto;padding:20px 16px 64px}
 h1{font-size:20px;margin:0}h2{font-size:14px;margin:28px 0 8px;color:var(--mut)}
 .sub{color:var(--mut);font-size:13px;margin:4px 0 0}
 .top{display:flex;align-items:flex-start;gap:12px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
 th,td{text-align:left;padding:9px 12px;border-top:1px solid var(--line);vertical-align:top}
 th{background:#faf9f8;border-top:0;font-size:12px;font-weight:600;color:var(--mut);white-space:nowrap}
 td.n{white-space:nowrap}td.t{max-width:420px;overflow-wrap:anywhere}
 tr.gone td{opacity:.5}
 a{color:#1a1a1a}
 button{font:inherit;cursor:pointer}
 .btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:4px 10px;font-size:13px;white-space:nowrap}
 .btn:disabled{opacity:.5;cursor:default}
 .btn.pri{background:var(--acc);color:#fff;border-color:var(--acc)}
 .btn.ghost{border-color:transparent;background:none;color:#ddd}
 .btn.warn{color:#a3301a;border-color:#eccfc7}
 .badge{font-size:11px;border-radius:4px;padding:1px 6px;background:#eee;color:#555;white-space:nowrap}
 .badge.on{background:#fff1cc;color:#7a5a00}
 .tabs{display:flex;gap:12px;font-size:13px;margin:0 0 8px}
 .tabs a{color:var(--mut);text-decoration:none}.tabs a.sel{color:#1a1a1a;font-weight:600}
 .mk{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap}
 input{font:inherit;border:1px solid var(--line);border-radius:8px;padding:5px 10px;background:#fff}
 .empty{color:var(--mut);padding:14px 0}
 .banner{background:#fff8e6;border:1px solid #f0dca8;border-radius:10px;padding:12px;margin:0 0 12px}
 .banner code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;display:block;margin:6px 0}
 .lk{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
`;

/**
 * One delegated handler for every button on every page: the endpoint, the verb and the body
 * ride on the element. Success reloads, because the row that changed is one of many and the
 * server already knows how to render all of them.
 */
const PUBLISHER_JS = `
for(const t of document.querySelectorAll('time'))t.textContent=new Date(t.dateTime).toLocaleString();
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-copy],[data-url]');if(!b)return;
 const d=b.dataset;
 // ponytail: \`navigator.clipboard\` is undefined outside a secure context, and this does nothing
 // there. The Shell is behind TLS in production and localhost counts as secure; if it is ever
 // served plain over an IP, the fallback is a hidden textarea and \`document.execCommand\`.
 if(d.copy!==undefined){await navigator.clipboard.writeText(d.copy);const was=b.textContent;b.textContent=T.copied;setTimeout(()=>{b.textContent=was},1200);return}
 // A button whose body is typed rather than known at render time names the field it reads.
 if(d.from){const i=document.getElementById(d.from);if(!i.value.trim())return i.focus();d.body=JSON.stringify({name:i.value.trim()})}
 if(d.confirm&&!confirm(d.confirm))return;
 b.disabled=true;
 const r=await fetch(d.url,{method:d.method,...(d.body?{headers:{'content-type':'application/json'},body:d.body}:{})});
 if(!r.ok){b.disabled=false;alert(T.httpFailed(r.status));return}
 d.go?location.assign(d.go):location.reload();
});
`;

/** The chrome the four pages behind the cookie share. `/login` has none of it on purpose. */
function publisherPage(o: { title: string; publisher: Publisher; body: string; script?: string; lang: Lang }): string {
  const t = STRINGS[o.lang];
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><title>${esc(o.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PUBLISHER_CSS}</style></head><body>
<header><a class="brand" href="/">MyArtifacts</a><a href="/">${t.gallery}</a>${
    o.publisher.client === null ? `<a href="/members">${t.members}</a>` : ''
  }<span class="sp"></span><span class="me">${esc(o.publisher.name)}${
    o.publisher.client ? ` · ${esc(o.publisher.client)}` : ''
  }</span><form method="post" action="/logout"><button class="btn ghost">${t.logout}</button></form></header>
<main>${o.body}</main>
<script>
const T=${scriptStrings(t.pub)};${PUBLISHER_JS}${o.script ?? ''}</script></body></html>`;
}

/**
 * Deleted, or another Client's — indistinguishable on purpose (ADR-0008). A person who followed
 * a stale link (a bookmark, a webhook) keeps the chrome, and with it the way back to the gallery.
 */
const missingPage = (publisher: Publisher, lang: Lang) => publisherPage({
  title: `${STRINGS[lang].notFound} · MyArtifacts`, publisher, lang,
  body: `<p class="empty">${STRINGS[lang].artifactNotFound}</p>`,
});

/** The one page with no cookie behind it. One field, one line of error, nothing to remember. */
function loginPage(lang: Lang, refused = false): string {
  const t = STRINGS[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>MyArtifacts</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PUBLISHER_CSS}
 body{display:flex;align-items:center;justify-content:center;min-height:100vh}
 form{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;width:340px;max-width:calc(100vw - 24px)}
 form h1{font-size:17px;margin:0 0 12px}
 form input{width:100%;margin:0 0 10px}
 form button{width:100%}
 .err{color:#a3301a;font-size:13px;margin:0 0 10px}
</style></head><body>
<form method="post" action="/login"><h1>MyArtifacts</h1>
${refused ? `<p class="err">${t.badToken}</p>` : ''}
<input name="token" type="password" autocomplete="off" autofocus placeholder="${t.pasteToken}">
<button class="btn pri">${t.enter}</button></form></body></html>`;
}

const when = (iso: string) => `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace('T', ' '))}</time>`;
const dash = (s: string | null) => (s ? esc(s) : '—');

/** The gallery (spec §12): one flat table, newest publish first. No grouping, search or paging. */
function galleryPage(publisher: Publisher, rows: GalleryRow[], lang: Lang): string {
  const t = STRINGS[lang];
  // A Client token is inside exactly one Client, so the column would say the same word every row.
  const internal = publisher.client === null;
  const body = rows.length === 0
    ? `<p class="empty">${t.noArtifacts}</p>`
    : `<table><tr><th>${t.title}</th>${internal ? `<th>${t.client}</th>` : ''}<th>${t.latest}</th><th>${t.openAnnotations}</th><th>${t.readers}</th><th>${t.lastPublished}</th></tr>${
      rows.map((r) => `<tr><td><a href="/a/${r.artifact}">${dash(r.title)}</a></td>${
        internal ? `<td class="n">${dash(r.client)}</td>` : ''
      }<td class="n">v${r.latest}${r.pinned !== null ? ` <span class="badge on">${t.frozenAt(r.pinned)}</span>` : ''}</td>` +
        `<td class="n">${r.open_annotations}</td><td class="n">${r.readers}</td>` +
        `<td class="n">${when(r.last_published_at)} · ${esc(r.last_published_by)}</td></tr>`).join('')
    }</table>`;
  return publisherPage({ title: `${t.gallery} · MyArtifacts`, publisher, lang, body: `<h1>${t.gallery}</h1>${body}` });
}

/**
 * One Artifact, three blocks stacked (spec §12). No tabs, no reply box, no document store —
 * a Publisher answers with the next Version and an `addressed`, and reads the store on
 * `/a/{id}/v/{n}` where the page itself is running.
 */
function artifactPage(o: {
  publisher: Publisher; artifact: string; client: string | null; pinned: number | null;
  versions: VersionRow[]; annotations: AnnotationRow[]; readers: ReaderRow[];
  readerUrl: (secret: string) => string; want: 'open' | 'addressed'; lang: Lang;
}): string {
  const t = STRINGS[o.lang];
  const latest = o.versions.at(-1)!;
  const api = `/api/artifacts/${o.artifact}`;
  // Spec §12 asks for a `Detached` mark here, and this page cannot honestly give one: `Detached`
  // is decided by resolving an anchor against a live DOM (§8), and there is no DOM on a table.
  // Marking every older pin instead would brand the very case ADR-0011 exists to preserve — a
  // pin whose `path` and `sig` still match is drawn, not detached. So the badge says only what
  // is true from here: this one was pinned somewhere other than what is on show. The real
  // grouping is on `/a/{id}/v/{n}`, which runs the page and asks it.
  const current = o.pinned ?? latest.n;
  const shown = o.annotations.filter((a) => a.status === o.want);
  const counts = { open: 0, addressed: 0 };
  for (const a of o.annotations) counts[a.status]++;

  const versions = `<table><tr><th>${t.version}</th><th>${t.title}</th><th>${t.canvas}</th><th>${t.published}</th><th></th></tr>${
    o.versions.map((v) => `<tr><td class="n"><a href="/a/${o.artifact}/v/${v.n}">v${v.n}</a>${
      v.n === o.pinned ? ` <span class="badge on">${t.frozen}</span>` : ''
    }</td><td>${dash(v.title)}</td><td class="n">${v.canvas}px</td><td class="n">${when(v.created_at)} · ${esc(v.published_by)}</td>` +
      `<td class="n"><button class="btn" data-url="${api}/pinned" data-method="PUT" data-body="${
        esc(JSON.stringify({ version: v.n === o.pinned ? null : v.n }))
      }">${v.n === o.pinned ? t.unfreeze : t.frozenHere}</button></td></tr>`).reverse().join('')
  }</table>`;

  const annotations = `<p class="tabs"><a href="/a/${o.artifact}" class="${o.want === 'open' ? 'sel' : ''}">${t.openN(counts.open)}</a>` +
    `<a href="/a/${o.artifact}?status=addressed" class="${o.want === 'addressed' ? 'sel' : ''}">${t.addressedN(counts.addressed)}</a></p>` +
    (shown.length === 0
      ? `<p class="empty">${o.want === 'open' ? t.noOpen : t.noAddressed}</p>`
      : `<table><tr><th>${t.reader}</th><th>${t.version}</th><th>${t.text}</th><th>${t.time}</th><th></th></tr>${
        shown.map((a) => `<tr><td class="n">${esc(a.name)}</td><td class="n">v${a.version}${
          a.version !== current ? ` <span class="badge">${t.notCurrent}</span>` : ''
        }</td><td class="t">${esc(a.text)}</td><td class="n">${when(a.created_at)}</td>` +
          `<td class="n"><button class="btn" data-url="/api/annotations/${a.id}" data-method="PATCH" data-body="${
            esc(JSON.stringify({ status: a.status === 'open' ? 'addressed' : 'open' }))
          }">${a.status === 'open' ? t.shell.markAddressed : t.shell.reopen}</button></td></tr>`).join('')
      }</table>`);

  const readers = `<div class="mk"><input id="rname" placeholder="${t.readerName}" size="30"><button class="btn pri" data-url="${api}/readers" data-method="POST" data-from="rname">${t.makeLink}</button></div>` +
    (o.readers.length === 0
      ? `<p class="empty">${t.noReaders}</p>`
      : `<table><tr><th>${t.name}</th><th>${t.link}</th><th>${t.created}</th><th></th></tr>${
        o.readers.map((r) => {
          const url = o.readerUrl(r.secret);
          return `<tr${r.revoked_at ? ' class="gone"' : ''}><td class="n">${esc(r.name)}${
            r.revoked_at ? ` <span class="badge">${t.revoked}</span>` : ''
          }</td><td class="lk">${r.revoked_at ? esc(url) : `<a href="${esc(url)}">${esc(url)}</a> <button class="btn" data-copy="${esc(url)}">${t.copy}</button>`
          }</td><td class="n">${when(r.created_at)}</td><td class="n">${
            r.revoked_at
              ? ''
              : `<button class="btn warn" data-url="${api}/readers/${r.id}" data-method="DELETE" data-confirm="${esc(t.revokeReaderAsk(r.name))}">${t.pub.revoke}</button>`
          }</td></tr>`;
        }).join('')
      }</table>`);

  return publisherPage({
    title: `${latest.title ?? t.untitled} · MyArtifacts`,
    publisher: o.publisher,
    lang: o.lang,
    body: `<div class="top"><div><h1>${dash(latest.title)}</h1>` +
      `<p class="sub">${o.client ? `${t.clientIs(esc(o.client))} · ` : ''}${t.canvasIs(latest.canvas)} · v${latest.n}${
        o.pinned !== null ? ` · ${t.frozenAt(o.pinned)}` : ''
      }</p></div><span class="sp"></span>` +
      `<button class="btn warn" data-url="${api}" data-method="DELETE" data-go="/" data-confirm="${
        esc(t.deleteArtifactAsk(latest.title ?? '—'))
      }">${t.deleteArtifact}</button></div>` +
      `<h2>${t.versions}</h2>${versions}<h2>${t.shell.annotations}</h2>${annotations}<h2>${t.readers}</h2>${readers}`,
  });
}

/** The members page (spec §12): internal tokens only. The plaintext appears in one banner, once. */
function membersPage(publisher: Publisher, rows: TokenRow[], lang: Lang): string {
  const t = STRINGS[lang];
  return publisherPage({
    title: `${t.members} · MyArtifacts`,
    publisher,
    lang,
    body: `<h1>${t.members}</h1>
<div class="banner" id="banner" hidden><b>${t.newToken} · <span class="who"></span></b>
<code></code><button class="btn" data-copy="">${t.copy}</button>
<p class="sub">${t.onlyOnce}</p></div>
<div class="mk"><input id="mname" name="mname" placeholder="${t.memberName}" size="20">` +
      `<input id="mclient" name="mclient" placeholder="${t.clientOptional}" size="24"><button class="btn pri" id="mint">${t.mint}</button></div>` +
      `<table id="mtable"><tr><th>${t.name}</th><th>${t.client}</th><th>${t.created}</th><th></th></tr>${
        rows.map((r) => `<tr><td class="n">${esc(r.name)}</td><td class="n">${dash(r.client)}</td><td class="n">${when(r.created_at)}</td>` +
          `<td class="n"><button class="btn warn" data-url="/api/tokens/${encodeURIComponent(r.name)}" data-method="DELETE" data-confirm="${
            esc(t.pub.revokeTokenAsk(r.name))
          }">${t.pub.revoke}</button></td></tr>`).join('')
      }</table>`,
    // The new row is built here rather than reloaded, because a reload would take the banner
    // with it — and the banner is the only copy of the plaintext there will ever be.
    script: `
document.getElementById('mint').onclick=async()=>{
 const n=document.getElementById('mname'),c=document.getElementById('mclient'),name=n.value.trim(),client=c.value.trim();
 if(!name)return n.focus();
 const r=await fetch('/api/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(client?{name,client}:{name})});
 const out=await r.json();
 if(!r.ok)return alert(T.mintFailed(out.error&&out.error.message||r.status));
 const b=document.getElementById('banner');
 b.querySelector('.who').textContent=out.name+(out.client?' · '+out.client:'');
 b.querySelector('code').textContent=out.token;
 b.querySelector('[data-copy]').dataset.copy=out.token;
 b.hidden=false;
 const tr=document.getElementById('mtable').insertRow(-1);
 for(const t of [out.name,out.client||'—',new Date().toLocaleString()])tr.insertCell().textContent=t;
 const rb=document.createElement('button');rb.className='btn warn';rb.textContent=T.revoke;
 rb.dataset.url='/api/tokens/'+encodeURIComponent(out.name);rb.dataset.method='DELETE';
 rb.dataset.confirm=T.revokeTokenAsk(out.name);
 tr.insertCell().append(rb);
 n.value='';c.value='';n.focus();
};`,
  });
}
// --- the document store ------------------------------------------------------
//
// Claude's `db`, as far as the contract's default rules go (ADR-0010): one store per Artifact,
// JSON documents at slash-separated paths, last-writer-wins, no transactions. One RPC door
// rather than REST, because the Bridge's `call` is already `{method, args}` — so the body a
// page sends through the Shell and the body an agent sends with curl are the same body, and
// a path with a `/` in it never has to survive a URL.

type RpcBody = {
  method?: unknown; path?: unknown; collection?: unknown; data?: unknown;
  where?: unknown; orderBy?: unknown; limit?: unknown; holder?: unknown; ttlMs?: unknown;
};
type DbOut = Record<string, unknown>;
/** A contract `DbErrorCode`, as the page will read it. The HTTP status is only the envelope. */
const dbErr = (code: string, message: string): DbOut => ({ error: { code, message } });
const DB_STATUS: Record<string, number> = { invalid_argument: 400, quota_exceeded: 429, resource_exhausted: 429 };

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
/**
 * The contract's path grammar. A document path has an even number of segments and a collection
 * path an odd one — the rule the runtime throws a `TypeError` for, checked again here because
 * an agent's curl never went through the runtime.
 */
function badPath(path: unknown, odd: boolean): boolean {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 1000) return true;
  const segs = path.split('/');
  return segs.length > 16 || segs.length % 2 === (odd ? 0 : 1) ||
    segs.some((s) => !SEG.test(s) || s === '.' || s === '..');
}
/**
 * `me` is the caller, resolved after the grammar check and never before: a Publisher's id is
 * their token's name, which is free text and need not be a legal segment. The grammar is a
 * contract with whoever wrote the path, not a constraint on who is asking.
 */
const resolveMe = (path: string, me: string) => path.replace(/^data\/users\/me(?=\/|$)/, `data/users/${me}`);
/**
 * The one check, on every verb and on every row a query returns: another caller's subtree under
 * `data/users/` reads as absent and refuses writes — the Publisher's read included, which is
 * exactly what makes a sealed vote sealed. v1 has no custom rules; this is the contract default.
 */
function hidden(path: string, me: string): boolean {
  const s = path.split('/');
  return s[0] === 'data' && s[1] === 'users' && s.length >= 3 && s[2] !== me;
}
const collectionOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const idOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** A document body is a plain JSON object — not an array, not a scalar. */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * A deleted document keeps its row, with this as its body, so its version keeps climbing across
 * a delete and a recreate — a snapshot cache keyed on version would otherwise hand back the old
 * body for the new one. A body is always an object, which leaves the JSON literal `null` free to
 * mean "gone"; it reads as absent everywhere a body is read — the 5,000-document count included,
 * so deleting a document hands its place in the store back.
 */
const TOMBSTONE = 'null';
/**
 * A body's nesting, against the contract's 32 levels — the top-level object being the first. It is
 * checked on what arrived, before anything walks it: everything downstream here recurses, so the
 * 33rd level has to be refused rather than merged, stringified, or overflowed onto.
 */
function tooDeep(v: unknown, budget: number): boolean {
  const kids = Array.isArray(v) ? v : isObject(v) ? Object.values(v) : null;
  if (!kids) return false;
  return budget <= 0 || kids.some((k) => tooDeep(k, budget - 1));
}
/** 256 KiB of stored JSON, whichever verb assembled it — a merge is weighed after it merges. */
const tooBig = (json: string) => Buffer.byteLength(json) > DOC_BYTES;
/**
 * `update` semantics: nested objects merge recursively, everything else — arrays included — replaces.
 * Bounded by the depth check in front of it, which is what keeps the recursion off the stack limit.
 */
function merge(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(from)) {
    // `__proto__` survives `JSON.parse` as an ordinary key, but reading or assigning it here goes
    // through `Object.prototype`'s accessor — so merging one would write a caller's fields onto
    // every object in this process. A document is data; this is the one key that is not stored.
    if (k === '__proto__') continue;
    const was = into[k];
    into[k] = isObject(was) && isObject(v) ? merge(was, v) : v;
  }
  return into;
}
/** The contract's nine operators, over top-level fields, with no index behind them. */
const OPS: Record<string, (field: unknown, value: unknown) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => (a as number) < (b as number),
  '<=': (a, b) => (a as number) <= (b as number),
  '>': (a, b) => (a as number) > (b as number),
  '>=': (a, b) => (a as number) >= (b as number),
  in: (a, b) => (b as unknown[]).includes(a),
  'not-in': (a, b) => !(b as unknown[]).includes(a),
  'array-contains': (a, b) => Array.isArray(a) && a.includes(b),
};

// --- the server --------------------------------------------------------------

export async function start(cfg: Config): Promise<Running> {
  const db = openDb(cfg.dataDir);
  const listen = (server: Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject).listen(port, () => resolve((server.address() as { port: number }).port));
    });

  const q = {
    token: db.prepare('SELECT name, client FROM tokens WHERE hash = ? AND revoked_at IS NULL'),
    tokens: db.prepare('SELECT name, client, created_at FROM tokens WHERE revoked_at IS NULL ORDER BY created_at, name'),
    tokensd: db.prepare('SELECT name FROM tokens WHERE name = ?'),
    revokeToken: db.prepare('UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL'),
    version: db.prepare('SELECT n, canvas, title, published_by, created_at FROM versions WHERE artifact = ? AND n = ?'),
    insertArtifact: db.prepare('INSERT INTO artifacts (id, client, created_at) VALUES (?, ?, ?)'),
    insertVersion: db.prepare('INSERT INTO versions (artifact, n, canvas, title, published_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    versionsOf: db.prepare('SELECT n, canvas, title, published_by, created_at FROM versions WHERE artifact = ? ORDER BY n'),
    // The one gate every path that names an Artifact goes through: soft-deleted is absent,
    // and so is anything outside the caller's Client — a miss, never a 403 (ADR-0008).
    artifact: db.prepare('SELECT id, pinned, client FROM artifacts WHERE id = :id AND deleted_at IS NULL AND (:client IS NULL OR client = :client)'),
    latest: db.prepare('SELECT n, canvas, title, published_by, created_at FROM versions WHERE artifact = ? ORDER BY n DESC LIMIT 1'),
    setPinned: db.prepare('UPDATE artifacts SET pinned = ? WHERE id = ?'),
    softDelete: db.prepare('UPDATE artifacts SET deleted_at = ? WHERE id = ?'),
    liveReaders: db.prepare('SELECT COUNT(*) AS n FROM readers WHERE artifact = ? AND revoked_at IS NULL'),
    openAnnotations: db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE artifact = ? AND status = 'open'"),
    insertAnnotation: db.prepare(
      'INSERT INTO annotations (id, artifact, reader, version, anchor, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    // Chronological: the drawer sorts for display; the agent reads in the order things were said.
    annotationsOf: db.prepare(`${ANNOTATION_ROW} WHERE a.artifact = ? ORDER BY a.created_at, a.rowid`),
    annotation: db.prepare(`${ANNOTATION_ROW} WHERE a.id = ? AND a.artifact = ?`),
    // The Publisher reaches an Annotation by its id alone; which Artifact it belongs to is
    // what decides whether they may see it at all.
    annotationById: db.prepare(`${ANNOTATION_ROW} WHERE a.id = ?`),
    // The webhook's two context fields in one row: the Artifact's Client, and the title its
    // newest Version carries — the same title the gallery and `GET /api/artifacts/{id}` mean.
    announcement: db.prepare(`
      SELECT a.client AS client, v.title AS title FROM artifacts a
      JOIN versions v ON v.artifact = a.id AND v.n = (SELECT MAX(n) FROM versions WHERE artifact = a.id)
      WHERE a.id = ?
    `),
    setAnnotationStatus: db.prepare('UPDATE annotations SET status = ? WHERE id = ?'),
    deleteAnnotation: db.prepare('DELETE FROM annotations WHERE id = ?'),
    // The gallery is one row per live Artifact, its newest Version inlined. Ties on the
    // timestamp fall back to insertion order, so "most recently published" is never a coin toss.
    gallery: db.prepare(`
      SELECT a.id AS artifact, a.client AS client, a.pinned AS pinned, v.n AS latest, v.title AS title,
             v.created_at AS last_published_at, v.published_by AS last_published_by,
             (SELECT COUNT(*) FROM readers r WHERE r.artifact = a.id AND r.revoked_at IS NULL) AS readers,
             (SELECT COUNT(*) FROM annotations x WHERE x.artifact = a.id AND x.status = 'open') AS open_annotations
      FROM artifacts a
      JOIN versions v ON v.artifact = a.id AND v.n = (SELECT MAX(n) FROM versions WHERE artifact = a.id)
      WHERE a.deleted_at IS NULL AND (:client IS NULL OR a.client = :client)
      ORDER BY v.created_at DESC, v.rowid DESC
    `),
    insertReader: db.prepare('INSERT INTO readers (id, artifact, secret, name, created_at) VALUES (?, ?, ?, ?, ?)'),
    readers: db.prepare('SELECT id, name, secret, revoked_at, created_at FROM readers WHERE artifact = ? ORDER BY created_at, id'),
    reader: db.prepare(
      'SELECT r.id FROM readers r JOIN artifacts a ON a.id = r.artifact WHERE r.id = ? AND r.artifact = ? AND a.deleted_at IS NULL',
    ),
    revokeReader: db.prepare('UPDATE readers SET revoked_at = ? WHERE id = ? AND artifact = ? AND revoked_at IS NULL'),
    // A soft-deleted Artifact takes its links with it: the same dead end as a revoked one.
    readerBySecret: db.prepare(
      'SELECT r.id, r.artifact, r.name, a.pinned FROM readers r JOIN artifacts a ON a.id = r.artifact' +
        ' WHERE r.secret = ? AND r.revoked_at IS NULL AND a.deleted_at IS NULL',
    ),
  };

  const qdoc = {
    get: db.prepare('SELECT json, version, lease_holder, lease_until FROM docs WHERE artifact = ? AND path = ?'),
    put: db.prepare(`
      INSERT INTO docs (artifact, path, collection, json, version, updated_at, updated_by, lease_holder, lease_until)
      VALUES (:artifact, :path, :collection, :json, :version, :updated_at, :updated_by, :lease_holder, :lease_until)
      ON CONFLICT (artifact, path) DO UPDATE SET
        json = excluded.json, version = excluded.version, updated_at = excluded.updated_at,
        updated_by = excluded.updated_by, lease_holder = excluded.lease_holder, lease_until = excluded.lease_until
    `),
    inCollection: db.prepare(`SELECT path, json, version FROM docs WHERE artifact = ? AND collection = ? AND json != '${TOMBSTONE}'`),
    // Only on a create, and only over one Artifact's rows — of which there are at most 5,000.
    count: db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE artifact = ? AND json != '${TOMBSTONE}'`),
  };
  type DocRow = { json: string; version: number; lease_holder: string | null; lease_until: string | null };

  /**
   * The per-identity token bucket (spec §10). One identity is one Reader id or one token name:
   * `/api/tokens` refuses a name shaped like a Reader id, so the two namespaces stay apart —
   * the bootstrap token is minted by a hand on the machine and takes whatever it is given.
   * In the process and nowhere else: a restart is an amnesty, and a second process would
   * hand out a second allowance. That is the trade the spec asks for; a counter in SQLite would be
   * a round trip per call to enforce a limit nobody is paying to enforce exactly.
   * ponytail: no eviction. An entry is a number and a timestamp, and the identities are the
   * Readers and tokens already on disk — bounded by the same thing that bounds those tables. A box
   * with enough revoked links for that to matter drops entries that have refilled to full.
   */
  const perSecond = cfg.ratePerSecond ?? 20;
  const burst = cfg.rateBurst ?? 40;
  const buckets = new Map<string, { left: number; at: number }>();
  function spend(me: string, cost: number): boolean {
    const now = Date.now();
    const b = buckets.get(me) ?? { left: burst, at: now };
    b.left = Math.min(burst, b.left + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    buckets.set(me, b);
    if (b.left < cost) return false;
    b.left -= cost;
    return true;
  }

  // The stream (spec §10): every open `…/db/stream`, by Artifact, each remembering who is
  // listening so the private-subtree rule can be applied before an event leaves. Nothing is
  // stored and nothing replayed — a browser that reconnects re-runs its subscriptions instead.
  // ponytail: no cap on open streams per credential — and since ticket 11 every open view holds
  // one, subscriptions or not, because a Version landing has to reach a page that listens to no
  // document. A forwarded link can hold as many as it likes; the bucket below meters calls, not
  // sockets, and spec §10's table asks for nothing here.
  const streams = new Map<string, Set<{ res: ServerResponse; me: string }>>();
  /**
   * One frame to every open stream on the Artifact. A document write names a `path` and is filtered
   * by the private-subtree rule on the way out; the other kind — `{type: 'version', n}`, a Version
   * landed and every view follows it (spec §9) — names none and reaches everyone, because a Version
   * is nobody's private subtree and the view that published it is reloaded by it too.
   */
  function push(artifact: string, event: { path?: string } & Record<string, unknown>): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const s of streams.get(artifact) ?? []) if (event.path === undefined || !hidden(event.path, s.me)) s.res.write(line);
  }
  function openStream(res: ServerResponse, req: IncomingMessage, artifact: string, me: string): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(':ok\n\n');
    const s = { res, me };
    const set = streams.get(artifact) ?? new Set();
    streams.set(artifact, set.add(s));
    // A comment every 25 s keeps a proxy on the cross-border hop from calling the socket idle.
    const beat = setInterval(() => res.write(':\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); set.delete(s); if (!set.size) streams.delete(artifact); });
  }
  /**
   * A credential that just died takes its open streams with it — the socket is the one thing a
   * revoked link would otherwise keep. The browser reconnects into the 404 that tells its Shell.
   */
  function closeStreams(artifact: string, me?: string): void {
    for (const s of streams.get(artifact) ?? []) if (me === undefined || s.me === me) s.res.end();
  }

  /**
   * One write, one version, one event — unless told to keep quiet (a lease renewal). Last-writer-wins:
   * nothing here compares what it is overwriting. `row` is whatever is stored at the path, a
   * tombstone included: the version climbs from it either way.
   */
  function writeDoc(
    artifact: string, path: string, row: DocRow | undefined, me: string,
    next: { json: string; lease_holder?: string | null; lease_until?: string | null; quiet?: boolean },
  ): number {
    const version = (row?.version ?? 0) + 1;
    const updated_at = new Date().toISOString();
    qdoc.put.run({
      artifact, path, collection: collectionOf(path), json: next.json, version, updated_at, updated_by: me,
      // A plain `set` does not break someone's lease: only `acquire` moves it (the contract's
      // leases coordinate callers that use `acquire`, they are not a write barrier).
      lease_holder: next.lease_holder !== undefined ? next.lease_holder : row?.lease_holder ?? null,
      lease_until: next.lease_until !== undefined ? next.lease_until : row?.lease_until ?? null,
    });
    if (!next.quiet) push(artifact, { path, doc: JSON.parse(next.json) as unknown, version, updated_at });
    return version;
  }

  /**
   * A query: everything in the collection, then filters, order and page — scanned, with no
   * index behind any of it, exactly as the contract describes. A document missing the filtered
   * field matches nothing (`!=` included) and sorts last, which is Firestore's rule and the one
   * a page written against Claude will have been tested on.
   */
  function dbQuery(artifact: string, me: string, b: RpcBody): DbOut {
    if (badPath(b.collection, true)) return dbErr('invalid_argument', 'a collection path has an odd number of segments');
    const collection = resolveMe(b.collection as string, me);
    if (badPath(collection, true)) return dbErr('invalid_argument', 'this caller has no private subtree');
    const where = b.where ?? [];
    if (!Array.isArray(where) || where.length > 10) return dbErr('invalid_argument', 'at most ten filters');
    let rows = (qdoc.inCollection.all(artifact, collection) as { path: string; json: string; version: number }[])
      .filter((r) => !hidden(r.path, me))
      .map((r) => ({ id: idOf(r.path), path: r.path, data: JSON.parse(r.json) as Record<string, unknown>, version: r.version }));

    for (const clause of where) {
      if (!Array.isArray(clause) || clause.length !== 3) return dbErr('invalid_argument', 'a filter is [field, op, value]');
      const [field, op, value] = clause as [unknown, unknown, unknown];
      const test = typeof op === 'string' ? OPS[op] : undefined;
      if (typeof field !== 'string' || !test) return dbErr('invalid_argument', `unknown operator ${String(op)}`);
      if ((op === 'in' || op === 'not-in') && (!Array.isArray(value) || value.length > 30)) {
        return dbErr('invalid_argument', `${op} takes an array of at most 30 values`);
      }
      rows = rows.filter((r) => r.data[field] !== undefined && test(r.data[field], value));
    }

    if (b.orderBy !== undefined) {
      if (!Array.isArray(b.orderBy) || typeof b.orderBy[0] !== 'string') return dbErr('invalid_argument', 'orderBy is [field, dir]');
      const [field, dir] = b.orderBy as [string, string?];
      const sign = dir === 'desc' ? -1 : 1;
      rows.sort((x, y) => {
        const xv = x.data[field], yv = y.data[field];
        if (xv === undefined || yv === undefined) return xv === yv ? 0 : xv === undefined ? 1 : -1;
        // JSON values order the way `<` orders them; the cast is for the type checker alone.
        const less = (l: unknown, r: unknown) => (l as number) < (r as number);
        return (less(xv, yv) ? -1 : less(yv, xv) ? 1 : 0) * sign;
      });
    } else {
      // Without `orderBy`, document id ascending — the same on every delivery path.
      rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    }

    if (b.limit !== undefined) {
      if (!Number.isInteger(b.limit) || (b.limit as number) < 1 || (b.limit as number) > 1000) {
        return dbErr('invalid_argument', 'limit is 1–1000');
      }
      rows = rows.slice(0, b.limit as number);
    }
    return { docs: rows };
  }

  /**
   * The RPC door's whole body. `add` and an id-less `doc()` never arrive here — the runtime
   * mints the id and sends a `set` — so this is the contract's six verbs and nothing else.
   */
  function dbRpc(artifact: string, me: string, body: unknown): DbOut {
    const b = (isObject(body) ? body : {}) as RpcBody;
    // Every verb costs the same one token, read or write: the scan behind a query is the
    // expensive one, and it is the caller's rate we are metering, not their intent.
    if (!spend(me, 1)) return dbErr('resource_exhausted', 'too many calls; slow down');
    if (b.method === 'query') return dbQuery(artifact, me, b);
    if (b.method !== 'get' && b.method !== 'set' && b.method !== 'update' && b.method !== 'delete' && b.method !== 'acquire') {
      return dbErr('capability_removed', `db.${String(b.method)} is not part of this runtime`);
    }
    if (badPath(b.path, false)) return dbErr('invalid_argument', 'a document path has an even number of segments');
    const path = resolveMe(b.path as string, me);
    // Again after the splice: a caller whose id is not one legal segment has no subtree to own.
    if (badPath(path, false)) return dbErr('invalid_argument', 'this caller has no private subtree');
    const row = qdoc.get.get(artifact, path) as DocRow | undefined;
    // What is there, as far as a body goes: a tombstone is a version to climb from, not a document.
    const was = row && row.json !== TOMBSTONE ? row : undefined;
    // Someone else's private subtree: absent on a read, refused on a write. There is deliberately
    // no permission-denied code — a document you cannot see is one that does not exist.
    if (b.method === 'get') {
      return was && !hidden(path, me) ? { exists: true, data: JSON.parse(was.json) as unknown, version: was.version } : { exists: false };
    }
    if (hidden(path, me)) return dbErr('invalid_argument', 'not your subtree');
    // Before anything walks the body: merging, stringifying and weighing all recurse through it.
    if (tooDeep(b.data, DOC_DEPTH)) return dbErr('invalid_argument', 'a document nests at most 32 levels');
    // The store's cap is a cap on creating a document. Rewriting one already there is free, and a
    // tombstone is a row rather than a document, so deleting one hands its place back.
    if (!was && (b.method === 'set' || b.method === 'acquire') &&
        (qdoc.count.get(artifact) as { n: number }).n >= DOCS_PER_ARTIFACT) {
      return dbErr('quota_exceeded', 'at most 5,000 documents per artifact');
    }

    if (b.method === 'delete') {
      // Idempotent, and it does not cascade: documents nested under this path survive. A
      // listener's last snapshot carried the body; the event this writes says it is gone.
      if (was) writeDoc(artifact, path, row, me, { json: TOMBSTONE, lease_holder: null, lease_until: null });
      return {};
    }
    if (b.method === 'acquire') {
      if (typeof b.holder !== 'string' || !b.holder) return dbErr('invalid_argument', 'holder is required');
      if (b.data !== undefined && !isObject(b.data)) return dbErr('invalid_argument', 'a document body is a JSON object');
      const now = new Date();
      const held = !!was?.lease_until && was.lease_until > now.toISOString();
      // Held by someone else and not yet lapsed: a normal outcome, and it names when, never who.
      if (held && was!.lease_holder !== b.holder) return { acquired: false, expiresAt: was!.lease_until! };
      const ttl = Math.min(600000, Math.max(1000, Number(b.ttlMs) || 30000));
      const expiresAt = new Date(now.getTime() + ttl).toISOString();
      // `data` merges on the grant, which is why the contract says not to carry a claim in it.
      const json = JSON.stringify(merge(was ? (JSON.parse(was.json) as Record<string, unknown>) : {}, b.data ?? {}));
      if (tooBig(json)) return dbErr('invalid_argument', 'a document is at most 256 KiB');
      // The editor renewing every few seconds is not news to anyone watching the document:
      // only a first grant, or a body carried along, goes out on the stream.
      const quiet = held && Object.keys(b.data ?? {}).length === 0;
      const version = writeDoc(artifact, path, row, me, { json, lease_holder: b.holder, lease_until: expiresAt, quiet });
      return { acquired: true, version, expiresAt, holder: b.holder };
    }
    if (!isObject(b.data)) return dbErr('invalid_argument', 'a document body is a JSON object');
    // `set` replaces the whole document; `update` merges and refuses to create one, because
    // creating-on-miss would be a bug for the cases it exists for.
    if (b.method === 'update' && !was) return dbErr('invalid_argument', 'update requires an existing document');
    const json = JSON.stringify(b.method === 'set' ? b.data : merge(JSON.parse(was!.json) as Record<string, unknown>, b.data));
    if (tooBig(json)) return dbErr('invalid_argument', 'a document is at most 256 KiB');
    writeDoc(artifact, path, row, me, { json });
    return {};
  }

  /** The contract's code is the answer; the status is the envelope it travels in (spec §10). */
  function dbAnswer(res: ServerResponse, out: DbOut): void {
    const e = out['error'] as { code: string; message: string } | undefined;
    if (e) return fail(res, DB_STATUS[e.code] ?? 400, e.code, e.message);
    return json(res, 200, out);
  }

  /** The caller, or null with the 401 already sent. Every `/api/*` route starts here. */
  /**
   * Who is holding this request's credential — the one lookup, so a Bearer header and the
   * browser's cookie are the same fact and a revoked token dies in both at once (spec §3).
   * Only how a stranger is turned away differs, and that belongs to the caller.
   */
  const holderOf = (req: IncomingMessage): Publisher | null => {
    const token = presentedToken(req);
    return token ? (q.token.get(hashOf(token)) as Publisher | undefined) ?? null : null;
  };
  const publisherOf = (req: IncomingMessage, res: ServerResponse): Publisher | null => {
    const p = holderOf(req);
    if (!p) fail(res, 401, 'unauthorized', 'a publisher token is required');
    return p;
  };
  /** One of our own pages: no cookie, or one whose token is gone, and a browser wants `/login` — not a 401 to read. */
  const publisherOrLogin = (req: IncomingMessage, res: ServerResponse): Publisher | null => {
    const p = holderOf(req);
    if (!p) redirect(res, '/login');
    return p;
  };
  /** The Artifact as the caller is allowed to see it. */
  const artifactFor = (id: string, p: Publisher) => q.artifact.get({ id, client: p.client }) as ArtifactRow | undefined;

  const shell = createServer((req, res) => void handleShell(req, res).catch(() => {
    // A throw after the head has gone out cannot be answered, only cut; and a throw from inside this
    // handler would be an unhandled rejection, which takes the one process there is down with it.
    if (res.headersSent) res.destroy(); else fail(res, 500, 'internal', 'unhandled');
  }));
  const usercontent = createServer((req, res) => void handleUsercontent(req, res));

  const shellPort = await listen(shell, cfg.shellPort ?? 8787);
  const usercontentPort = await listen(usercontent, cfg.usercontentPort ?? 8788);

  const shellOrigin = cfg.shellOrigin ?? `http://localhost:${shellPort}`;
  const usercontentHost = (cfg.usercontentHost ?? `usercontent.localhost:${usercontentPort}`).toLowerCase();
  const scheme = new URL(shellOrigin).protocol;
  // In production the Shell is behind TLS and the session cookie says so; on a loopback origin
  // `Secure` would mean the browser never sends it back, so local development would have no login.
  const cookieSecure = scheme === 'https:';
  const usercontentOrigin = (artifact: string) => `${scheme}//${artifact}.${usercontentHost}`;
  const runtime = RUNTIME_SRC.replace('__SHELL_ORIGIN__', scriptJson(shellOrigin));
  const readerUrl = (secret: string) => `${shellOrigin}/r/${secret}`;
  /** The list item, one shape for Reader, Publisher and webhook (spec §11); `reader` is a name, never an id. */
  const annotationItem = (a: AnnotationRow, me?: string) => ({
    annotation: a.id, reader: a.name, version: a.version, anchor: JSON.parse(a.anchor) as Anchor,
    text: a.text, status: a.status, created_at: a.created_at, ...(me === undefined ? {} : { mine: a.reader === me }),
  });

  /**
   * The one event there is: a Reader pinned a new Annotation (spec §11). A withdrawal, a flip
   * either side — none of them announce; this is a nudge to go read the list, not an event feed.
   * Fire-and-forget by design: the Reader's 201 is already out, and the URL is the only secret
   * there is, so nothing is signed, queued or tried twice.
   */
  function announce(a: AnnotationRow): void {
    if (!cfg.webhookUrl) return;
    // An Annotation cannot be pinned except on a live Artifact with a Version to pin it on.
    const about = q.announcement.get(a.artifact) as { client: string | null; title: string | null };
    const body = {
      // The spread also lays the fields out in §11's order: the list item, then its four contexts.
      ...annotationItem(a),
      artifact: a.artifact,
      title: about.title,
      client: about.client,
      // The Publisher's view of the Version it was pinned on, scrolled to it — behind a cookie.
      // Never a Reader link: that one is the credential.
      url: `${shellOrigin}/a/${a.artifact}/v/${a.version}#${a.id}`,
    };
    fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => {
        // Nothing here reads the answer; letting go of the body frees the socket.
        void r.body?.cancel();
        if (!r.ok) console.error(`webhook ${a.id}: HTTP ${r.status}`);
      })
      // undici keeps the real reason — refused, DNS, timed out — one level down in `cause`.
      .catch((e: { message?: string; cause?: { message?: string } }) => console.error(`webhook ${a.id}: ${e.cause?.message ?? e.message}`));
  }

  /** The bytes of one immutable Version, on disk. Always written before a row names them. */
  function writeVersion(artifact: string, n: number, body: Buffer): void {
    mkdirSync(dirname(versionPath(cfg.dataDir, artifact, n)), { recursive: true });
    writeFileSync(versionPath(cfg.dataDir, artifact, n), body);
  }

  /** Records a Version already on disk, and answers in the publish shape. `by` is a token's name or a Reader's. */
  function mint(res: ServerResponse, artifact: string, n: number, { canvas, title }: Accepted, by: string): void {
    q.insertVersion.run(artifact, n, canvas, title, by, new Date().toISOString());
    json(res, 201, { artifact, version: n, canvas, title, preview: `${shellOrigin}/a/${artifact}/v/${n}` });
  }

  /**
   * Every Version after the first, from either mount. `?base=N` is the whole of what makes one a
   * page's own publish (spec §9): only a view knows which Version it is running, so its presence
   * says a page is calling — compare-and-set against that Version, its Canvas inherited, and a
   * freeze refusing it outright, which is what lets a Publisher keep revising while the Reader
   * holds still. An agent sends none of it and is refused for none of it.
   *
   * `by` is the name a Publisher reads on the Version; `me` is the identity the bucket is kept
   * under, which for a Reader is the opaque id and not the name two links may share (spec §10).
   * ponytail: the body has already been read by the time this refuses a page — every route reads
   * first, because an unread one poisons a keep-alive connection, and a 16 MiB read is the price.
   * Refusing before the read means answering and closing the connection; worth it only if someone
   * is actually pushing bodies at a door they have no budget for.
   */
  function publishVersion(
    req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer | null,
    o: { artifact: string; pinned: number | null; by: string; me: string },
  ): void {
    const latest = q.latest.get(o.artifact) as VersionRow;
    const base = url.searchParams.get('base');
    if (base !== null) {
      if (o.pinned !== null) return fail(res, 423, 'not_writer', 'this artifact is frozen');
      // `live` is the contract's field on a conflict: the Version the losing view is reloaded to.
      if (Number(base) !== latest.n) {
        return json(res, 409, { error: { code: 'conflict', message: 'a newer version is live' }, live: String(latest.n) });
      }
      // A page's publish is ten calls out of the same bucket its db calls come from: a view in a
      // loop is what this is for, and a Version costs the box far more than a document does.
      // Last of the three, so that a freeze and a lost race — neither of them the caller going too
      // fast, and both of which a page meets normally — are refused for what they are and cost
      // nothing. Only a publish that was going to mint pays.
      if (!spend(o.me, 10)) return fail(res, 429, 'rate_limited', 'too many publishes; slow down');
    }
    const accepted = accept(res, url, req, body, base === null ? undefined : latest.canvas);
    if (!accepted) return;
    const n = latest.n + 1;
    writeVersion(o.artifact, n, accepted.body);
    mint(res, o.artifact, n, accepted, o.by);
    // A live Artifact's views follow the newest Version (ADR-0009); a frozen one hears nothing,
    // which is also why a freeze made after a page loaded reaches nobody until they publish.
    if (o.pinned === null) push(o.artifact, { type: 'version', n });
  }

  async function handleShell(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', shellOrigin);
    // Decided once, for whichever page this turns out to be; the API never reads it.
    const lang = langOf(url, req);

    // Tokens are minted and revoked by internal tokens only; a Client token gets a 403 on all
    // three, its own name included — there is nothing here it is allowed to know (ADR-0008).
    // A name is whatever was minted, so it arrives percent-encoded; a malformed escape is a miss.
    const tokens = /^\/api\/tokens(?:\/([^/]+))?$/.exec(url.pathname);
    if (tokens && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      if (publisher.client !== null) return fail(res, 403, 'forbidden', 'only an internal token can manage tokens');

      if (tokens[1] === undefined && req.method === 'GET') return json(res, 200, q.tokens.all());
      if (tokens[1] === undefined && req.method === 'POST') {
        const { name, client = null } = (parseJson(body) ?? {}) as { name?: unknown; client?: unknown };
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed || [...trimmed].length > 100) return fail(res, 400, 'invalid_argument', 'name must be 1–100 characters');
        if (client !== null && !isClient(client)) return badClient(res);
        if (looksLikeReaderId(trimmed)) return fail(res, 400, 'invalid_argument', 'name must not be shaped like a reader id');
        // A revoked name stays taken: `published_by` keeps pointing at whoever it was.
        if (q.tokensd.get(trimmed)) return fail(res, 409, 'conflict', 'that name is taken');
        return json(res, 201, { name: trimmed, client, token: insertToken(db, trimmed, client) });
      }
      if (tokens[1] !== undefined && req.method === 'DELETE') {
        // Revoking yourself is not a special case (spec §12, the members page): the row stays, the token is dead.
        let name: string;
        try { name = decodeURIComponent(tokens[1]); } catch { return notFound(res); }
        if (q.revokeToken.run(new Date().toISOString(), name).changes === 0) return notFound(res);
        for (const artifact of streams.keys()) closeStreams(artifact, name);
        res.writeHead(204);
        return void res.end();
      }
      return notFound(res);
    }

    if (url.pathname === '/api/artifacts' && (req.method === 'POST' || req.method === 'GET')) {
      // Read before checking anything: an unread body poisons a keep-alive connection.
      // ponytail: that also means an anonymous caller can make us read 16 MiB. The bucket is
      // per identity and there is no identity yet here, so the answer is a reverse proxy in
      // front rather than a second kind of limit behind.
      const body = req.method === 'POST' ? await readBody(req) : null;
      const publisher = publisherOf(req, res);
      if (!publisher) return;

      if (req.method === 'GET') {
        return json(res, 200, (q.gallery.all({ client: publisher.client }) as GalleryRow[]).map((r) => ({
          artifact: r.artifact,
          title: r.title,
          client: r.client,
          pinned: r.pinned,
          latest: r.latest,
          open_annotations: r.open_annotations,
          readers: r.readers,
          last_published_at: r.last_published_at,
          last_published_by: r.last_published_by,
        })));
      }

      const accepted = accept(res, url, req, body);
      if (!accepted) return;
      // Where the Artifact lives, for life: a Client token's own Client, or wherever an internal
      // token points `?client=` — nowhere, by default, which only internal tokens can see.
      const asked = url.searchParams.get('client');
      if (asked !== null && !isClient(asked)) return badClient(res);
      if (publisher.client !== null && asked !== null && asked !== publisher.client) return fail(res, 400, 'invalid_argument', 'a client token publishes into its own client');
      const client = publisher.client ?? asked;
      const artifact = randomBytes(16).toString('hex');
      // Bytes first, rows after: a write that fails must not leave an Artifact behind with no
      // Version to open. Everything downstream — the gallery, the Reader's link, ADR-0009's
      // "latest" — assumes an Artifact has at least a v1, because it is created with one.
      writeVersion(artifact, 1, accepted.body);
      q.insertArtifact.run(artifact, client, new Date().toISOString());
      return mint(res, artifact, 1, accepted, publisher.name);
    }

    const detail = new RegExp(`^/api/artifacts/(${ID})$`).exec(url.pathname);
    if (detail?.[1] && (req.method === 'GET' || req.method === 'DELETE')) {
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      const artifact = detail[1];
      const row = artifactFor(artifact, publisher);
      if (!row) return notFound(res);

      if (req.method === 'DELETE') {
        // One column, one direction. Versions, Readers, Annotations and the files on disk are
        // left exactly as they are; the way back is a hand on the machine, not an endpoint.
        q.softDelete.run(new Date().toISOString(), artifact);
        closeStreams(artifact);
        res.writeHead(204);
        return void res.end();
      }

      const history = q.versionsOf.all(artifact) as VersionRow[];
      return json(res, 200, {
        artifact,
        title: history.at(-1)?.title ?? null,
        client: row.client,
        pinned: row.pinned,
        versions: history.map((v) => ({
          version: v.n, canvas: v.canvas, title: v.title, published_by: v.published_by, created_at: v.created_at,
        })),
        readers: (q.liveReaders.get(artifact) as { n: number }).n,
        open_annotations: (q.openAnnotations.get(artifact) as { n: number }).n,
      });
    }

    const versions = new RegExp(`^/api/artifacts/(${ID})/versions$`).exec(url.pathname);
    if (req.method === 'POST' && versions?.[1]) {
      const body = await readBody(req);
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      const row = artifactFor(versions[1], publisher);
      if (!row) return notFound(res);
      // An agent and a Publisher's own preview publish through the same door; `?base=` is what
      // says which one is calling, because only a page has a Version it is running.
      return publishVersion(req, res, url, body, { artifact: row.id, pinned: row.pinned, by: publisher.name, me: publisher.name });
    }

    const pinned = new RegExp(`^/api/artifacts/(${ID})/pinned$`).exec(url.pathname);
    if (req.method === 'PUT' && pinned?.[1]) {
      const body = await readBody(req);
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      const artifact = pinned[1];
      if (!artifactFor(artifact, publisher)) return notFound(res);
      const { version } = (parseJson(body) ?? {}) as { version?: unknown };
      // The freeze points at a Version that exists — any of them, including one further back.
      // Clearing it is `null` and only `null`: a missing key is a malformed call, not a thaw.
      const exists = Number.isInteger(version) && q.version.get(artifact, version as number);
      if (version !== null && !exists) return fail(res, 400, 'invalid_argument', 'version must be an existing version, or null');
      q.setPinned.run(version as number | null, artifact);
      return json(res, 200, { pinned: (version ?? null) as number | null });
    }

    // The RPC door, Publisher side: an agent's curl, and the Shell's own fetch when a Publisher
    // is previewing a Version. Same body, same store, same private subtrees as the Reader's.
    const publisherDb = new RegExp(`^/api/artifacts/(${ID})/db(/stream)?$`).exec(url.pathname);
    if (publisherDb?.[1] && (publisherDb[2] ? req.method === 'GET' : req.method === 'POST')) {
      const body = publisherDb[2] ? null : await readBody(req);
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      if (!artifactFor(publisherDb[1], publisher)) return notFound(res);
      if (publisherDb[2]) return openStream(res, req, publisherDb[1], publisher.name);
      return dbAnswer(res, dbRpc(publisherDb[1], publisher.name, parseJson(body)));
    }

    const preview = new RegExp(`^/a/(${ID})/v/(\\d+)$`).exec(url.pathname);
    if (req.method === 'GET' && preview?.[1] && preview[2]) {
      const publisher = publisherOrLogin(req, res);
      if (!publisher) return;
      const artifact = preview[1];
      const n = Number(preview[2]);
      const art = artifactFor(artifact, publisher);
      const row = art && (q.version.get(artifact, n) as VersionRow | undefined);
      // The webhook's link outlives the Artifact; a person following it gets the way back, not JSON.
      if (!art || !row) return sendHtml(res, 404, missingPage(publisher, lang));
      return sendHtml(res, 200, shellPage({
        n, canvas: row.canvas, title: row.title, artifactOrigin: usercontentOrigin(artifact),
        who: publisher.name, me: { id: publisher.name, canEdit: true, isOwner: true },
        api: `${shellOrigin}/api/artifacts/${artifact}/annotations`,
        mount: `${shellOrigin}/api/artifacts/${artifact}`, versionUrl: `${shellOrigin}/a/${artifact}/v/`, lang,
        preview: { artifact, pinned: art.pinned, latest: (q.latest.get(artifact) as VersionRow).n },
      }));
    }

    const readers = new RegExp(`^/api/artifacts/(${ID})/readers$`).exec(url.pathname);
    if (readers?.[1] && (req.method === 'POST' || req.method === 'GET')) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      const artifact = readers[1];
      if (!artifactFor(artifact, publisher)) return notFound(res);

      if (req.method === 'GET') {
        const rows = q.readers.all(artifact) as ReaderRow[];
        return json(res, 200, rows.map((r) => ({
          reader: r.id, name: r.name, url: readerUrl(r.secret),
          revoked: r.revoked_at !== null, created_at: r.created_at,
        })));
      }

      const { name } = (parseJson(body) ?? {}) as { name?: unknown };
      const trimmed = typeof name === 'string' ? name.trim() : '';
      // ponytail: 100 is a header-width cap, not a spec number — but the name is publisher input
      // rendered into our own origin's chrome, so it gets a bound rather than none.
      if (!trimmed || [...trimmed].length > 100) return fail(res, 400, 'invalid_argument', 'name must be 1–100 characters');

      // The URL is the whole credential (ADR-0002): 32 bytes, and the only copy we can hand out
      // is this response — after that it lives in someone's WeChat thread, not in our database.
      const id = randomBytes(16).toString('hex');
      const secret = randomBytes(32).toString('base64url');
      q.insertReader.run(id, artifact, secret, trimmed, new Date().toISOString());
      return json(res, 201, { reader: id, name: trimmed, url: readerUrl(secret) });
    }

    const revoke = new RegExp(`^/api/artifacts/(${ID})/readers/(${ID})$`).exec(url.pathname);
    if (req.method === 'DELETE' && revoke?.[1] && revoke[2]) {
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      // A Reader belongs to one Artifact, so the pair has to match — asking under the wrong
      // Artifact is a miss, not a revocation.
      if (!artifactFor(revoke[1], publisher) || !q.reader.get(revoke[2], revoke[1])) return notFound(res);
      q.revokeReader.run(new Date().toISOString(), revoke[2], revoke[1]);
      closeStreams(revoke[1], revoke[2]);
      res.writeHead(204);
      return void res.end();
    }

    // The Publisher's half: read what came back, and mark what has been dealt with. Creating one
    // and withdrawing one belong to the Reader alone (spec §4) — those fall through to a miss.
    const annotations = new RegExp(`^/api/artifacts/(${ID})/annotations$`).exec(url.pathname);
    if (req.method === 'GET' && annotations?.[1]) {
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      const artifact = annotations[1];
      if (!artifactFor(artifact, publisher)) return notFound(res);
      const want = url.searchParams.get('status');
      // A typo silently listing everything is worse than a refusal.
      if (want !== null && !isStatus(want)) return badStatus(res);
      const rows = (q.annotationsOf.all(artifact) as AnnotationRow[]).filter((a) => want === null || a.status === want);
      return json(res, 200, rows.map((a) => annotationItem(a)));
    }

    const flip = new RegExp(`^/api/annotations/(${ID})$`).exec(url.pathname);
    if (req.method === 'PATCH' && flip?.[1]) {
      const body = await readBody(req);
      const publisher = publisherOf(req, res);
      if (!publisher) return;
      const a = q.annotationById.get(flip[1]) as AnnotationRow | undefined;
      // Reached through its Artifact: another Client's, or a soft-deleted one, is simply absent.
      if (!a || !artifactFor(a.artifact, publisher)) return notFound(res);
      const { status } = (parseJson(body) ?? {}) as { status?: unknown };
      if (!isStatus(status)) return badStatus(res);
      // Both ways: an Annotation reopens as easily as it closes, and neither announces.
      q.setAnnotationStatus.run(status, a.id);
      return json(res, 200, annotationItem({ ...a, status }));
    }

    // The RPC door, Reader side. The link is the credential and the identity both: `me` in a
    // path is this Reader, and a forwarded link therefore shares one private subtree (ADR-0002).
    const readerDb = /^\/r\/([A-Za-z0-9_-]{43,})\/db(\/stream)?$/.exec(url.pathname);
    if (readerDb?.[1] && (readerDb[2] ? req.method === 'GET' : req.method === 'POST')) {
      const body = readerDb[2] ? null : await readBody(req);
      const reader = q.readerBySecret.get(readerDb[1]) as { id: string; artifact: string } | undefined;
      if (!reader) return notFound(res);
      if (readerDb[2]) return openStream(res, req, reader.artifact, reader.id);
      return dbAnswer(res, dbRpc(reader.artifact, reader.id, parseJson(body)));
    }

    // The Reader's own publish door: where `artifact.publish` lands when the page is open on a link
    // (spec §5). Nothing but a page reaches it, so the Version being written against is not optional
    // here — a link that has leaked cannot blind-overwrite whatever is live.
    const readerVersions = /^\/r\/([A-Za-z0-9_-]{43,})\/versions$/.exec(url.pathname);
    if (req.method === 'POST' && readerVersions?.[1]) {
      const body = await readBody(req);
      const reader = q.readerBySecret.get(readerVersions[1]) as LiveReader | undefined;
      if (!reader) return notFound(res);
      if (!url.searchParams.has('base')) return fail(res, 400, 'invalid_argument', 'a page publishes against the version it is running: ?base=N');
      // The name, not the id: `published_by` is read by a Publisher, and it is who wrote it.
      return publishVersion(req, res, url, body, { artifact: reader.artifact, pinned: reader.pinned, by: reader.name, me: reader.id });
    }

    // A Reader's Annotations: pin, list, and — on their own only — flip status and withdraw.
    // The link is the credential here too, so a revoked one is a miss on all four (ADR-0002).
    const ann = new RegExp(`^/r/([A-Za-z0-9_-]{43,})/annotations(?:/(${ID}))?$`).exec(url.pathname);
    if (ann?.[1]) {
      // Read before checking the secret, as everywhere else: an unread body poisons a keep-alive connection.
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : null;
      const reader = q.readerBySecret.get(ann[1]) as { id: string; artifact: string } | undefined;
      if (!reader) return notFound(res);

      if (ann[2] === undefined && req.method === 'GET') {
        return json(res, 200, (q.annotationsOf.all(reader.artifact) as AnnotationRow[]).map((a) => annotationItem(a, reader.id)));
      }
      if (ann[2] === undefined && req.method === 'POST') {
        const parsed = parseAnnotation(body);
        if (typeof parsed === 'string') return fail(res, 400, 'invalid_argument', parsed);
        // Pinned on a Version of this Artifact — normally the one on screen, but any that exists.
        if (!q.version.get(reader.artifact, parsed.version)) return fail(res, 400, 'invalid_argument', 'version must be an existing version');
        const id = randomBytes(16).toString('hex');
        q.insertAnnotation.run(id, reader.artifact, reader.id, parsed.version, JSON.stringify(parsed.anchor), parsed.text, new Date().toISOString());
        const row = q.annotation.get(id, reader.artifact) as AnnotationRow;
        json(res, 201, annotationItem(row, reader.id));
        // Row first, Reader second, receiver last: a slow or dead one is nobody's wait but its own.
        return announce(row);
      }
      if (ann[2] !== undefined && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const a = q.annotation.get(ann[2], reader.artifact) as AnnotationRow | undefined;
        if (!a) return notFound(res);
        // Everyone on the link sees it; only its author moves it. Not a miss: it is in the list they just read.
        if (a.reader !== reader.id) return fail(res, 403, 'forbidden', 'not your annotation');
        if (req.method === 'PATCH') {
          const { status } = (parseJson(body) ?? {}) as { status?: unknown };
          if (!isStatus(status)) return badStatus(res);
          q.setAnnotationStatus.run(status, a.id);
          return json(res, 200, annotationItem({ ...a, status }, reader.id));
        }
        // Withdrawing is for something not yet answered; once addressed it is part of the record (CONTEXT.md).
        if (a.status !== 'open') return fail(res, 409, 'conflict', 'an addressed annotation stays');
        q.deleteAnnotation.run(a.id);
        res.writeHead(204);
        return void res.end();
      }
      return notFound(res);
    }

    // The Reader's whole session: a secret in a URL. Revoked and never-issued look identical.
    const link = /^\/r\/([A-Za-z0-9_-]{43,})$/.exec(url.pathname);
    if (req.method === 'GET' && link?.[1]) {
      const reader = q.readerBySecret.get(link[1]) as LiveReader | undefined;
      // What a Reader sees: the frozen Version if there is one, otherwise the newest (ADR-0009).
      const row = reader &&
        ((reader.pinned === null ? q.latest.get(reader.artifact) : q.version.get(reader.artifact, reader.pinned)) as VersionRow | undefined);
      if (!reader || !row) return sendHtml(res, 404, deadPage(lang));
      return sendHtml(res, 200, shellPage({
        n: row.n, canvas: row.canvas, title: row.title,
        artifactOrigin: usercontentOrigin(reader.artifact),
        // The name is the header's; the bridge only ever learns the opaque id (spec §9).
        who: reader.name, me: { id: reader.id, canEdit: true, isOwner: false },
        api: `${readerUrl(link[1])}/annotations`,
        mount: readerUrl(link[1]), versionUrl: null, lang,
      }));
    }

    // The Publisher's own pages (spec §12). A token is pasted once here and becomes the cookie
    // every route above already accepts; nothing on these pages mutates anything except by
    // calling those same endpoints back with it.
    // The one route that answers without knowing who is asking: an agent reads the skill to learn
    // that a token is required at all, so demanding one here would close the loop. The file names
    // no host and holds no secret, which is what makes handing it out verbatim safe (spec §13).
    if (url.pathname === '/skill.md' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return void res.end(SKILL_SRC);
    }

    if (url.pathname === '/login' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      if (req.method === 'GET') return sendHtml(res, 200, loginPage(lang));
      const pasted = (new URLSearchParams(body?.toString('utf8') ?? '').get('token') ?? '').trim();
      // Wrong, or revoked since it was pasted — the same answer, because they are the same fact.
      if (!pasted || !q.token.get(hashOf(pasted))) return sendHtml(res, 401, loginPage(lang, true));
      return redirect(res, '/', cookieHeader(pasted, cookieSecure));
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      return redirect(res, '/login', cookieHeader(null, cookieSecure));
    }

    if (url.pathname === '/' && req.method === 'GET') {
      const publisher = publisherOrLogin(req, res);
      if (!publisher) return;
      return sendHtml(res, 200, galleryPage(publisher, q.gallery.all({ client: publisher.client }) as GalleryRow[], lang));
    }

    if (url.pathname === '/members' && req.method === 'GET') {
      const publisher = publisherOrLogin(req, res);
      if (!publisher) return;
      // A Client token has no navigation item for this page; typing the address is the same 403
      // `/api/tokens` gives it, because there is nothing here it is allowed to know (ADR-0008).
      if (publisher.client !== null) {
        const t = STRINGS[lang];
        return sendHtml(res, 403, publisherPage({ title: `${t.members} · MyArtifacts`, publisher, lang, body: `<p class="empty">${t.membersInternalOnly}</p>` }));
      }
      return sendHtml(res, 200, membersPage(publisher, q.tokens.all() as TokenRow[], lang));
    }

    const detailPage = new RegExp(`^/a/(${ID})$`).exec(url.pathname);
    if (req.method === 'GET' && detailPage?.[1]) {
      const publisher = publisherOrLogin(req, res);
      if (!publisher) return;
      const row = artifactFor(detailPage[1], publisher);
      if (!row) return sendHtml(res, 404, missingPage(publisher, lang));
      const want = url.searchParams.get('status');
      return sendHtml(res, 200, artifactPage({
        publisher, artifact: row.id, client: row.client, pinned: row.pinned,
        versions: q.versionsOf.all(row.id) as VersionRow[],
        annotations: q.annotationsOf.all(row.id) as AnnotationRow[],
        readers: q.readers.all(row.id) as ReaderRow[],
        readerUrl,
        // Through the same guard the API uses, but a typo in the address bar lands on the
        // default view rather than the API's 400: nobody reads a URL bar for a list they can see.
        want: isStatus(want) ? want : 'open',
        lang,
      }));
    }

    // Nothing matched. Drain anything the caller sent before answering, for the same reason
    // every route above reads first: an unread body poisons a keep-alive connection.
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') await readBody(req);
    return notFound(res);
  }

  // Inert: no directive here can carry a byte off the box. `connect-src` is absent on
  // purpose and falls back to `default-src 'none'`; `form-action` and `base-uri` have no
  // such fallback, so they are spelled out.
  const artifactHeaders = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${shellOrigin}`,
    ].join('; '),
  };

  // Artifact bytes, and only Artifact bytes. Which Artifact is a property of the origin.
  // Even a miss answers under the same headers, and never in the API's voice.
  function handleUsercontent(req: IncomingMessage, res: ServerResponse): void {
    const miss = () => {
      res.writeHead(404, { ...artifactHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    };
    const suffix = `.${usercontentHost}`;
    const host = (req.headers.host ?? '').toLowerCase();
    const artifact = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
    const path = /^\/v\/(\d+)$/.exec(req.url ?? '');
    if (req.method !== 'GET' || !new RegExp(`^${ID}$`).test(artifact) || !path?.[1]) return miss();

    const n = Number(path[1]);
    // Unscoped on purpose: a Reader's link is the credential here, and Readers are Client-blind (ADR-0008).
    if (!q.artifact.get({ id: artifact, client: null }) || !q.version.get(artifact, n)) return miss();
    let fragment: string;
    try {
      fragment = readFileSync(versionPath(cfg.dataDir, artifact, n), 'utf8');
    } catch {
      return miss();
    }
    res.writeHead(200, { ...artifactHeaders, 'content-type': 'text/html; charset=utf-8' });
    res.end(wrap(fragment, runtime));
  }

  return {
    shellOrigin,
    usercontentOrigin,
    close: () =>
      new Promise<void>((resolve) => {
        let left = 2;
        const done = () => { if (--left === 0) { db.close(); resolve(); } };
        shell.close(done);
        usercontent.close(done);
        shell.closeAllConnections();
        usercontent.closeAllConnections();
      }),
  };
}

// --- entry point -------------------------------------------------------------

if (import.meta.main) {
  const dataDir = process.env['MYARTIFACTS_DATA'] ?? './data';
  /** An optional numeric setting: unset stays unset, so the default lives in one place. */
  const knob = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  if (process.argv[2] === 'mint-token') {
    const name = process.argv[3];
    if (!name) { console.error('usage: npm run mint-token -- <name>'); process.exit(2); }
    console.log(mintToken(dataDir, name));
  } else {
    const webhookUrl = process.env['MYARTIFACTS_WEBHOOK_URL'];
    if (!webhookUrl) console.warn('MYARTIFACTS_WEBHOOK_URL is not set — new Annotations will not be announced');
    const running = await start({
      dataDir,
      shellPort: Number(process.env['MYARTIFACTS_PORT'] ?? 8787),
      usercontentPort: Number(process.env['MYARTIFACTS_USERCONTENT_PORT'] ?? 8788),
      shellOrigin: process.env['MYARTIFACTS_SHELL_ORIGIN'],
      usercontentHost: process.env['MYARTIFACTS_USERCONTENT_HOST'],
      webhookUrl,
      // Spec §10: the bucket is tuning. Unset leaves the defaults, which is what a deployment
      // that has never had to think about it should get.
      ratePerSecond: knob(process.env['MYARTIFACTS_RATE']),
      rateBurst: knob(process.env['MYARTIFACTS_RATE_BURST']),
    });
    console.log(`Shell       ${running.shellOrigin}`);
    console.log(`Artifacts   ${running.usercontentOrigin('<id>')}`);
  }
}
