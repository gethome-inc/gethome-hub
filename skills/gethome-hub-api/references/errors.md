# Refusals, and what to do about each

Every refusal is JSON with an `error` code, and most carry what to fix:
`permission` names a permission, `reason` explains a `401`, `detail` is a
sentence you may show a person. Treat codes as an **open** vocabulary: an
unknown one is still a refusal — show `detail` if there is one, the status if
not.

## The key itself

| Status | Body | Means | Do |
|---|---|---|---|
| 401 | `{error:"unauthorized"}` | no key, an unknown key, or a revoked one | check `GETHOME_API_KEY`; ask the person for a new key |
| 401 | `{error:"unauthorized", reason:"key_expired"}` | its expiry passed | ask the person to extend it or make another |
| 401 | `{error:"unauthorized", reason:"key_suspended"}` | the member's role no longer allows keys | only a person can fix this, in the role settings |
| 401 | `{error:"unauthorized", reason:"key_in_query"}` | the key was sent as `?token=` | send it in the `Authorization` header |
| 403 | `{error:"key_read_only"}` | working the home with a key that has no `control` | ask for `control`, or don't do it |
| 403 | `{error:"forbidden", permission}` | the key was not given that permission, or its member no longer holds it | ask the person to give the key that permission |
| 403 | `{error:"key_not_allowed", permission?}` | no API key may do this — people, roles, AI and broker settings, Wi-Fi, keys, conversations | the person does it themselves, never through a key |
| 429 | `{error:"rate_limited", retryAfterMs}` + `Retry-After` | more than the key's rate (50 at once, 10 a second) | wait, then use the WebSocket instead of polling |

## The request

| Status | Body | Means |
|---|---|---|
| 400 | `{error:"invalid_body", detail, issues}` | the body did not match; `detail` is the first problem in words |
| 404 | `{error:"not_found"}` | that id does not exist (any more) |
| 404 | `{error:"unknown_room"}` / `{error:"unknown_zone"}` | a `roomId`/`zoneId` that does not exist |
| 404 | (Fastify's `Not Found`) on a documented route | **an older hub** — say so and degrade |
| 409 | `{error:"<message>"}` on a command | the device cannot honour that command |
| 409 | `automation_disabled`, `not_pressable`, `not_a_toggle` | pressing a rule that is off, has nothing to press, or is not a mode |
| 409 | `already_commissioning`, `matter_disabled`, `zigbee_disabled` | pairing refusals |
| 409 | `update_in_progress`, `update_unsupported` | hub update refusals; `update_unsupported` also refuses switching on automatic updates |
| 422 | `{error:"invalid_automation", issues}` or `{…, problems, warnings}` | a rule the schema refuses, or one this home cannot use |
| 403 | `{error:"host_not_allowed", host}` | the hub was reached by a public domain name; use its IP or `.local` name |

## The event stream

| Close code | Means | Do |
|---|---|---|
| 4001 | the key is no good any more | stop; do not reconnect |
| 1008 | the key already holds five streams | close another |
| 1013 | opened faster than the key's rate | wait, then retry |
| other | the connection dropped | back off and reconnect, then re-read state |

## Not refusals, but often mistaken for them

- **`202` from a command** means routed. A `commandFailed` frame may follow.
- **A device that is `online: false`** with `offlineExpected` or
  `offlineElsewhere` is not broken — somebody said it is meant to be off, or it
  is on a Wi-Fi network the hub has left.
- **`needsReview: true`** means the hub could not map every one of the device's
  parameters, not that it is unusable.
- **The hub restarting** (an update, a radio switch) is unreachable for a minute
  or two, then back. A hub with automatic updates on can do this by itself,
  at an hour its home is usually quiet.
