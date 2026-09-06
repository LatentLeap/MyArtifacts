# Annotations anchor to Canvas coordinates, not to the DOM

**Superseded by ADR-0011 (2026-09-02).** The injected runtime (ADR-0010) can see inside the
Artifact, so anchors are DOM paths now; the fixed Canvas survives. Kept for the reasoning.

An Annotation stores a normalized (0–1) coordinate pair against its Version's Canvas. The
Shell draws pins as an overlay positioned over the Artifact's iframe, knowing only the
iframe's rectangle and the scale factor it applied.

This follows directly from origin isolation. The Artifact is served cross-origin so that a
published page can never reach the Shell's context — and cross-origin means the Shell
cannot read the Artifact's DOM at all. Every anchoring scheme that names something *inside*
the page (an element, a selector, a text range) requires a same-origin iframe, which would
trade away the one rule this system is built around. Coordinates are what remains, and
they turn out to be sufficient because ADR-0003 already freed anchors from surviving a
republish.

## Consequences

The Canvas has to be fixed rather than reflowing, or a coordinate would mean different
things at different widths. Each Artifact therefore declares a layout width at publish
time and the Shell scales it to fit — narrow for documents, wide for mockups. This is not
purely a cost: publisher and Reader end up looking at identical geometry, so a conversation
about a design is never confused by a layout that reflowed differently on someone's screen.

Because the Canvas is fixed and scaled, one annotation layer serves both phone and desktop
rather than two. Mobile is the harder case and the design targets it; desktop inherits.

Artifacts must be composed to be legible at their declared Canvas width when scaled to a
phone. That is a constraint on what the agent generates, not on this system, and it lives
in `CLAUDE.md`.

A cross-origin iframe cannot report its own height, so the Shell cannot size it or place
pins below the fold. The wrapper we serve around every Artifact carries a small
height-reporting `postMessage` for this. It grants the Artifact no capability and does not
loosen the CSP, but it is the one reason an Artifact is not literally inert.
