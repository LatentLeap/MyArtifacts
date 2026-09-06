# Publishers are scoped by Client

A Publisher token optionally carries a Client. An Artifact copies the Client of the token
that published it, at publish time, and keeps it for life. A token with no Client is one
of us: it sees every Artifact, holds every power on every Artifact, and is the only kind
of token that can mint or revoke tokens. A token with a Client sees and acts only within
that Client, with the full set of Publisher powers there, and can do nothing at all with
tokens.

This replaces the trust premise in ADR-0002. Publishers are no longer "fewer than ten
people who trust each other": outsourced designers and customer-side staff also hold
tokens and publish, and one customer must never see another's work (decided 2026-09-02).

## Why a label on the token, and not a Client entity

Every account-based product we surveyed — Figma, Notion, Linear, Frame.io, GitHub,
Basecamp, Vercel — models this as a container plus a membership table: Clients exist
first, people are added to them, content is created inside them. The one product whose
identity *is* the credential, Tailscale, does the opposite: an auth key carries a tag,
and whatever the key creates inherits the tag. Our Publishers are tokens, not accounts
(ADR-0002), so the Tailscale shape is the one that fits. It costs one nullable column on
each of two tables and a `WHERE` on the list; the container shape costs two tables and a
set of membership endpoints. The survey is in `docs/research/minimal-tenant-scoping.md`
on branch `research/minimal-tenant-scoping`.

The common ground across all of them holds here too: "external" is a single bit, not a
role table; content belongs to exactly one scope; external people do not mint
credentials.

## Rules

- A Client is a short lowercase string chosen when the token is minted. There is no
  Client table. A misspelling is a different Client, as with a Tailscale tag; internal
  people are few and can be trusted to be careful.
- An internal token may pass a Client when publishing a new Artifact, to place it in a
  customer's scope. Without one the Artifact has no Client and only internal tokens see
  it. A Client token's publishes are forced to its own Client; naming any other is a 400.
- Crossing a Client boundary is a 404, never a 403, on every endpoint that carries an id.
  A 403 would confirm the id exists.
- A Client token's Readers and the webhooks its Artifacts fire are indistinguishable from
  ours. The webhook payload carries the Artifact's Client so the receiving side can route.
- Internal tokens are not protected from each other. That trust is unchanged.
- The Artifact's own origin is outside the boundary: it takes no token, so the id in the host
  is the bearer there, as it was before this decision. The Shell never hands that URL out
  (spec §4), and a Reader — Client-blind by the rule above — reaches it only through the
  Shell page.

## Consequences

One token belongs to one Client. An outsourcer working for two customers holds two
tokens. An Artifact published into the wrong Client is fixed by publishing it again under
the right one; the label itself is never edited.

The upgrade path, if a token ever genuinely needs two Clients: the `client` column becomes
a foreign key to a Client table and a token–Client membership table is added. That is the
container shape everyone else uses, and it is reachable from here without rewriting what
exists. Two smaller reliefs are also possible later and deliberately not built now: a
Client token minting tokens for its own Client, and re-labelling an Artifact after
publish.

An Artifact published into the wrong Client is also *hidden* from that Client by deleting it
(`DELETE /api/artifacts/{id}`, soft, decided 2026-09-02) — republishing under the right
Client alone would leave the wrong copy visible to the wrong customer's tokens.
