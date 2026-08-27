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

## Signing in

Convergence creates the account for you: it signs in through Authentik once, on
your behalf, driving the real OAuth2 flow rather than asking you to open a
browser. There is no manual step and nothing to approve.

Sign in at `https://<netbird-host>/` with the **Authentik** option, as
`netbird-authentik-bootstrap-email` — that account owns the deployment.

**Two accounts exist, and only one is the network.** `POST /api/setup` creates a
local owner in a local account, because registering an identity provider needs
an authenticated caller and that is the only way to get the first one. A user
arriving through Authentik gets a *separate* account and the two never merge.
The local owner is therefore **not** a way back into the federated network: if
Authentik is unavailable, recover by restoring from backup or by registering a
new identity provider with the local credential.

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
cd green && bb test      # unit tests (canonical Clojure implementation)
cd green && bb golden    # render both fixtures and diff against committed output
cd green && bb golden:accept  # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck   # TypeScript implementation
cd blue && uv run pytest                  # Python implementation
./scripts/parity.sh      # all three colours render byte-identical trees
./scripts/launcher.sh    # launcher behaviour, from the repository root
```

Point the launcher at working trees with `NETBIRD_LIB_ROOT`, `GREEN_LIB_ROOT`
and `ONCE_LIB_ROOT`.

See [`CLAUDE.md`](CLAUDE.md) for why this package does not run upstream's
installer, why the bootstrap is a state machine, and what fails silently here.

## Licence

MIT.
