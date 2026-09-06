# Host offshore in Hong Kong

The people who read published pages are LatentLeap's customers in mainland China, which
is the whole reason this project exists — they cannot reach claude.ai. That makes
reachability from the mainland a hard external constraint rather than an operational
preference, and it eliminates the obvious modern answers.

We host on a Hong Kong VPS. LatentLeap has no mainland business entity, so mainland
hosting (Aliyun/Tencent Hangzhou or Shenzhen) is not available to us: a public domain
served from inside the mainland requires an ICP filing (备案), which requires that entity
and takes weeks. Offshore needs no filing and we can deploy today.

## Considered options

- **Mainland (Aliyun/Tencent).** Fastest and most reliable for our readers. Blocked on the
  ICP filing, which is blocked on having a mainland entity. Revisit if LatentLeap ever
  incorporates one — the reader experience is genuinely better.
- **Cloudflare Workers/Pages, Vercel, Netlify.** The default choice for this shape of app,
  and the reason this ADR exists. `workers.dev` and similar platform domains are
  unreliable-to-blocked from the mainland; Cloudflare's China Network needs an enterprise
  plan, a JD Cloud partnership, and an ICP filing anyway. Do not re-propose these without
  measuring from a mainland connection first.

## Consequences

Do not send email from this host. Mainland providers — QQ Mail and 163 especially — treat
foreign senders harshly, so any notification feature built on email would mean debugging
SPF, DKIM, and silent spam-foldering on infrastructure chosen for reachability rather than
sender reputation. Notifications go out as a generic outbound webhook to a URL in the
environment (WeCom, Feishu, Slack, or anything else) instead.

Readers see 80–150ms latency and throughput that varies with cross-border conditions on
any given day. Acceptable: published pages are small, static, and cacheable, and a reader
spends minutes on one. It does mean page weight is a reader-facing concern here in a way
it would not be on a CDN — keep artifacts small and avoid chatty loads.
