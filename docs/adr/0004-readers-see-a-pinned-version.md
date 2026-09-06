# Readers see a pinned Version, not the latest

**Superseded by ADR-0009 (2026-09-02).** Readers now see the latest Version by default;
pinning survives only as an optional freeze. Kept for the reasoning.

Publishing a new Version does not change what Readers see. The publisher promotes a
Version deliberately, and until they do, Readers keep viewing the one they were sent.

This is a deliberate deviation from Claude Code Artifacts, which we otherwise align with.
Their default is live — "anyone with the page open sees the update in place" — and that is
right for their case, where the audience is an internal teammate watching a long-running
task fill in. Ours is an external customer reviewing a deliverable, and there the same
behavior does damage: it shows half-finished work under our name to a client who opened
the link at the wrong moment, and it detaches the Annotations they just left from the
content those Annotations were about, which is precisely what ADR-0003 exists to prevent.

Do not "fix" this to match Claude's default. The divergence is the decision.

## Consequences

The publisher can iterate freely without an audience and hand over a finished Version on
purpose, which is the working rhythm this tool is for.

The cost is one extra deliberate act per round of review — publishing is no longer
sharing. That act is also the natural moment for open Annotations from earlier Versions to
surface against the new one.

Pinning is per Artifact rather than per Reader. A per-Reader toggle was rejected as a
state machine bought for a choice that would be set the same way every time.
