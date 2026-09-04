---
name: package-netbird-red
description: Provision and manage a self-hosted NetBird control plane with Authentik as its identity provider on a single Vultr instance, from declarative desired state. Use when asked to deploy, converge, inspect, back up, restore or delete a NetBird zero-trust network, a self-hosted WireGuard control plane, or a NetBird instance with SSO/MFA.
---

# NetBird on Vultr, with Authentik

A Red workflow that turns one `colors.yml` into a running NetBird control
plane: OpenTofu for the instance, its firewall and two Cloudflare records;
Ansible for Traefik, the combined `netbird-server`, the dashboard and Authentik.

## Verbs

```sh
./red build              # render .colors/<profile>/ — no provider calls, no credentials
./red create --dry-run   # walk the workflow, skip every side effect
./red create             # converge for real
./red delete             # guarded; needs a one-run override
```

Exit code 2 is validation or usage failure and lists every problem at once. The
launcher walks up from the working directory to find `colors.yml`.

## Compute provider

`provider-compute: vultr` is the one advertised provider (Compute Provider
Standard); its credential is `COLORS_PAR_VULTR_API_KEY`. Its keys are
`vultr-region`, `vultr-plan`, `vultr-os-id`, and three firewall source lists:
`vultr-ssh-sources` (22, must list at least one CIDR), `vultr-http-sources`
(80 and 443, may be empty for no public HTTP) and `vultr-stun-sources` (the
STUN UDP port, may be empty for no public STUN). Every entry must be a valid
IPv4 or IPv6 CIDR and is refused before any provider call. `vultr-name` and
`vultr-ssh-keys` are optional; see `references/configuration.md`.

Switching `provider-compute` on a profile that already holds a machine is a
rebuild, never an apply: `create` and `delete` refuse with `state holds a
<recorded> machine; set provider-compute back to <recorded> and delete first`,
before any credential is checked.

## Before you converge

- Both hostnames must be free in the Cloudflare zone. The DNS stage creates
  them and never adopts a foreign record.
- Seven credentials must be set in `.envrc.private`; see
  `references/configuration.md`. Never export `COLORS_PAR_PROFILE`.
- `COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY` must be stored somewhere other than
  the host. It decrypts every backup and is deliberately not generated on the
  server.

## Accounts

Convergence creates the account itself, by signing in through Authentik once on
your behalf. There is no manual step.

Two accounts exist. `POST /api/setup` makes a local owner in a local account,
because registering an identity provider needs an authenticated caller. A user
arriving through Authentik gets a separate account, and the two never merge —
so the local owner is **not** a way into the federated network. If Authentik is
lost, restore from backup or register a new identity provider with the local
credential.

## Operating

`netbird-status`, `netbird-backup`, `netbird-restore --verify|--confirm` on the
host.

## Rules

- `colors.yml` is the only file to edit. `.colors/` is generated: never edit it,
  read it as source, or commit it.
- Credentials are `COLORS_PAR_<UPPER_SNAKE_KEY>` variables in the gitignored
  `.envrc.private`, never in `colors.yml` or documentation.
- Never weaken `compute-prevent-destroy` in committed desired state.
- The installed launcher is a copy, not a symlink. After `npx skills update -p`,
  copy `.agents/skills/package-netbird-red/red` over the root `./red`.
