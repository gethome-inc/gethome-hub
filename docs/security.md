# Privacy and network security

What the hub keeps on your network, what leaves it, and what guards the door. It
is the long version of the README's *Private by design*. The gethome
[privacy policy](https://gethome.me/privacy) describes this same code from the
outside.

- [What stays home](#what-stays-home)
- [What leaves the hub](#what-leaves-the-hub)
- [Never forward a port](#never-forward-a-port)
- [Who can talk to the hub](#who-can-talk-to-the-hub)
- [What the installer verifies](#what-the-installer-verifies)
- [Remote access](#remote-access)

## What stays home

There is no cloud account, no relay and no tunnel: the hub opens no inbound
path through your router. Your devices, your rooms, your rules, your history and
your members live in one SQLite file on the hub's own card, and the apps reach
it over your own Wi-Fi.

## What leaves the hub

The only connections the hub itself ever makes outward are:

- **To your AI provider** — Anthropic or OpenAI — **if you gave it a key**, and
  only for the AI feature you use. What each feature sends, and to whom, is in
  the [privacy policy](https://gethome.me/privacy#ai); the engineering side is
  in [`ai-adaptation.md`](ai-adaptation.md), [`assistant.md`](assistant.md) and
  [`portraits.md`](portraits.md). With no key, nothing goes to any AI provider
  and devices still appear, flagged *needs review*.
- **To GitHub**, when it checks whether a newer build exists.
- **To two documentation sites** — `zigbee2mqtt.io` and
  `raw.githubusercontent.com` — while the mapping agent is working out what a
  Zigbee device is, and only on a hub set up for OpenAI: on Anthropic the
  provider's own web tools do the reading, and with no key, or outside a run,
  the hub opens neither. What is fetched is a page about a public device model,
  never anything about your home
  ([why only those two](ai-adaptation.md)).

Installing and updating the hub also download from GitHub, nodejs.org and npm,
and Zigbee2MQTT may ask GitHub whether your devices have new firmware. Those are
the installer's and Zigbee2MQTT's own downloads, not the hub reporting anything
about your home.

Your AI key is kept **encrypted on the hub** (AES-256-GCM, with a secret in a
file only the hub can read), and the API never returns it — not to the app, not
to anybody. Even the voice does not put it on a phone: the hub sets up that call
itself and hands the phone an answer, never the key.

## Never forward a port

The hub speaks two things on your network: its API on port **8420** (HTTP) and
its MQTT broker on port **1883**. Both are plain, unencrypted connections, which
is right behind your own router and wrong anywhere else — the token your phone
holds crosses the wire in the clear. **Don't forward either one.** Your router is
the boundary; nothing in the hub replaces it.

`BIND_ADDRESS` (in `/etc/gethome/hub.env`) can narrow which network interface the
hub answers on. It defaults to all of them, because a hub is found from a phone
on the same Wi-Fi; it is a way to keep a board that sits on a second network from
serving it, not a security boundary.

## Who can talk to the hub

- **Every request but two needs a token.** Only the public `GET /hub` and the
  claim need none. A token comes from the claim flow and is never handed to a
  page — see [`api.md`](api.md#claiming).
- **No web page can use it.** The hub sends no CORS headers, so a browser
  refuses to read its answers cross-origin, and a page cannot attach an
  `Authorization` header without a preflight the hub answers with a `404`.
- **The hub refuses any request whose `Host` is a public domain.** That is what
  stops a page on the internet pointing its own name at your hub's address and
  reading it through your browser (DNS rebinding). Reaching the hub by address,
  by `localhost` or by its `.local` name is untouched, so nothing about how the
  apps connect is different. If you reach yours by a real domain resolved inside
  your house, name it in `EXTRA_ALLOWED_HOSTS` in `/etc/gethome/hub.env`. The
  rule is about names, not addresses: a name an attacker controls has to be a
  registrable public domain, and nothing a hub is legitimately called is.
- **What a person may do is a table the home edits.** Owner, Member and Guest
  come built in, a home can add roles, and the owner is never locked out of it —
  [`api.md`](api.md#roles-and-permissions-in-full). Removing a member ends their
  tokens *and* closes the connections they already hold.
- **A Wi-Fi password given to the hub never comes back out.** Adding a network
  for the hub to join somewhere else turns the password into that network's
  key before anything is written, the key goes into the system's own
  root-only network profile, and no route returns either. The hub refuses an
  open network outright, because on one every token a phone sends is readable
  by anyone in range — [`api.md`](api.md#wi-fi-networks-settingswifi).
- **Rules are data, not code.** A rule written by a person or by a model is
  interpreted by the hub and can never run arbitrary code, and a handful of
  guards hold whatever the document says — [`automations.md`](automations.md).

## What the installer verifies

The bundle and the Node.js runtime under it are each verified against a SHA-256
published beside them. Anything the installer cannot verify — a mismatch, a
missing checksum, a machine with no `sha256sum` — stops the install with your
existing hub left running and untouched.

## Remote access

Controlling the home from away is not built: version one is LAN-only by design.
A relay is planned, authenticated end to end, and the hub will still never be
port-forwarded to get there.
