# Private development, public code

The hub's code is public. The work that produces it — branches, pull requests,
reviews, half-finished experiments, who pushed what and when — is not. Two
repositories:

| Repository | Visibility | What lives there |
|---|---|---|
| `gethome-inc/gethome-hub-dev` | private | Everything. Branches, pull requests, reviews, Dependabot, CI. This is the source of truth. |
| `gethome-inc/gethome-hub` | public | `main`, `v*` tags, the bundles a Pi downloads, and issues from users. Nothing is developed here. |

`main` is mirrored from the private repository to the public one on every merge
(`.github/workflows/mirror.yml`). Nothing else crosses.

## Why the public repository keeps its name

This is the constraint that shapes everything else. Three unauthenticated URLs
hard-code `gethome-inc/gethome-hub`, and they are baked into things already in
the world — README instructions people have copied, SD cards Studio has already
written, hubs running in homes:

- `raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh` —
  the install command in [README.md](../README.md), `gethome-hubctl update`
  (`deploy/gethome-hubctl`), and GetHome Studio's SSH install.
- `github.com/gethome-inc/gethome-hub/releases/download/bundle-<branch>/…` —
  the bundle fetch in `deploy/install.sh`.
- `github.com/gethome-inc/gethome-hub.git` — the clone fallback beside it.

So the public repository keeps its slug, its releases and its issue tracker, and
*development moves somewhere else*. The other direction — making this repository
private and publishing from a new public one — would break all three at once,
including for hardware that is already installed.

## How a change reaches a hub

1. A branch and a pull request in the **private** repository. `ci.yml` runs
   there: typecheck, tests, audit, shellcheck.
2. Merge to private `main`.
3. `mirror.yml` fast-forwards public `main` to that commit.
4. The push into the public repository triggers its `bundle.yml`, which builds
   `linux-arm64` and `linux-x64` and rolls the `bundle-main` prerelease.
5. A Pi installs or updates and downloads that tarball. Nothing on the hub's
   side knows any of the above happened.

A `v*` tag follows the same path: tag private `main`, the mirror pushes the tag,
the public `bundle.yml` publishes an immutable release under it.

## The mirror pushes; it never rewrites

The mirror is a plain fast-forward `git push`. It squashes nothing, rebases
nothing, and forces nothing — and that is a functional requirement, not
tidiness. `bundle.yml` stamps `<version>-<short sha>-<ref>` into `VERSION`,
which names the release directory on the Pi and comes back as `build` in
`GET /hub`. Squashing on the way out would leave every hub in the field
reporting a commit that exists in no public repository, and would break the
`git clone` fallback in `install.sh`, which clones public `main` by name.

**A failed mirror means the public repository has a commit the private one
doesn't.** Usually that is something merged over there — a Dependabot bump, a
contributor's pull request, a direct edit through the web UI. The fix is to
bring it back, never to force:

```sh
git remote add public https://github.com/gethome-inc/gethome-hub.git   # once
git fetch public main
git merge public/main          # or cherry-pick it
git push origin main           # private main; the mirror then fast-forwards
```

Keep the habit of never merging anything in the public repository and this never
happens. If you would rather not hold the credential as a user token, a
write-enabled deploy key on the public repository does the same job over SSH;
the `git push` line in `mirror.yml` is the only thing that changes.

## Testing a branch on real hardware

`install.sh --branch X` looks for a `bundle-X` release, so testing an
*unreleased* branch on a Pi needs that branch's bundle to exist somewhere the Pi
can reach. Two ways, and they trade privacy against effort:

**A hardware-test branch, published publicly.** `bundle.yml` builds any branch
under `hw/**` in either repository. Push `hw/radio-budget` to the *public*
repository and `install.sh --branch hw/radio-budget` works with no credential at
all, exactly like today. The cost is that the branch — name, code and commits —
is public before it is released, so this is for things you don't mind showing.

**A private bundle, fetched with a token.** A push of `hw/**` to the private
repository builds there and publishes to *its* releases. Then:

