# Choosing hardware

What to run the hub on, and what to plug into it — in the terms of someone
about to buy. It is the long version of the README's *What you need*.

Two pages hold the rest. [`zigbee.md`](zigbee.md) has the memory arithmetic and
every measurement behind the advice here; [`../deploy/CLAUDE.md`](../deploy/CLAUDE.md)
has the reasoning behind what the installer decides. This page is the contract
for **what is tested and what is recommended**, so change it with them.

- [The computer](#the-computer)
- [Operating system](#operating-system)
- [Network](#network)
- [The Zigbee coordinator](#the-zigbee-coordinator)
- [One radio or both](#one-radio-or-both)

## The computer

A **64-bit** system is required, and **memory is what decides everything below**
— not the model name. The installer reads the board's RAM and applies one rule:

> **2 GB or more → both radios together. 1 GB or less → one radio at a time,
> recommended.** Nothing is refused either way; the smaller board is advised,
> not restricted, and [you can run both on it](#you-can-run-both-radios-on-a-small-board-and-what-that-costs).

Read the memory column first, because several boards are sold in more than one
size and the same model lands in different rows:

| Memory | Both radios at once? | Boards | Tested here |
|---|---|---|---|
| **4 GB and up** | **Yes**, with room to spare | Pi 5 (4/8/16 GB), Pi 4 (4/8 GB), Pi 400, Pi 500, CM4/CM5 (4 GB+) | Pi 5 and Pi 4 are tested |
| **2 GB** | **Yes** | Pi 5 (2 GB), Pi 4 (2 GB), CM4/CM5 (2 GB) | same rule, same code path as the row above |
| **1 GB** | One at a time recommended · both allowed | **Pi 4 (1 GB)**, **Pi 3 / 3B+**, CM4 (1 GB) | not routinely tested — see below |
| **512 MB** | One at a time recommended · both allowed | Pi Zero 2 W, Pi 3 A+ | tested most — the Zero 2 W is the board the hub is developed on |
| **Under 400 MB** | — | — | Refused by the installer, with the reason |
| **ARMv6, any size** | — | Pi 1, Pi Zero, Pi Zero W | Cannot work — Node.js has published no ARMv6 build since Node 12 |

Two rows are worth reading twice, because both are easy to buy by accident:

- **A 1 GB Pi 4 is a one-radio board.** So is a Pi 3. "Buy a Pi 4" is not the
  advice — *2 GB or more* is. The Pi 4 was sold in a 1 GB version and plenty are
  still in circulation secondhand; it gets exactly the same recommendation as a
  Zero 2 W, because the installer measures memory rather than reading the model
  off the board.
- **1 GB is the tier nobody here has measured.** Everything written on this page
  and in [`zigbee.md`](zigbee.md) about running both radios was measured on a
  512 MB Zero 2 W. A 1 GB board has roughly twice that to work with, so it is
  very likely more comfortable — but "likely" is the honest word, and it is why
  1 GB is grouped with the small boards rather than with the ones that never have
  the question. It is *sized* for its own memory, though: the installer gives a
  1 GB board room to use what it has rather than the ceilings a 512 MB board
  needs.

Any other 64-bit ARM or x86-64 Linux machine works and follows the same memory
rule; the installer prints a warning for Raspberry Pis it does not recognise,
and says nothing for machines that are not Pis at all, where running a home hub
is already a deliberate choice.

## Operating system

The tested operating system is **Raspberry Pi OS Lite (64-bit)**. Debian and
Ubuntu on arm64 work too; they are simply not what we test against.

**Lite is easy to miss, and missing it is the ordinary mistake.** Raspberry Pi
Imager opens on an entry called *Raspberry Pi OS (64-bit)*, marks it
**Recommended**, and keeps Lite one level down under *Raspberry Pi OS (other)*,
where it is called *Raspberry Pi OS Lite (64-bit)* — the two names are one word
apart, and only the second one is without a desktop. The installer says so when
it finds a desktop on a small board, and names the single command that turns it
off; gethome studio says so before the card is written.

The desktop version works as well, and on a 512 MB board it is worth knowing what
it costs: measured at about 75 MB on a Zero 2 W with nothing plugged into its
HDMI — more than the hub's whole Matter support, on the one board that already
has to choose between radios.

**A 32-bit system is refused, even on a 64-bit board.** Writing the 32-bit image
to a perfectly good Zero 2 W or Pi 4 is an easy mistake and an expensive one —
the Pi boots, the install runs for minutes, and only then finds there is nothing
published for it. Both the installer and gethome studio stop first and say that
the *card* needs rewriting, not that the Pi is wrong. The Mac app checks the
card before it writes anything at all.

## Network

**Wi-Fi is fine, and the install turns its power saving off.** A hub is talked
to in bursts — a phone opens the app, the Mac app browses for it, somebody SSHs in —
and 802.11 power save is at its worst exactly there: a dozing radio listens
for broadcasts only when the router signals that there are some, and some
routers get that signalling wrong. The installer turns power saving off on
whichever interface carries the LAN and makes it stay off across reconnects; a
hub on Ethernet is left alone. It costs about 20 mA on a board that is plugged
into the wall.

**The hub also keeps itself known on your network.** Some routers sit on the
broadcasts they owe a device on 2.4 GHz — for seconds, sometimes minutes — while
passing ordinary traffic perfectly. Two things only ever reach a hub by
broadcast: the router finding a hub that has been quiet for a while, and your
phone, which after twenty minutes of silence forgets the hub's hardware address
and asks for it again. The app then says it cannot find a hub that is sitting
there with a full signal, running your automations. So the hub does not wait to
be asked: it announces itself to the router every twenty seconds and keeps every
phone and computer that talks to it up to date by addressing each one directly.
The measurements and the mechanism are in
[`../deploy/CLAUDE.md`](../deploy/CLAUDE.md).

**Give the hub a fixed address while you are in the router** — a DHCP
reservation for its MAC is enough. The apps find it over mDNS and remember the
address they last saw, so a hub that moves is a hub they have to find again.

## The Zigbee coordinator

A USB Zigbee coordinator is what lets the hub pair Zigbee devices — bulbs,
sensors, buttons, the great majority of affordable smart-home hardware.

**If you want one recommendation: the SONOFF ZBDongle-E.** It is the coordinator
this hub is developed against — the stick in the Zero 2 W that the installer,
the detector and the one-radio switch are exercised on — so it is the hardware
that has had the most chances to go wrong here and be fixed.

> **A new ZBDongle-E needs its firmware updated once, and that is not our
> quirk.** It ships running a build older than Zigbee2MQTT supports, so out of
> the box it is found, identified and opened — and then refuses at the last
> step. It takes about a minute and no extra hardware: unplug it, put it in a
> Mac or PC, open SONOFF's flasher at
> <https://dongle.sonoff.tech/sonoff-dongle-flasher/> in Chrome or Edge (Safari
> cannot talk to USB devices), and flash the **Zigbee Coordinator** firmware it
> offers you — it identifies the dongle and picks the current build itself.
> Plug it back in and the hub picks it up on its own.
>
> You do not have to know any of this in advance: the hub recognises this exact
> failure, says so in the install log *and* in `GET /hub`, and gethome studio
> puts the steps and the link on the hub's page. Once updated, it is done for
> good. ([Why, and what the log says](zigbee.md#the-coordinators-own-firmware).)

Beyond that, what the hub can tell you is how *certainly* it will recognise a
stick, and that has three honest levels:

| | Coordinator | Why it's placed here |
|---|---|---|
| **Developed against** | **SONOFF ZBDongle-E** (V2, the CH9102 variant, `1a86:55d4`) | The one we own and install with. |
| **Recognised by a dedicated USB id** | **dresden elektronik ConBee II / III**, **Texas Instruments CC2531 / CC2538** | Their `vendor:product` belongs to a Zigbee coordinator and nothing else, so identifying them never depends on a product string a vendor might reword. |
| **Recognised by name** | **SONOFF** ZBDongle-P, Dongle Plus MG24, Dongle Lite MG21, Dongle Max, Dongle-PP10 · **Home Assistant** SkyConnect, Connect ZBT-1, Connect ZBT-2 · **SMLIGHT** SLZB-06 / 06p7 / 06p10 / 06m, SLZB-07 / 07p7 / 07mg24 · **ZiGate**, **TubesZB**, **ZigStar**, **Electrolama zzh**, **Nordic Zigbee NCP** | They say what they are in their USB product string, and the hub reads it. |

Any of those: plug it in at any time, before or after installing. The hub
identifies it, sets it up and starts Zigbee within seconds, with no reboot and
nothing to re-run ([how detection works](zigbee.md#finding-the-coordinator)).

**That table is about recognition, not about what works.** Anything Zigbee2MQTT
supports works. The difference is that a stick built on a bare USB-serial bridge
(CP210x, CH340, FTDI) with no name of its own cannot be told apart from a 3D
printer or a UPS — so the hub offers it to you instead of adopting it, and
gethome studio lets you pick it. Nothing is lost by declining: you can point the
installer at it later with `--zigbee /dev/serial/by-id/...`.

Both recognised tiers are pinned by `test/deploy-radio.test.ts`, which runs real
device names from `zigbee-herdsman`'s own table — the library Zigbee2MQTT uses to
talk to a coordinator — through the actual detector. That is what stops this list
quietly falling behind as upstream's grows, and it is how the gaps it currently
closes were found.

**Without a coordinator you get Matter, Wi-Fi and MQTT devices only** — no
Zigbee. That is a real limitation rather than a temporary one, so it is worth
deciding before you buy a board.

## One radio or both

A board with 1 GB or less is set up for one radio at a time — a Pi Zero 2 W, a
Pi 3, and the 1 GB version of the Pi 4. The arithmetic that sets the rule is the
smallest board's: 512 MB is not comfortably enough for Matter *and* Zigbee at
once in a full house, since measured the hub is ~120 MB, Matter adds ~60 MB, and
Zigbee2MQTT another ~150 MB on top of the operating system's ~70 MB. So that
board starts with whichever one you are actually using: plug a coordinator in
and it runs Zigbee, leave it out and it runs Matter. Nothing to configure either
way, and the installer says which one you ended up with. You can switch it in the
gethome app at any time — the coordinator stays configured, and Zigbee devices
come back when you switch back (they show as offline meanwhile). **A board with
2 GB or more runs both together and never asks.**

### You can run both radios on a small board, and what that costs

Those figures are for a *full* home, and most homes are nowhere near one. A
Zero 2 W with three Zigbee devices and one Matter plug ran both radios for an
hour with no throttling, no restarts and nothing killed — the hub peaking at
170 MB against its 200 MB ceiling. So **"Run both radios" is an option in the
gethome app on every board**, including this one. What `one` means is
*recommended one at a time*, and the app says so where you turn it on.

**The trap this section exists to prevent**, in one paragraph, because it is the
one way a hub like this goes wrong months after it was set up: you put both
radios on a small board with four devices, everything works, you go on buying
Zigbee devices for a year, and somewhere in there the board stops fitting. You
are not left to discover that in the dark — the hub notices and hands a radio
back with an explanation — but by then the cheap fix, buying a 2 GB board at the
start, is behind you. So decide the *size of the home you are building* now, not
the size it is today.

Before you turn both on, the honest version:

- **What decides it is your Zigbee network, not the board.** Measured over
  seven hours with both radios on a Zero 2 W — one Matter plug, three Zigbee
  devices — the hub settled at 160 MB against its 200 MB ceiling, flat for the
  last six of those hours, and was never once throttled. So a small home is
  comfortable. What uses up the remaining margin is Zigbee2MQTT, which holds
  state for every device you pair: the board that copes with a handful may not
  cope with another twenty.
- **Nobody here can give you the number of devices**, and you should be
  suspicious of anyone who does. What has been measured is four devices for
  seven hours; what has not been measured is twenty, or forty, on this board or
  on a 1 GB one. The honest boundary is the one above: a handful is known to be
  fine, a full house is known not to fit, and everything between them is why the
  hub watches its own memory instead of quoting you a limit.
- **So treat it as a setting to come back to, not one to set and forget.** If you
  already know you want a large Zigbee network alongside Matter, get a board with
  **2 GB or more** — a Pi 5, or a Pi 4 in its 2 GB, 4 GB or 8 GB version. It never
  has the question. Note the memory, not the model: a 1 GB Pi 4 is a one-radio
  board on exactly the same terms as a Zero 2 W.
- **The hub watches for it rather than waiting to be told.** With both radios
  on, it samples the kernel's own memory counters every 30 seconds — how often
  the hub is being throttled at its limit, whether anything has been killed,
  and how much memory is actually free. If the board is in trouble across most
  of a five-minute window, the hub hands a radio back by itself, writes it to
  the activity log and says so in the app. You are told what happened and can
  put it back; what you are not left with is the system choosing which half of
  your house stops working, at night.
- **It catches trouble before anything dies.** The signal it acts on first is
  *throttling* — the kernel holding the hub at its ceiling — which happens long
  before anything is killed. Nothing is lost when it fires, and it warns before
  it acts: there is about a minute and a half in which you can make the choice
  yourself rather than have it made.
- **It gives the radio back.** Turning both on is remembered even while the hub
  is not doing it, so a stand-down parks your choice rather than cancelling it.
  The hub tries again by itself — twice — when the Pi has been restarted, or
  after a week. It cannot *tell* whether both would fit now (the board is no
  longer running the configuration that failed, so there is nothing to
  measure), so each try is exactly that: a try, announced like any other radio
  switch. After the second it stops and says so, and turning it back on
  yourself hands it two more.
- **Two things make the margin thinner**: running the desktop version of
  Raspberry Pi OS (about 75 MB), and a board that has not been restarted since
  the installer switched the kernel's memory accounting back on — until it has,
  the hub cannot see the board running short and cannot hand a radio back. The
  installer says so if either applies to you.
- **A board with 2 GB or more has none of these questions.** If you know you
  want both radios and a large network, that is what to buy — a Pi 5, or a
  Pi 4 in 2 GB or larger. Not "a Pi 4": the 1 GB one is in the same tier as a
  Zero 2 W and gets this whole section.

How the watch works and what it cannot see:
[`zigbee.md`](zigbee.md#running-both-on-a-board-measured-for-one) and
[`zigbee.md`](zigbee.md#the-radio-is-suspended-not-taken-away).
