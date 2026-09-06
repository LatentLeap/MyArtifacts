# The capability bridge: one injected runtime, Claude's contract, zero declaration

An Artifact page may call `claude.use("db")`, `("user")`, `("downloads")` and
`("artifact")` exactly as it would inside Claude Code Artifacts (runtime contract 0.2.39),
and the same file runs unchanged in both places. The Shell injects one runtime into every
Artifact — the height beacon, the `claude.use` stub, and the comment client — and that
runtime speaks to the Shell over a single origin-checked `postMessage` transport. The
Artifact still has no network: every call is carried by the Shell and answered by our
server. Decided 2026-09-02, when the project's goal was restated as replicating Artifacts
for customers who cannot reach claude.ai; where a settled ADR and Claude's semantics
disagreed, Claude's semantics won.

## What we chose that was not forced

- **Zero declaration.** Claude declares capabilities at publish time; we take a bare file.
  So the Shell injects the same runtime everywhere and `use()` resolves `null` for
  whatever the Shell does not offer, which the contract already requires pages to handle.
  The cost is that custom `rules` cannot be expressed, so v1 implements only the contract
  defaults (everyone reads and writes, `data/users/{self}` is private even from the
  publisher).
- **Readers can publish from inside a page.** `artifact.publish` mints the next Version
  attributed to the Reader, compare-and-set against the Version the page loaded. Without
  this a poll written the way Claude writes polls is read-only for the people it is for.
  It means a link holder can put arbitrary HTML in front of every other Reader; origin
  isolation (ADR-0007) and the no-network CSP are the containment, as they are for Claude.
  A frozen Artifact (ADR-0009) refuses page publishes with `not_writer`.
- **`downloads` goes through the Shell**, not through `allow-downloads` on the iframe. The
  Shell shows the confirmation and triggers the download from its own origin, so the
  extension allowlist and size cap are enforced by us and the Artifact stays inert.
- **Identity stays opaque.** `user.id()` is the Reader id or the token name; names never
  cross into the Artifact. A forwarded link shares its id and therefore its private
  subtree (ADR-0002).
- **Not offered:** `room` (nothing in v1 needs presence), `sample` (Readers have no Claude
  account to bill), `mcp` (presupposes claude.ai connectors — the very thing our Readers
  lack). All resolve `null`.

## Consequences

The hard rule in `CLAUDE.md` changes from "the only script we inject is the height beacon"
to "the only script we inject is the runtime". Anchoring moves from Canvas coordinates to
the DOM — the comment client makes ADR-0005's premise (the Shell can see nothing inside)
false — and a separate ADR will record that change. Every page publish is a Version, so
the Version table grows with use, not only with agent iterations; that is what Claude does
and it is the point.
