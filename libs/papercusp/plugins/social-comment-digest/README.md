# Social comment digest trigger pack

A first-party starter that folds new comments across connected social accounts into one periodic
digest with themes, optional sentiment, and a separate list of anything needing a person. Five
bindings feed one plan target: `ext:reddit:comment`, `ext:youtube:comment`,
`ext:facebook-pages:comment`, `ext:instagram:comment`, and `ext:threads:reply`.

## The period is the storm window

This pack ships no scheduler. Social storm policy is `coalesce-with-cap`, so within one window the
first comment launches a run and the rest fold into it — which is what a digest is. Retune the
cadence by changing the window, not by arming a timer beside it.

Nothing is discarded by the policy: the cap bounds RUNS, not events. That is the difference from
the binding engine's mail-shaped default, which skips the overflow — correct for mail, silent data
loss here.

## How the run reads a window it cannot see

A run is launched by ONE event. The comments coalesced into it live in
`harness_shared.trigger_deliveries`, which **no agent verb exposes** — `triggers:*` is
create/bind/arm/disarm/list/status only. So the plan does not read delivery rows; it reconstructs
the window from the launching event's timestamp and the source's storm-policy `windowSeconds`, then
calls `social:search` once per platform with that `{ from, to }` range.

That path has its own hard limit worth knowing: `social:search` returns at most **50 hits per
call**, which is why `maxCommentsPerPlatform` is capped at 50 and why the plan reports a platform
whose search came back exactly full as OVERFLOWED. A digest that quietly truncated would claim a
completeness it never had.

## Per-platform caps

| binding | maxRuns / window | where the number comes from |
|---|---|---|
| reddit | 30 / 300s | documented 60 requests/minute |
| threads | 16 / 300s | dynamic allowance against the assumed daily floor |
| youtube | 3 / 300s | 10,000 quota units/day |
| facebook-pages | 1 / 300s (pack default) | impression-scaled budget, percentage-only observability |
| instagram | 1 / 300s (pack default) | impression-scaled budget, percentage-only observability |

The pack default is the tightest of these, because a default applies to any binding that does not
override it. None of these numbers is hand-chosen — each is what `socialStormPolicyFor()` derives
from the platform registry, and a test recomputes all of them and fails on disagreement.

## Connection

No binding declares an `oauthField`. Reddit registers a self-serve OAuth app that is not a
platform-wide provider, and Threads was deliberately left unwired: a Threads-configured Meta app
has its own app id and authorization host, distinct from Facebook's, and those endpoints are
unverified — so naming `facebook` there would assert a credential path that was examined and not
built. Sources connect through the social trigger-source flow.

Read scopes each connection must carry: Reddit `identity`, `read`; YouTube
`https://www.googleapis.com/auth/youtube.readonly`; Facebook Pages `pages_show_list`,
`pages_read_engagement`, `pages_read_user_content`; Instagram `instagram_basic`,
`instagram_manage_comments`; Threads `threads_basic`, `threads_read_replies`.

Cupboard installation only discovers the pack. Connection, instantiation and arming remain explicit.
