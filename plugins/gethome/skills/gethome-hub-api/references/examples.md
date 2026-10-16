# Starting points

Each reads `GETHOME_HUB_URL` (e.g. `http://192.168.1.50:8420`) and
`GETHOME_API_KEY` from the environment and never prints the key. Adapt them;
keep those two properties.

## curl

`hub` hands curl the header through a pipe: `printf` is built into bash and
zsh, so the key never appears on a command line, where anyone else on the
machine could read it in the process list.

```sh
hub() { curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$GETHOME_API_KEY") "$@"; }
api=$GETHOME_HUB_URL/api/v1

# Does this hub take keys, and what may this one do?
curl -sS "$api/hub" | jq '.apiKeys'
hub "$api/me" | jq '{permissions, apiKey}'

# Every light and whether it is on.
hub "$api/devices" |
  jq -r '.[] | select(.endpoints[0].deviceKind == "light")
         | "\(.name)\t\(.endpoints[0].state.onOff)"'

# Every rule: the answer is an object, not a list.
hub "$api/automations" | jq -r '.automations[] | "\(.name): \(.summary)"'

# On at about 30 % (level is 1–254, not percent): brightness first, then power.
for body in '{"type":"setLevel","level":77}' '{"type":"power","on":true}'; do
  hub -X POST -H 'content-type: application/json' -d "$body" \
    "$api/devices/$DEVICE_ID/endpoints/1/commands"
done
```

## Python (standard library)

```python
"""Report every temperature sensor in °C. Read-only key is enough."""
import json
import os
import urllib.error
import urllib.request

HUB = os.environ["GETHOME_HUB_URL"].rstrip("/")
KEY = os.environ["GETHOME_API_KEY"]


def call(method: str, path: str, body: dict | None = None):
    request = urllib.request.Request(
        f"{HUB}/api/v1{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        refusal = json.loads(error.read() or b"{}")
        raise SystemExit(f"{method} {path}: {error.code} {refusal}") from None


hub = call("GET", "/hub")
if "apiKeys" not in hub:
    raise SystemExit("This hub predates API keys — update it first.")

for device in call("GET", "/devices"):
    for endpoint in device["endpoints"]:
        centi = endpoint["state"].get("sensors", {}).get("temperatureCenti")
        if centi is not None:
            print(f"{device['name']}: {centi / 100:.1f} °C")
```

## Node 22 with `ws` (live)

```js
// npm install ws
import WebSocket from 'ws';

const hub = process.env.GETHOME_HUB_URL.replace(/\/$/, '');
const key = process.env.GETHOME_API_KEY;
const headers = { authorization: `Bearer ${key}` };

async function call(method, path, body) {
  const response = await fetch(`${hub}/api/v1${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const devices = new Map((await call('GET', '/devices')).map((d) => [d.id, d]));
let delay = 1000;

function connect() {
  const socket = new WebSocket(`${hub.replace(/^http/, 'ws')}/api/v1/ws`, { headers });
  socket.on('open', () => { delay = 1000; });
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    switch (frame.type) {
      case 'state': {
        const device = devices.get(frame.deviceId);
        const endpoint = device?.endpoints.find((e) => e.endpointId === frame.endpointId);
        if (endpoint) endpoint.state = frame.state; // whole state, not a diff
        if (frame.state.sensors?.occupied) console.log(`${device?.name}: movement`);
        break;
      }
      case 'commandFailed':
        console.warn(`did not land on ${devices.get(frame.deviceId)?.name}: ${frame.detail}`);
        break;
      default:
        break; // unknown frame types are fine to ignore
    }
  });
  socket.on('close', async (code) => {
    if (code === 4001) {
      console.error('The hub no longer accepts this key (revoked, expired or paused). Stopping.');
      return;
    }
    if (code === 1008) {
      console.error('This key already holds five event streams. Close one, then start again.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 60_000);
    for (const d of await call('GET', '/devices')) devices.set(d.id, d); // frames were missed
    connect();
  });
  socket.on('error', () => {}); // 'close' follows and handles it
}

connect();
```

## A safe command helper

```python
DANGEROUS = {("lock", False)}  # unlocking; add covering/garage commands your home uses


def command(device_id: str, endpoint_id: int, body: dict, confirmed: bool = False):
    if body.get("type") == "lock" and body.get("engage") is False and not confirmed:
        raise PermissionError("Unlocking needs the person's explicit yes.")
    return call("POST", f"/devices/{device_id}/endpoints/{endpoint_id}/commands", body)
```