```sh
curl -fsSL -H "Authorization: Bearer $TOKEN" \
  https://raw.githubusercontent.com/gethome-inc/gethome-hub-dev/hw/radio-budget/deploy/install.sh \
  -o install.sh
bash install.sh --branch hw/radio-budget \
  --repo gethome-inc/gethome-hub-dev --token "$TOKEN"
```

`--repo`/`--token` (or `GETHOME_INSTALL_REPO`/`GETHOME_INSTALL_TOKEN`) exist for
this and nothing else; a public install never passes them. A read-only
fine-grained token on the private repository is enough. `gethome-hubctl update`
takes the same two flags, and **does not remember them** — the hub's own env
file is readable by the service user, so a credential does not go in it. A plain
`gethome-hubctl update` always means public `main`.

One gotcha is worth knowing because it looks like an auth failure and isn't: a
private release asset is **not** reachable at
`releases/download/<tag>/<asset>`. That URL 404s however good the token is.
`fetch_bundle()` in `install.sh` goes through the API instead — once for the
release, to turn the asset's name into a numeric id, then once for
`releases/assets/<id>` with `Accept: application/octet-stream`, which is what
makes the API answer with bytes instead of JSON describing them.

## Setting it up

The migration, in order. Steps 1–3 are GitHub settings; only step 4 is a push.

1. **Rename** `gethome-inc/gethome-hub` to `gethome-hub-dev` and **make it
   private**. Every branch, pull request and review becomes invisible to
   everyone without access, all at once — individual pull requests cannot be
   deleted, and this is the only thing that hides them. The full history,
   including all of it, stays yours.
2. **Create a new public** `gethome-inc/gethome-hub`. GitHub redirects the old
   name until something claims it, which is exactly what this does.
3. **Add the mirror credential** to the private repository as the secret
   `PUBLIC_MIRROR_TOKEN`: a fine-grained token with *Contents: read and write*
   on the public repository only. Without it `mirror.yml` fails and says so.
4. **Push `main`** — either by merging anything, or by running the *Mirror to
   public* workflow by hand from `main`. The public `bundle.yml` then builds and
   `bundle-main` exists again.

Then, in the **public** repository's settings:

- **Turn off Dependabot version updates.** `.github/dependabot.yml` is in the
  shared tree, so it is live over there too, and its pull requests are both
  noise on the public face of the project and a way for public `main` to drift
  ahead of private `main` and break the mirror. Version updates belong in the
  private repository, where the pull requests are. Close any that appear;
  merging one is what actually costs you.
- **Protect `main`**: no force pushes, no deletions. The mirror only ever
  fast-forwards, so nothing it does needs either.
- Leave **issues** on. They are the public front door, and the reason to have a
  public repository people can talk in at all.

Between step 1 and step 4 there is no `bundle-main` in the public repository. An
install in that window falls back to building from source on a machine with more
than 1 GB of memory, and on a smaller board stops with the message naming the
workflow to wait for. It is a few minutes; do it when nobody is installing.

## What this costs

Worth knowing before committing to it, because none of it is hypothetical:

- **Actions minutes.** Public repositories run free; private ones bill. That is
  why `bundle.yml` skips `main` and `v*` in the private repository — those
  builds are the mirror's job, on the public side — and why dev bundles are
  opt-in per branch rather than one per push, as they used to be. `ci.yml` is
  cheap and runs on both.
- **Contributions get more expensive.** An outside pull request arrives against
  public `main`, where nothing is developed. Merging it there breaks the mirror,
  so it has to be fetched into the private repository and merged from that side.
  With no forks today this is free; it is the real tax of this model.
- **The private repository is not a safe place for secrets.** Everything on its
  `main` is published minutes later. The rule in
  [CLAUDE.md](../CLAUDE.md) — never commit secrets, keys or non-public ecosystem
  details — applies to the private tree exactly as it did to the public one.
- **What was already public stays public.** Making the repository private hides
  its pull requests on GitHub, but public activity that has already happened
  (titles, authorship) has been recorded by third parties that mirror GitHub's
  event stream. This changes what happens from now on; it does not unpublish the
  past.
