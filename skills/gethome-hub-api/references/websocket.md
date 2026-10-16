# The event stream

`GET /api/v1/ws` upgrades to a WebSocket. Send the key in the
`Authorization: Bearer <key>` header; a client that cannot set headers may use
`?token=<key>` on this route only. One JSON object per message.

## What arrives

The first frame is `hello`, then `access`, then everything as it happens:

```text
{"type":"hello","hubId","name","apiVersion":1,"streams":["zigbee","automations"],
 "permissions":[…],"apiKey":{"id","name","control"}}
{"type":"access","role":{id,key,name},"permissions":[…],"roles":[…]}   what the key may do, again whenever it changes
{"type":"state","deviceId","endpointId","state":{…}}                  the endpoint's full state after each change
{"type":"deviceUpserted","device":{…}}                                a device arrived, or its name/room/reachability changed
{"type":"deviceRemoved","deviceId"}
{"type":"commandFailed","deviceId","property","kind","detail"}       a write never reached the device
{"type":"structure","rooms":[…],"zones":[…]}                          rooms or zones changed — both lists, whole
{"type":"activity","entry":{id,at,kind,message,deviceId?,memberId?,data?}}
{"type":"automation","automationId"}                                  a rule was created, edited or switched — re-read it
{"type":"portraits","deviceId"}
{"type":"permitJoin","active","remainingSeconds"}
{"type":"commissioning","jobId","status","step"?,"failure"?,"deadline"?}
{"type":"hubStatus","zigbee":{…},"radio":{…}}                         a radio came up, went down, or was switched
```

- `state` carries the **whole** endpoint state, not a diff: replace what you
  hold for that endpoint.
- To see a command land, **open the socket first**: the `state` frame can
  arrive milliseconds after the command's `202`, before a socket opened
  afterwards is listening.
- `commandFailed.kind` is an open string (`unreachable`, `refused`, …); show
  `detail`, which is the protocol's own words.
- `activity` through a key without `activity.read` carries only the key's
  member's own rows.
- Ignore frame types you don't know.

## Optional streams

`hello.streams` lists what this socket may ask for. A key can have `zigbee`
(devices joining and leaving the Zigbee network) and `automations` (rules
firing). A key never gets `mqtt` (raw broker traffic) or `ai` (the hub's AI
runs), and on `automations` it hears rules firing and **never** a conversation.

```text
→ {"type":"subscribe","streams":["automations"]}
← {"type":"subscribed","streams":["automations"]}
← {"type":"automationRun","run":{automationId,name,at,trigger,cause,outcome,commands,refused,detail?}}
→ {"type":"unsubscribe","streams":["automations"]}
```

A stream that is not available comes back in `unavailable` on the
`subscribed` frame rather than as an error.

## Closing and reconnecting

| Close code | Means | Do |
|---|---|---|
| `4001` | the key is no good: revoked, expired, its member removed, or its member's role no longer allows keys | **stop**; do not reconnect; tell the person |
| `1008` | this key already holds five streams | close one of the others; don't reconnect until you have |
| `1013` | opened faster than the key's rate allows | wait a few seconds, then retry |
| anything else | network, restart, update | reconnect with exponential backoff (1 s, 2 s, 4 s … capped near a minute) |

**After any reconnect, re-read `GET /api/v1/devices`** (and anything else you
cache): frames sent while you were away are gone. A hub that is updating or
switching radios restarts and is unreachable for a minute or two; that is not a
failure.

## Rules of thumb

- One long-lived socket instead of polling — the hub may be a 512 MB board, and
  a key is rate-limited to 10 requests a second.
- Don't reconnect in a tight loop: back off, and stop entirely on `4001`.
- The socket is read-only apart from `subscribe`/`unsubscribe`; work devices
  with the REST command route.
