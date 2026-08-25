# Configuration reference

Every key in `colors.yml`. Non-secret values only: credentials are
`COLORS_PAR_*` environment variables in a gitignored `.envrc.private`.

Keys are kebab-case. A key's `COLORS_PAR_` name is its upper-snake form —
`netbird-host` overlays from `COLORS_PAR_NETBIRD_HOST`. **Never export
`COLORS_PAR_PROFILE`**: the profile keys remote state, and overlaying it would
point one deployment at another's. The package refuses to run when it is set.

## Core

| Key | Meaning |
|---|---|
| `profile` | This deployment's identity. Keys remote state as `<profile>/<stage>.tfstate`, names the machine, its firewall, the SSH keypair and the `~/.ssh/config` alias. |
| `workdir` | Where generated output lands. Conventionally `.colors`. |
| `provider-compute` | Must be `vultr`. |
| `provider-dns` | Must be `cloudflare`. |
| `provider-backend` | `local`, `s3` or `r2`. |
| `compute-prevent-destroy` | Keep `true` in committed state. Destruction needs `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one run. |

## NetBird

| Key | Meaning |
|---|---|
| `netbird-host` | Public hostname for the control plane: dashboard, REST API, management and signal gRPC, relay WebSocket and the embedded Dex IdP, all multiplexed behind Traefik on 443. |
| `netbird-authentik-host` | Public hostname for Authentik. Must differ from `netbird-host` and share its registrable domain — one zone lookup serves both records. |
| `netbird-letsencrypt-email` | Contact address for ACME. |
| `netbird-bootstrap-email` | Owner of the *local* account, created through the embedded IdP so that an authenticated caller exists to register the identity provider. Not a way into the federated network. Must differ from `netbird-authentik-bootstrap-email`. |
| `netbird-bootstrap-name` | Display name for that account. |
| `netbird-authentik-bootstrap-email` | Authentik's first administrator (`akadmin`), and the owner of the account this deployment runs — convergence signs in as it once, which is what creates that account. There is no separate owner key: a second key whose only correct value is this address would be a transcription step. |
| `netbird-oidc-client-id` | OAuth2 client id, declared in the Authentik blueprint and handed to NetBird's identity-providers API. Deterministic; the secret beside it is generated per host. |
| `netbird-stun-port` | UDP port for STUN, bundled into `netbird-server`. Conventionally `3478`. The only UDP published. |
| `netbird-log-level` | `error`, `warn`, `info` or `debug`. |
| `netbird-docker-subnet` | CIDR for the compose bridge network. Also what the server trusts as its reverse proxy. |

## Images

One key per service. An explicit tag or `@sha256:` digest is **required** — a
bare `repository/name` means `:latest` by implication and is refused, as are
`:latest` and `:main` suffixes. This package owns its templates rather than
following upstream's installer, so nothing warns you when a floating tag moves.

`netbird-server-image`, `netbird-dashboard-image`, `netbird-client-image`,
`netbird-traefik-image`, `netbird-authentik-image`,
`netbird-authentik-postgres-image`, `netbird-authentik-redis-image`.

Move `netbird-server-image` and `netbird-client-image` together: they are one
release train.

## Backups

| Key | Meaning |
|---|---|
| `netbird-backup-dir` | Absolute path for staging on the host. |
| `netbird-backup-r2-bucket` | Bucket for archives. |
| `netbird-backup-r2-endpoint` | R2 S3 endpoint. |
| `netbird-backup-r2-region` | Conventionally `auto`. |
| `netbird-backup-oncalendar` | systemd `OnCalendar` for the nightly timer. |
| `netbird-backup-retention-days` | Positive integer. Pruning never removes the newest archive. |

## Vultr

| Key | Meaning |
|---|---|
| `vultr-region` | Region code, e.g. `ams`. |
| `vultr-plan` | Plan id. `vc2-4c-8gb` or larger: Authentik alone wants 2 vCPU and 2 GB. |
| `vultr-os-id` | Vultr's numeric OS id. |
| `vultr-ssh-sources` | CIDRs allowed to reach 22. |
| `vultr-http-sources` | CIDRs allowed to reach 80 and 443. |
| `vultr-stun-sources` | CIDRs allowed to reach the STUN port. |
| `vultr-name` | **Optional.** Absent, blank or `REPLACE_ME` names the machine after the profile. Set it only for an account whose naming policy the profile cannot satisfy. |
| `vultr-ssh-keys` | **Optional.** Absent selects keygen mode, where the package generates and owns `~/.ssh/<profile>`. Present switches to opt-out mode, where the package touches no key material at all. |

There is no `package` key: a key that can hold exactly one value carries no
information.

## State backend

`r2-bucket` and `r2-endpoint` when `provider-backend` is `r2`.

## Credentials

Set in `.envrc.private`:

| Variable | Needed for |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | any real event |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | any real event; DNS edit rights on the zone |
| `COLORS_PAR_R2_ACCESS_KEY_ID`, `COLORS_PAR_R2_SECRET_ACCESS_KEY` | the state backend |
| `COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID`, `..._SECRET_ACCESS_KEY` | create and delete |
| `COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY` | create and delete |
| `COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD` | create |
| `COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD` | create |

A `delete` asks for the providers and the backup credentials — it takes a final
archive on the way out — but never for the account passwords. Demanding the
owner's password to destroy a machine would just be a lock on the exit.

Everything else is generated on the host and supplied by nobody: the relay
`authSecret`, the session cookie key, the store encryption key, Authentik's
`SECRET_KEY` and database password, the OIDC client secret, and the durable API
token. The backup recovery key is the deliberate exception — a key generated on
the server would be lost with the server it protects, so **keep it somewhere
else**.
