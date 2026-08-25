# CLAUDE.md

## Repository

`netbird` is a Green-only Package Skill for a self-hosted [NetBird](https://netbird.io)
control plane with [Authentik](https://goauthentik.io) as its identity
provider, on one Vultr instance. OpenTofu manages the instance, a firewall
(22/80/443 TCP and 3478 UDP) and two unproxied Cloudflare `A` records; Ansible
converges a Docker Compose stack of Traefik, the combined `netbird-server`, the
dashboard, and Authentik with its Postgres and Redis. The first consumer is
`../netbird-vultr`.

The sources this package is derived from are a netbird.io knowledge-hub article
and its companion video, both of which drive an interactive wizard and then
click through two web UIs. Everything below exists because a converged
deployment cannot do that.

## Why this package does not run `getting-started.sh`

Upstream's installer is an interactive wizard: it asks for the domain, the
reverse proxy, a Let's Encrypt address and whether to enable the proxy service,
then generates its own `docker-compose.yml` and `config.yaml`.

That is the same shape as `colors.yml` → `.colors/`, and running both would
mean two generators for one deployment, with the authoritative one being
whichever ran last. So the templates here are derived from what that script
generates — the **combined** architecture, one `netbird-server` process that is
management, signal, relay and STUN — and maintained as this package's own, with
image tags lifted into desired state.

The cost is real and was accepted deliberately: when upstream changes the
script, nothing here follows automatically. Re-read
`https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh`
when bumping `netbird-server-image`.

Note the architecture split, because the upstream *documentation* still
describes both. Separate `management`/`signal`/`relay`/`coturn` containers
driven by `management.json`, and the `NETBIRD_AUTH_*` keys in a `setup.env`,
are the **older** shape. This package implements the combined one. A guide that
mentions `management.json` is not describing this stack.

## Why there is no coturn container

STUN is bundled into `netbird-server` (`server.stunPorts`), which is why the
firewall opens exactly one UDP port and no 49152–65535 relay range. Relayed
traffic rides the WebSocket on 443. If you find yourself adding a TURN shared
secret, you are implementing the legacy topology.

## Why the bootstrap is a state machine

An external IdP cannot be configured at first boot: NetBird needs an
authenticated caller to accept one, and the only headless way to get the first
owner is `POST /api/setup`, which works exactly once and requires
`NB_SETUP_PAT_ENABLED=true`. So `bootstrap.sh` is a sequence of steps each
guarded by observed state, which is what lets a one-way initialisation live
inside desired state and be run twice with no effect.

Two parts of it are load-bearing:

- **The setup PAT is exchanged immediately.** It is short-lived and cannot be
  reissued once setup is complete, so a converge after its expiry would have no
  credential at all. The first act after bootstrap is to create a durable,
  rotatable token, persist it `0600`, and destroy the setup PAT. It is never
  written to disk and never reaches a backup.
- **Ownership transfer waits for a human, and completes by itself.** Configuring
  the IdP does not create the Authentik user; NetBird imports it the first time
  it authenticates, and that login lands in "pending approval". So the step is
  written as a condition: if the user is absent, the play reports a pending
  manual step and exits zero; the next converge approves it, promotes it and
  asserts the role. Promotion *transfers* ownership rather than adding a second
  owner, which is why the break-glass account is expected to end up an
  administrator.

The break-glass account is deliberately kept. It authenticates against the
embedded Dex IdP, which is the only way back in when Authentik is down —
exactly when an Authentik-only account is no use.

## Why Authentik is exposed through Traefik

The sources sidecar a NetBird client into Authentik's Docker network, register
a network resource, choose a routing peer and add a reverse-proxy service, all
by hand. That needs a setup key which only exists after a human has logged in,
and it is circular: NetBird's auth callbacks depend on Authentik, which is
reachable only through NetBird. The sources themselves document that
circularity as a lockout.

Traefik is already in the stack, so Authentik gets its own name and a router.
This is a choice of availability and simplicity over isolation, not a security
win — an IdP a browser must reach is a public URL either way — so it carries
obligations the compose file implements: rate limiting, hardened headers, and
no admin or backend port published.

## What fails silently here

Convergence asks components what they actually have, because each of these
looks like success:

- Traefik answers 443 with a **self-signed default certificate** when ACME has
  failed, so a reachable HTTPS endpoint is not a working one. Acceptance
  validates the chain through the system trust store, checks the certificate
  names the host, and checks expiry — never by matching "Let's Encrypt" in the
  issuer, which breaks when a chain is renamed.
- Authentik applies blueprints **asynchronously in the worker**, so a healthy
  container can serve no OAuth2 provider at all. The play polls for the object.
- The **device-code grant is a separate flow** from the browser's authorization
  code and is absent unless declared and assigned as the brand default. A
  working dashboard login is no evidence it exists, so `netbird-smoke` asks for
  a grant.
- A healthy control plane proves nothing about the **data plane**.
  `netbird-smoke` enrols two throwaway peers on separate Docker networks — so a
  direct path is impossible by construction — and asserts traffic flows and that
  the peer's own diagnostics report it as relayed.
- `bind to loopback` regresses silently, so acceptance asserts from outside that
  Postgres, Redis, Authentik's 9000 and the server's internal ports **refuse**
  connections.

## Secrets

Five operator credentials reach the host, and none may be rendered. They appear
in `main.yml` as literal `{{ lookup('env','COLORS_PAR_...') }}` expressions,
which `preserve-jinja-delimiters` passes through untouched; Ansible resolves
them at execution time. Routing them through the Selmer data map instead would
HTML-escape the quotes and hand Ansible `&#39;`. `scripts/golden.sh` fails if
those expressions stop appearing.

Everything else is generated on the host and create-once, guarded by
`creates:`: the relay `authSecret`, the session cookie key, the store
encryption key, Authentik's `SECRET_KEY` and database password, the OIDC client
secret, and the durable token. Regenerating any of them breaks a working
deployment while every container stays green — a new store key orphans the peer
database, a new `SECRET_KEY` invalidates every session. The three server
secrets are substituted into `config.yaml` **on the host**; what `build`
renders, and what the goldens commit, are the `__PLACEHOLDER__` forms, and
`scripts/golden.sh` fails if a real value ever appears there.

The backup recovery key is the deliberate exception: operator-supplied, because
a key generated on the server would be lost with the server it protects.

## Backups

The archive is the whole restore set — the peer store, Authentik's database,
the generated secrets, Traefik's ACME state — so it carries this deployment's
crown jewels and is encrypted with GPG symmetric AES-256 before it leaves the
host. R2 access control is not the protection.

SQLite is snapshotted with `.backup`, or the server is stopped around a file
copy; a live `cp` of an active database restores into one that opens and then
fails. Uploads go to an immutable timestamped key and are verified before a
`latest-known-good` pointer advances, so a truncated upload can never become
the newest backup. `netbird-restore --verify` restores into throwaway
containers and checks integrity without touching the host.

## The SSH keypair and `~/.ssh/config`

This package is born conforming to both workspace standards. Read
`../workspace/standards/ssh-keypair.md` before touching `ssh.clj` and
`../workspace/standards/ssh-config.md` before touching `ssh_config.clj`.

The keypair behaviour is ONCE's (`io.github.getcolors.once.ssh`), deliberately
reused so one standard has one implementation. The `~/.ssh/config` block is
this package's own copy, per the config standard §7. The two disagree on
ordering on purpose — the config block is removed *before* the compute destroy,
the keypair *after* it.

`build` and `--dry-run` render `/home/build-placeholder/.ssh/<profile>` rather
than reading `~/.ssh`, which is what makes the committed goldens mean the same
thing on every workstation. `bb golden` renders two fixtures because the
keypair standard has two modes; a change that only holds in one is not
conforming.

## The Compute Name Standard

This package is also born conforming to `../workspace/standards/compute-name.md`:
there is **no required `vultr-name`** and **no `package` key**. The machine, its
firewall and every derived label come from `validate/compute-name`, which
returns the profile unless an optional `vultr-name` override is present and
valid. Templates never branch on whether the override was supplied.

## Commands

```sh
bb test
bb golden
bb golden:accept
./scripts/launcher.sh
./green build
./green create --dry-run
./green create                 # requires explicit authorization
./green delete                 # guarded and destructive
```

On the host: `netbird-status`, `netbird-backup`, `netbird-restore --verify`.

Never read `.envrc.private`, edit `.colors/`, export `COLORS_PAR_PROFILE`, or
weaken `compute-prevent-destroy`. Build and dry-run are credential-free and
must not touch `~/.ssh`.

## Coupling

The package pins Green and ONCE in `deps.edn`. ONCE supplies the backend
provider registry, the registrable-domain helper, and the whole SSH keypair
implementation — so the ONCE pin can never go below `bc06f2f`, the commit that
moved the machine keypair into the operator's `~/.ssh`. Use `GREEN_LIB_ROOT`,
`ONCE_LIB_ROOT`, and `NETBIRD_LIB_ROOT` for working-tree development. Final
launchers use a pushed SHA managed by `bb pin`; deployment launchers are
copies, not symlinks.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
