# One origin per Artifact

Each Artifact is served from its own subdomain, `<id>.usercontent.<domain>`, rather than
all Artifacts sharing one origin. This matches Anthropic's `*.claudeusercontent.com`, and
for the same reason.

Origin isolation is not only about keeping Artifacts away from the Shell — it is also
about keeping them away from each other. Artifacts sharing an origin share `localStorage`,
`sessionStorage`, and IndexedDB, and any one of them can `window.open` another and read its
DOM, because same-origin. The CSP does not help: `connect-src 'none'` blocks the network,
not same-origin access between our own pages.

That matters here specifically because Artifact HTML is model-generated from material we
feed the agent — customer briefs, client documents, competitor material — which is an
injection surface we do not fully control. On a shared origin, one poisoned mockup can read
another client's mockup. Building the Shell/Artifact boundary carefully and then placing
every customer's confidential work on the same side of it would defeat the point.

## Consequences

Serving needs a wildcard certificate, so ACME must use a DNS-01 challenge — Caddy plus the
DNS provider's plugin and an API token. Configuration rather than code, paid once.

This is why it had to be settled before launch rather than retrofitted: per-Artifact
origins change every published URL, and those URLs will already be in customers' hands.
