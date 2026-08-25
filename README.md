# netbird

A Green Package Skill that provisions a self-hosted
[NetBird](https://netbird.io) control plane with
[Authentik](https://goauthentik.io) as its identity provider, on one Vultr
instance, from a single `colors.yml`.

OpenTofu manages the instance, its firewall and two unproxied Cloudflare `A`
records. Ansible converges Traefik, the combined `netbird-server` (management,
signal, relay and STUN in one process), the dashboard, and Authentik with its
Postgres and Redis — then bootstraps the first owner, registers Authentik as an
identity provider, and proves two peers can exchange traffic over the relay.

## Install

```sh
npx skills add getcolors/netbird
cp .agents/skills/package-netbird-green/green ./green
chmod +x green
./green build
./green create --dry-run
```

`build` and `--dry-run` work on a fresh checkout with an empty environment and
no credentials. Real creation and deletion require explicit authorization.

## What you get

| | |
|---|---|
| `https://<netbird-host>` | dashboard, REST API, management and signal gRPC, relay WebSocket, embedded Dex IdP |
| `https://<authentik-host>` | Authentik, for SSO and MFA |
| UDP 3478 | STUN, bundled into `netbird-server` |

Everything else binds to loopback. The firewall opens 22, 80 and 443 TCP and
3478 UDP, and nothing more.

## Configuration

Every key is documented in
[`skills/package-netbird-green/references/configuration.md`](skills/package-netbird-green/references/configuration.md).
`colors.yml` in this repository is a complete, commented example.

Credentials are `COLORS_PAR_*` environment variables in a gitignored
`.envrc.private` — never in `colors.yml`. Seven are required; everything else
the deployment needs is generated on the host and supplied by nobody.

## First sign-in

Convergence creates a **break-glass administrator** through NetBird's embedded
IdP and reports one manual step:

1. Open `https://<netbird-host>/` and sign in with the **Authentik** option as
   `netbird-owner-email`.
2. Run `./green create` again.

The second converge approves that user, promotes it to owner and asserts the
role. Until then the break-glass account stays owner and every run says so.
This is the one step that cannot be automated: NetBird only imports an external
user after it has authenticated once, and that login needs a browser.

The break-glass account is deliberately kept afterwards, as an administrator.
It is the way back in when Authentik is unavailable.

## Operating

On the host:

```sh
netbird-status              # containers, certificates, backups, ownership
netbird-backup              # take one now
netbird-restore --verify    # restore into throwaway containers and check it
netbird-restore --confirm   # restore this host for real
```

Backups run nightly, are encrypted before upload, and land under an immutable
timestamped key in R2. **Keep `COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY`
somewhere other than this host** — it is the only thing that decrypts them, and
it is operator-supplied precisely so it does not die with the server.

## Deleting

```sh
COLORS_PAR_COMPUTE_PREVENT_DESTROY=false ./green delete
```

`delete` takes a final backup before tearing down, removes the `~/.ssh/config`
block before the destroy and the machine keypair after it. Never edit the
`compute-prevent-destroy` flag in committed desired state.

## Development

```sh
bb test                  # unit tests
bb golden                # render both fixtures and diff against committed output
bb golden:accept         # regenerate after an intended change — read the diff first
./scripts/launcher.sh    # launcher behaviour
```

Point the launcher at working trees with `NETBIRD_LIB_ROOT`, `GREEN_LIB_ROOT`
and `ONCE_LIB_ROOT`.

See [`CLAUDE.md`](CLAUDE.md) for why this package does not run upstream's
installer, why the bootstrap is a state machine, and what fails silently here.

## Licence

MIT.
