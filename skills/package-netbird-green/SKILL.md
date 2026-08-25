---
name: package-netbird-green
description: Provision and manage a self-hosted NetBird control plane with Authentik as its identity provider on a single Vultr instance, from declarative desired state. Use when asked to deploy, converge, inspect, back up, restore or delete a NetBird zero-trust network, a self-hosted WireGuard control plane, or a NetBird instance with SSO/MFA.
---

# NetBird on Vultr, with Authentik

A Green workflow that turns one `colors.yml` into a running NetBird control
plane: OpenTofu for the instance, its firewall and two Cloudflare records;
Ansible for Traefik, the combined `netbird-server`, the dashboard and Authentik.

## Verbs

```sh
./green build              # render .colors/<profile>/ — no provider calls, no credentials
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real
./green delete             # guarded; needs a one-run override
```

Exit code 2 is validation or usage failure and lists every problem at once. The
launcher walks up from the working directory to find `colors.yml`.

## Before you converge

- Both hostnames must be free in the Cloudflare zone. The DNS stage creates
  them and never adopts a foreign record.
- Seven credentials must be set in `.envrc.private`; see
  `references/configuration.md`. Never export `COLORS_PAR_PROFILE`.
- `COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY` must be stored somewhere other than
  the host. It decrypts every backup and is deliberately not generated on the
  server.

## After the first converge

Convergence reports one pending manual step. Sign in once at
`https://<netbird-host>/` with the Authentik option as `netbird-owner-email`,
then run `./green create` again — the second run approves that user, promotes
it to owner and asserts the role. NetBird only imports an external user after
it has authenticated once, so this cannot be automated away.

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
  copy `.agents/skills/package-netbird-green/green` over the root `./green`.
