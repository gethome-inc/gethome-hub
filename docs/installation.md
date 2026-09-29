# Installing and running a hub

How to put the hub on a machine, keep it running and update it — by hand, over
SSH. The installer's own rules (its progress markers, memory limits, rollback)
are in [`../deploy/CLAUDE.md`](../deploy/CLAUDE.md); what to buy is in
[`hardware.md`](hardware.md); what stays on your network is in
[`security.md`](security.md).

- [What you need](#what-you-need)
- [Install](#install)
- [Claim it](#claim-it)
- [Day to day](#day-to-day)
- [Updating](#updating)
- [How the installer gets the hub](#how-the-installer-gets-the-hub)

## What you need

- A **64-bit** Linux machine, ideally a small computer such as a Raspberry Pi
  with **2 GB of memory or more** — see [`hardware.md`](hardware.md).
- **Raspberry Pi OS Lite (64-bit)** on its card, with SSH switched on. Lite is
  one level down in Raspberry Pi Imager, under *Raspberry Pi OS (other)*.
- For Zigbee, a **USB coordinator** plugged in before or after installing
  (the SONOFF ZBDongle-E is the one we develop against). Without one you get
  Matter, Wi-Fi and MQTT devices only.
- The machine online while it installs: it downloads the hub from GitHub and
  Node.js from nodejs.org, installs Mosquitto with the system's package manager
  and fetches Zigbee2MQTT from npm.

Give it a **fixed address** while you are in the router — a DHCP reservation for
its MAC is enough. The apps find the hub over mDNS (`_gethome._tcp`) and remember
the address they last saw, so a hub that moves is a hub they have to find again.

## Install

Log in to the machine ([how](../README.md#getting-a-shell-on-the-hub)) and run:

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash
# to pin a specific Zigbee coordinator instead of letting it be detected:
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash -s -- --zigbee /dev/serial/by-id/usb-...
```

**Zigbee needs no flags.** The installer identifies an attached coordinator by
itself, and installs a udev rule so one plugged in *later* starts working
automatically too — see [`zigbee.md`](zigbee.md#finding-the-coordinator).

The installer downloads a prebuilt hub for this machine's processor, installs
Node.js 22 and Mosquitto, registers everything as systemd units, and prints the
**pairing code**. Every unit is enabled at boot with `Restart=always`, so the
hub comes back on its own after a power cut — plug the Pi in and it runs, with
nothing to start by hand. There is no Docker and no database server: the store
is one SQLite file ([`architecture.md`](architecture.md)).

**Prefer a guided setup?** The Mac app, gethome studio, does all of this: it
writes the SD card or finds a Pi already on your network, gets this installer
running on it, and watches it step by step over SSH. It is not released yet —
[join the waitlist](https://gethome.me/#waitlist).

## Claim it

An unclaimed hub keeps an 8-digit **pairing code** until somebody uses it. The
first claim makes that person the **owner**; the owner then invites everybody
else with short-lived invite codes. The whole flow, including signing a person in
on a second device as themselves, is in [`api.md`](api.md#claiming).

The Mac app claims the hub for you at the end of its setup, so the pairing code
is for your *other* devices — a phone, a second Mac — rather than something you
have to find. On the machine itself, `sudo gethome-hubctl pairing-code` prints it
again.

## Day to day

Everything here runs *on* the hub — [get a shell first](../README.md#getting-a-shell-on-the-hub).

```sh
sudo gethome-hubctl status          # every service, and what the API says
sudo gethome-hubctl logs 100
sudo gethome-hubctl zigbee          # the coordinator, and re-check what's attached
sudo gethome-hubctl pairing-code    # for another device
sudo gethome-hubctl mqtt            # the broker's two accounts (--rotate to change them)
```

The API answers at `http://<hub>:8420/api/v1/hub`, and the MQTT broker at
`mqtt://<hub>:1883` for devices on the same network. The broker asks for a
username and password, and there are two accounts — which one to use for your
own devices, and why, is in [`mqtt-integrations.md`](mqtt-integrations.md#connecting).
Neither port should ever be forwarded through your router
([`security.md`](security.md)).

## Updating

```sh
sudo gethome-hubctl version          # which build is running
sudo gethome-hubctl update           # install the latest build of main
sudo gethome-hubctl rollback         # go back to the previous one
```

**Or from an app.** The gethome iPhone app updates a hub from its Hub page, and
gethome studio does it over SSH — both run exactly this, so the atomic flip, the
health check and the automatic rollback are the same on every path. Updating
from an app needs the `hub.update` permission, which **Owner and Member have by
default and Guest does not** (the roles table is editable —
[`api.md`](api.md#roles-and-permissions-in-full)); every member can watch it
happen. A hub installed before that existed has to be updated once from gethome
studio or from here, after which it can do it itself.

**Installing a branch.** `update` takes `--branch`, which is how an unmerged
change gets onto real hardware — and how you go back afterwards:

```sh
sudo gethome-hubctl update --branch my-feature
sudo gethome-hubctl update --branch main       # back to the released line
```

It installs the rolling `bundle-<branch>` release described
[below](#how-the-installer-gets-the-hub), with any `/` in the name flattened to
`-`: branch `alice/new-thing` installs `bundle-alice-new-thing`. If CI has not
published that branch for this processor yet, the installer says which release
it looked for; on a board with more than 1 GB of memory it then builds from
source instead, which takes a while, and on a smaller one it stops and tells you
to check the workflow rather than starting a build that cannot finish.

On a hub too old to have `gethome-hubctl`, the installer does the same job
directly. The options go **after** `bash -s --`, or they reach bash instead of
the script:

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/my-feature/deploy/install.sh \
  | bash -s -- --branch my-feature
```

**A failed update leaves you where you were.** Each build lives in its own
directory under `/opt/gethome/releases/` and `current` is a symlink to the one
that runs, so an update is an atomic flip — and if the new build doesn't answer
its health check, the installer flips it back by itself and tells you why. The
hub keeps the build it was running until the new one answers.

## How the installer gets the hub

The Pi downloads the hub; it does not compile it. `.github/workflows/bundle.yml`
publishes one tarball per architecture (`linux-arm64`, `linux-x64`) — `dist/`
plus production `node_modules` with native modules already built for that
platform — and stamps each with a build id. Compiling *on* a Pi means `npm ci`
pulling a thousand packages onto an SD card and then `tsc`: twenty to forty
minutes, several hundred megabytes of memory, and on a 512 MB board an
out-of-memory kill at the end of it regardless.

`install.sh` falls back to building from source when there is no bundle — but
only on a machine with more than 1 GB of memory. Below that it stops and says
why, because starting a build that cannot finish is worse than an error.

**Two kinds of release, and only one of them lasts.** Pushing any branch
publishes a *rolling prerelease* named `bundle-<branch>`; its assets, its tag
and its description all move on every push, so the release page always names the
commit that is actually inside it. `bundle-cleanup.yml` deletes the whole thing
once the branch is gone. Pushing a `v*` tag publishes an immutable release under
that tag, which nothing re-points and nothing ever deletes. `install.sh --branch
X` looks for `bundle-X`, and everything defaults to `main`, so a hub installs
`bundle-main` unless someone says otherwise.

What the installer downloads is verified against a SHA-256 published beside it —
see [`security.md`](security.md#what-the-installer-verifies).
