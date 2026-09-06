# SQLite and files on one box

One Node/TS process on the Hong Kong VPS, SQLite for Annotations and metadata, published
Versions written as files on local disk. No Postgres, no object storage, no second machine.

The workload is a handful of publishers, dozens of Readers per Artifact, and a few hundred
Artifacts a year, each capped at 16 MiB and most far smaller. SQLite's ceiling is orders of
magnitude above that, and the payoff is that the entire system state — database and
published pages together — is one directory: backup is `tar`, and reproducing a client
review from six months ago is copying a folder. For work we may have to produce again for
a customer, that is worth more than any scaling property the alternatives offer.

This is a deliberate deviation from the Postgres-everywhere pattern used across our other
projects. The deviation is the decision.

## Considered options

- **Postgres plus S3-compatible object storage.** Buys a network dependency, a second set
  of credentials, and a second backup story to serve a workload one file handles.
- **Reuse an existing Postgres instance.** Tempting because it already runs — but it runs
  on a different machine, so every page load would make a cross-border database call, the
  one thing ADR-0001 exists to avoid.

## Consequences

One server, no horizontal scaling, and concurrent writes serialize. Annotations are a
trickle, so the write lock is not a real constraint. If the box dies this is a
restore-from-backup story, not a failover story — accepted, on the understanding that this
is an internal tool and not something under a client-facing availability commitment.
Revisit if that stops being true.

Versions are kept forever (decided 2026-09-02): no time-based or count-based cleanup,
because the reproduce-a-review-from-six-months-ago property is the point. Deleting an
Artifact is a soft delete that hides it from every endpoint; nothing on disk is removed.
