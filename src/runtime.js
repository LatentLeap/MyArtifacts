// The one script we inject into an Artifact. It runs first in the document head,
// before a body element exists, and speaks to the Shell over a single origin-checked postMessage
// transport (ADR-0010). The Artifact gets no network of its own.
//
// Ticket 01 carries the hello/ready handshake and the height beacon; ticket 06 the comment
// client (ADR-0011); ticket 09 the claude.use stub, ticket 10 its subscriptions, on the same transport.
(() => {
  const SHELL = __SHELL_ORIGIN__;
  const post = (m, transfer) => parent.postMessage(m, SHELL, transfer);

  let ready = null;
  const waiters = [];
  const calls = new Map();
  const subs = new Map();
  let seq = 0;
  addEventListener('message', (e) => {
    if (e.origin !== SHELL || e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'ready') { ready = m; waiters.splice(0).forEach((f) => f(m)); }
    else if (m.type === 'result') {
      const c = calls.get(m.id);
      if (c) { calls.delete(m.id); m.error ? c.reject(m.error) : c.resolve(m.ok); }
    }
    else if (m.type === 'event') { const s = subs.get(m.sub); if (s) s.next(m.docs); }
    // At most once, and terminal: the Shell has already forgotten the subscription.
    else if (m.type === 'end') { const s = subs.get(m.sub); if (s) { subs.delete(m.sub); if (m.error) s.fail(m.error); } }
    else if (m.type === 'mode') setMode(!!m.on);
    else if (m.type === 'locate') {
      anchors = Array.isArray(m.anchors) ? m.anchors : [];
      // The Shell can ask before the body is parsed: hello goes out from the head.
      if (document.readyState !== 'loading') locate();
      else if (!deferred) { deferred = true; addEventListener('DOMContentLoaded', locate, { once: true }); }
    }
  });

  let last = -1;
  const beacon = () => {
    const h = document.documentElement.scrollHeight;
    if (h !== last) post({ type: 'height', h: (last = h) });
  };
  const ro = new ResizeObserver(() => { beacon(); relocate(); });
  ro.observe(document.documentElement);
  addEventListener('DOMContentLoaded', () => ro.observe(document.body));
  addEventListener('load', beacon);

  // --- the capability bridge (ADR-0010) --------------------------------------
  // Claude's contract, 0.2.39: `window.claude` carries `use` and nothing else, a name the Shell
  // does not offer resolves `null`, and so does a Shell that never answers. Every call leaves
  // over the same transport and is made by the Shell — the page still has no network.

  const call = (cap, method, args, transfer) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      calls.set(id, { resolve, reject });
      // An argument that cannot be cloned on its way out is the caller's bug, and no call the
      // Shell was ever asked to answer — so it is rejected here rather than left pending.
      try { post({ type: 'call', id, cap, method, args }, transfer); }
      catch (e) { calls.delete(id); reject({ code: 'bad_request', message: String((e && e.message) || e) }); }
    });
  const whenReady = () => (ready ? Promise.resolve(ready) : new Promise((r) => { waiters.push(r); setTimeout(() => r(null), 10000); }));
  /** A method this runtime does not serve. The contract has no `not_supported`; this is it. */
  const removed = () => Promise.reject({ code: 'capability_removed', message: 'not in this runtime' });

  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const deepFreeze = (v) => {
    if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
    return v;
  };
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  /**
   * The contract's path grammar, checked where the path was written: a document path has an
   * even number of segments, a collection an odd one. A break is a programming error — thrown
   * synchronously, never sent — which is why building a ref touches nothing.
   */
  const check = (path, odd) => {
    if (typeof path !== 'string') throw new TypeError('path must be a string');
    const s = path.split('/');
    // Bytes, not characters — the same 1000 the door counts, which matters the moment a path is Chinese.
    if (new TextEncoder().encode(path).length > 1000 || s.length > 16) throw new TypeError('a path is at most 1000 bytes and 16 segments: ' + path);
    if (s.some((x) => !SEG.test(x) || x === '.' || x === '..')) throw new TypeError('bad segment in ' + JSON.stringify(path));
    if ((s.length % 2 === 1) !== odd) {
      throw new TypeError((odd ? 'collection' : 'document') + ' path needs an ' + (odd ? 'odd' : 'even') +
        ' number of segments, got ' + s.length + ': ' + path);
    }
    return path;
  };
  const idOf = (path) => path.slice(path.lastIndexOf('/') + 1);
  // Object identity, the contract's way: the same version of a document is the same snapshot,
  // so a `docChanges()` can tell modified from unchanged by `!==` alone.
  // ponytail: grows with every document this page has seen; a page is not open for long.
  const cache = new Map();
  const docSnap = (path, r) => {
    const id = idOf(path);
    if (!r || !r.exists) return Object.freeze({ id, exists: false, data: () => undefined, metadata: META });
    const c = cache.get(path);
    if (c && c.version === r.version) return c.snap;
    const data = deepFreeze(r.data);
    const snap = Object.freeze({ id, exists: true, data: () => data, metadata: META });
    cache.set(path, { version: r.version, snap });
    return snap;
  };
  /** Rows against the listener's previous docs; a one-shot read, or a first snapshot, has none — every document is `added`. */
  const querySnap = (rows, prev) => {
    const docs = Object.freeze(rows.map((r) => docSnap(r.path, { exists: true, data: r.data, version: r.version })));
    const changes = [];
    const before = new Map((prev || []).map((d, i) => [d.id, [d, i]]));
    docs.forEach((d, i) => {
      const p = before.get(d.id);
      if (!p) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
      else if (p[0] !== d || p[1] !== i) changes.push({ type: 'modified', doc: d, oldIndex: p[1], newIndex: i });
      before.delete(d.id);
    });
    // A removal hands back the last snapshot the listener saw, body and all.
    for (const [d, i] of before.values()) changes.push({ type: 'removed', doc: d, oldIndex: i, newIndex: -1 });
    return Object.freeze({ docs, size: docs.length, empty: !docs.length, metadata: META, docChanges: () => changes });
  };
  /** A client-minted id, the retriable-create idiom: `add` and an id-less `doc()` are `set`. */
  const mintId = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, '0')).join('');

  /**
   * A subscription is a `sub` the Shell holds a row for; every event is bare documents, and the
   * snapshot is made here. The error callback hears at most one terminal code — including the
   * contract's 65th listener — and without one the page's `error` event hears it instead.
   */
  const subscribe = (method, args, next, error) => {
    const fail = (e) => (error || reportError)(e);
    const refuse = (e) => { queueMicrotask(() => fail(e)); return () => {}; };
    const over = method === 'query' && overCap(args);
    if (over) return refuse({ code: 'invalid_argument', message: over });
    if (subs.size >= 64) return refuse({ code: 'resource_exhausted', message: 'at most 64 subscriptions per view' });
    const sub = ++seq;
    subs.set(sub, { next, fail });
    post({ type: 'sub', sub, cap: 'db', method, args });
    return () => { if (subs.delete(sub)) post({ type: 'unsub', sub }); };
  };

  const docRef = (path) => {
    check(path, false);
    return Object.freeze({
      id: idOf(path), path,
      get: () => call('db', 'get', { path }).then((r) => docSnap(path, r)),
      set: (data) => call('db', 'set', { path, data }).then(() => undefined),
      update: (data) => call('db', 'update', { path, data }).then(() => undefined),
      delete: () => call('db', 'delete', { path }).then(() => undefined),
      acquire: (o) => call('db', 'acquire', { path, ...o }),
      onSnapshot: (next, error) => subscribe('get', { path }, (docs) => next(docSnap(path, docs[0])), error),
      collection: (sub) => collRef(path + '/' + sub),
    });
  };
  /**
   * Spec §10's query caps, refused where the query was written as well as at the door. The server
   * is the one that has to say no; this is so a page that overreaches hears the contract's code
   * without a round trip, and hears it the same either way.
   */
  const overCap = (q) =>
    q.where.length > 10 ? 'at most ten filters'
      : q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000) ? 'limit is 1–1000'
        : null;
  /** Builders are pure and return a new query; only the terminal call goes anywhere. */
  const query = (q) => Object.freeze({
    path: q.collection,
    where: (f, op, v) => query({ ...q, where: [...q.where, [f, op, v]] }),
    orderBy: (f, dir) => query({ ...q, orderBy: [f, dir || 'asc'] }),
    limit: (n) => query({ ...q, limit: n }),
    get: () => {
      const over = overCap(q);
      return over ? Promise.reject({ code: 'invalid_argument', message: over }) : call('db', 'query', q).then((r) => querySnap(r.docs, null));
    },
    onSnapshot: (next, error) => {
      // Per listener, not per query: two listeners on one query each see their own transitions.
      let prev = null;
      return subscribe('query', q, (docs) => { const s = querySnap(docs, prev); prev = s.docs; next(s); }, error);
    },
    doc: (id) => docRef(q.collection + '/' + (id == null ? mintId() : id)),
    add: (data) => { const ref = docRef(q.collection + '/' + mintId()); return ref.set(data).then(() => ref); },
  });
  const collRef = (path) => query({ collection: check(path, true), where: [] });

  const NS = {
    db: () => Object.freeze({ doc: docRef, collection: collRef }),
    // Opaque by design: the Reader id or the token's name, never the name in the Shell's header.
    user: (r) => Object.freeze({
      id: async () => r.me.id, canEdit: async () => r.me.canEdit, isOwner: async () => r.me.isOwner, profiles: removed,
    }),
    // One publish: the complete replacement page. The files form carries paths between Versions,
    // which is a different kind of Artifact from the single file this one is (spec §9).
    artifact: () => Object.freeze({
      publish: (html) => (typeof html === 'string' ? call('artifact', 'publish', { html }) : removed()),
      edit: removed, sync: removed,
    }),
    // The bytes leave over the same transport and the Shell asks whoever is holding the page; the
    // page cannot save anything itself (its iframe is granted no downloads). Every rule — the
    // filename, the extension, the size, one prompt at a time — is the Shell's, because a page can
    // post a `call` without going through this script and nothing over the Bridge is trusted twice.
    // All this does is name the three fields the contract has and hand an ArrayBuffer over rather
    // than copy it: transferred, and so detached after the call, exactly as the contract promises.
    downloads: () => Object.freeze({
      save: (o) => {
        const r = o && typeof o === 'object' ? o : {};
        return call('downloads', 'save', { filename: r.filename, data: r.data, request: r.request },
          r.data instanceof ArrayBuffer ? [r.data] : undefined);
      },
    }),
  };
  const memo = new Map();
  window.claude = Object.freeze({
    use(name) {
      // `self` is what this capability was called before 0.2.0, and it still answers to it.
      const key = name === 'self' ? 'artifact' : name;
      if (!memo.has(key)) memo.set(key, whenReady().then((r) => (r && r.caps.includes(key) && NS[key] ? NS[key](r) : null)));
      return memo.get(key);
    },
  });

  // --- comment client (ADR-0011) ---------------------------------------------
  // An anchor is {path, pin, sig}: where the Reader clicked, as a place in the DOM, a point
  // inside that element, and a digest of what the element held. Taken here, resolved here;
  // the Shell only ever draws the rectangles this hands back.

  /** 16 hex characters, fixed-length, from two independent 32-bit FNV-1a passes. */
  const hash = (str) => {
    let a = 0x811c9dc5, b = 0x050c5d1f;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  };
  /** Tag plus normalized text (first 2 KiB); an element with no text signs its markup instead. */
  const sigOf = (el) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2048);
    return hash(el.tagName.toLowerCase() + '\n' + (text || el.outerHTML.slice(0, 2048)));
  };
  const SIMPLE_ID = /^[A-Za-z][\w-]*$/;
  /**
   * Claude's path syntax, and valid CSS: `#id`, else a unique `[data-id]`, else a chain of
   * `tag:nth-of-type(n)` from the nearest such anchor (or body). Ten segments at most: an
   * element deeper than that is anchored through its ancestor at that depth, so the pin still
   * lands where the Reader clicked and the path still names exactly one element.
   */
  const anchorOf = (el) => {
    const segs = [], chain = [];
    for (let e = el; e; e = e.parentElement) {
      chain.unshift(e);
      if (e === document.documentElement) { segs.unshift('html'); break; }
      if (e.id && SIMPLE_ID.test(e.id) && document.getElementById(e.id) === e) { segs.unshift('#' + e.id); break; }
      const d = e.getAttribute('data-id');
      if (d && d.length <= 100 && document.querySelectorAll('[data-id=' + JSON.stringify(d) + ']').length === 1) {
        segs.unshift('[data-id=' + JSON.stringify(d) + ']');
        break;
      }
      if (e === document.body) { segs.unshift('body'); break; }
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) n++;
      segs.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
    }
    return { el: chain[Math.min(9, chain.length - 1)], path: segs.slice(0, 10).join('>') };
  };
  // Canvas pixels: the iframe never scrolls, so client coordinates are document coordinates.
  const rectOf = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });

  // In comment mode every click is ours: captured before the page sees it, so a button under
  // the pin does not fire. The pointer events that lead up to it are swallowed for the same reason.
  let mode = false;
  // ponytail: the style node is a DOM mutation, so each toggle also costs one debounced `located`.
  const style = document.createElement('style');
  style.textContent = '*{cursor:crosshair!important}';
  const setMode = (on) => {
    mode = on;
    if (on) (document.head || document.documentElement).append(style);
    else style.remove();
  };
  const swallow = (e) => { if (mode) e.stopImmediatePropagation(); };
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) addEventListener(t, swallow, true);
  addEventListener('click', (e) => {
    if (!mode) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const { el, path } = anchorOf(e.target instanceof Element ? e.target : document.body);
    const r = el.getBoundingClientRect();
    post({
      type: 'click', path, sig: sigOf(el), rect: rectOf(r),
      pin: { x: r.width ? (e.clientX - r.left) / r.width : 0, y: r.height ? (e.clientY - r.top) / r.height : 0 },
    });
  }, true);

  // Anchors the Shell wants placed, re-resolved on every change to the page: on its own Version a
  // path that resolves is enough; on another (`strict`) the content has to be unchanged too.
  let anchors = [];
  let timer = 0;
  let deferred = false;
  const resolve = (a) => {
    let el = null;
    try { el = document.querySelector(a.path); } catch { /* not a path we made */ }
    if (!el || (a.strict && sigOf(el) !== a.sig)) return null;
    return rectOf(el.getBoundingClientRect());
  };
  const locate = () => {
    clearTimeout(timer);
    timer = 0;
    const rects = {};
    for (const a of anchors) rects[a.id] = resolve(a);
    post({ type: 'located', rects });
  };
  const relocate = () => {
    if (!anchors.length) return;
    clearTimeout(timer);
    timer = setTimeout(locate, 100);
  };
  new MutationObserver(relocate).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  post({ type: 'hello' });
})();
