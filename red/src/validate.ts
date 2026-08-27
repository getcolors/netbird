import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers, registrableDomain } from "package-once-red";
import { onceSsh } from "./once.ts";

export const profilePar = parName("profile");

// Every key desired state must carry.
//
// Two deliberate absences. `vultr-ssh-keys` selects opt-out mode by being
// present, so requiring it would make every conforming keygen deployment
// invalid. `vultr-name` is the Compute Name Standard's optional override: a
// fresh colors.yml that omits it is complete and names the machine after the
// profile. There is likewise no `package` key — §5 removes a key that can hold
// exactly one value.
export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy",
  "netbird-host", "netbird-authentik-host", "netbird-letsencrypt-email",
  "netbird-bootstrap-email", "netbird-bootstrap-name",
  "netbird-authentik-bootstrap-email",
  "netbird-oidc-client-id", "netbird-stun-port", "netbird-log-level",
  "netbird-docker-subnet",
  "netbird-server-image", "netbird-dashboard-image", "netbird-traefik-image",
  "netbird-client-image", "netbird-authentik-image",
  "netbird-authentik-postgres-image", "netbird-authentik-redis-image",
  "netbird-backup-dir", "netbird-backup-r2-bucket", "netbird-backup-r2-endpoint",
  "netbird-backup-r2-region", "netbird-backup-oncalendar",
  "netbird-backup-retention-days",
  "vultr-region", "vultr-plan", "vultr-os-id",
  "vultr-ssh-sources", "vultr-http-sources", "vultr-stun-sources",
  "r2-bucket", "r2-endpoint",
];

export const imageKeys = [
  "netbird-server-image", "netbird-dashboard-image", "netbird-traefik-image",
  "netbird-client-image", "netbird-authentik-image",
  "netbird-authentik-postgres-image", "netbird-authentik-redis-image",
];

const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const emailRe = /^[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// An explicit tag or digest is mandatory. A bare `repository/name` means
// `:latest` by implication and would walk straight past a suffix check for
// ":latest", which is why the shape is required rather than the suffix denied.
const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})$/;
const absPathRe = /^\/[^\s]*$/;
const cidrRe = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
// Vultr labels accept letters, digits, dashes, underscores and periods.
const vultrNameRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const clientIdRe = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function missing(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

// Absent, blank or REPLACE_ME all mean 'use the profile' (Compute Name
// Standard §2: presence is the only switch).
export function placeholder(value: unknown): boolean {
  return missing(value) || String(value).trim() === "REPLACE_ME";
}

// What this deployment calls its machine. The one function that answers it —
// every label, including the firewall's, derives from this and never from the
// raw override key or a second copy of the profile (§3).
export function computeName(opts: Opts): string {
  const override = opts["vultr-name"];
  return placeholder(override)
    ? String(opts.profile ?? "")
    : String(override).trim();
}

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// A fixed address for Traefik on the compose network, derived from the subnet
// rather than configured.
//
// It exists because of hairpin NAT. `netbird-server` must fetch the Authentik
// issuer's discovery document over its **public** URL — the issuer in a token
// has to match the one a browser used — but a container resolving that name
// gets the host's own public address, and the connection times out on the way
// back in. Mapping the name to Traefik's address on the shared network sends
// the request straight to the proxy, which still serves the real certificate
// for it, so TLS and the issuer string both stay honest.
//
// Derived, not a key: a value that can only correctly be `<subnet>.10` is a
// transcription step, and transcription drifts.
export function traefikIp(opts: Opts): string | undefined {
  const base = String(opts["netbird-docker-subnet"] ?? "").split("/")[0] ?? "";
  const octets = base.split(".");
  return octets.length === 4 ? [...octets.slice(0, 3), "10"].join(".") : undefined;
}

// The Cloudflare zone both public names belong to.
export function zone(opts: Opts): string | undefined {
  return registrableDomain(opts["netbird-host"]);
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  if (opts["provider-compute"] !== "vultr") {
    errors.push(":provider-compute must be vultr");
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["local", "s3", "r2"].includes(String(opts["provider-backend"]))) {
    errors.push(":provider-backend must be local, s3, or r2");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  for (const key of ["netbird-host", "netbird-authentik-host"]) {
    const value = opts[key];
    if (!missing(value) && !hostRe.test(String(value))) {
      errors.push(`:${key} must be a fully qualified hostname`);
    }
  }
  // One zone lookup serves both records, so a second name outside it would
  // render a record the DNS stage cannot create.
  if (!missing(opts["netbird-host"]) && !missing(opts["netbird-authentik-host"]) &&
      registrableDomain(opts["netbird-host"]) !== registrableDomain(opts["netbird-authentik-host"])) {
    errors.push(":netbird-authentik-host must share a zone with :netbird-host");
  }
  if (String(opts["netbird-host"]) === String(opts["netbird-authentik-host"])) {
    errors.push(":netbird-authentik-host must differ from :netbird-host");
  }
  for (const key of ["netbird-letsencrypt-email",
                     "netbird-bootstrap-email", "netbird-authentik-bootstrap-email"]) {
    const value = opts[key];
    if (!missing(value) && !emailRe.test(String(value))) {
      errors.push(`:${key} must be an email address`);
    }
  }
  // The two identities live in different NetBird accounts — the local one
  // created by /api/setup, the federated one created by its first Authentik
  // login — and there is no merge between them. One address for both would
  // read as a single identity that can reach both, which nothing provides.
  if (!missing(opts["netbird-authentik-bootstrap-email"]) &&
      String(opts["netbird-authentik-bootstrap-email"]) === String(opts["netbird-bootstrap-email"])) {
    errors.push(":netbird-authentik-bootstrap-email must differ from :netbird-bootstrap-email");
  }
  for (const key of imageKeys) {
    const value = opts[key];
    if (!missing(value) && !imageRe.test(String(value))) {
      errors.push(`:${key} must carry an explicit image tag or digest`);
    }
  }
  // This package owns its templates rather than following an upstream
  // installer, so nothing tells it when a floating tag moved underneath it.
  for (const key of imageKeys) {
    const value = String(opts[key]);
    if (value.endsWith(":latest") || value.endsWith(":main")) {
      errors.push(`:${key} must not track a floating tag; pin the version`);
    }
  }
  if (!(missing(opts["netbird-oidc-client-id"]) ||
        clientIdRe.test(String(opts["netbird-oidc-client-id"])))) {
    errors.push(":netbird-oidc-client-id must be 3-64 characters of letters, digits, dot, dash or underscore");
  }
  const stunPort = opts["netbird-stun-port"];
  if (!(missing(stunPort) ||
        (typeof stunPort === "number" && Number.isInteger(stunPort) &&
         stunPort > 0 && stunPort < 65536))) {
    errors.push(":netbird-stun-port must be a port number");
  }
  if (!(missing(opts["netbird-docker-subnet"]) ||
        cidrRe.test(String(opts["netbird-docker-subnet"])))) {
    errors.push(":netbird-docker-subnet must be a CIDR block");
  }
  if (!(missing(opts["netbird-log-level"]) ||
        ["error", "warn", "info", "debug"].includes(String(opts["netbird-log-level"])))) {
    errors.push(":netbird-log-level must be error, warn, info, or debug");
  }
  if (!(missing(opts["netbird-backup-dir"]) ||
        absPathRe.test(String(opts["netbird-backup-dir"])))) {
    errors.push(":netbird-backup-dir must be an absolute path");
  }
  const retention = opts["netbird-backup-retention-days"];
  if (!(missing(retention) ||
        (typeof retention === "number" && Number.isInteger(retention) && retention > 0))) {
    errors.push(":netbird-backup-retention-days must be a positive integer");
  }
  const osId = opts["vultr-os-id"];
  if (!(missing(osId) || (typeof osId === "number" && Number.isInteger(osId)))) {
    errors.push(":vultr-os-id must be Vultr's numeric operating-system id");
  }
  // The override is validated against the provider's rules rather than
  // passed through unread (Compute Name Standard §2).
  if (!(placeholder(opts["vultr-name"]) ||
        vultrNameRe.test(String(opts["vultr-name"]).trim()))) {
    errors.push(":vultr-name must be letters, digits, dot, dash or underscore");
  }
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return providers["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// What talking to the providers needs, on any real event.
export const providerSecrets = ["vultr-api-key", "cloudflare-api-token"];

// What converging the machine needs, and therefore only a create.
//
// Everything else this deployment holds is generated on the host and never
// supplied: the relay secret, the session cookie key, the store encryption key,
// Authentik's SECRET_KEY and database password, the OIDC client secret, and the
// durable automation credential. The recovery key is the one exception — it is
// operator-supplied precisely because a key generated on the server would be
// lost with the server it protects.
export const applicationSecrets = [
  "netbird-bootstrap-password",
  "netbird-authentik-bootstrap-password",
  "netbird-backup-recovery-key",
  "netbird-backup-r2-access-key-id",
  "netbird-backup-r2-secret-access-key",
];

// Credentials a real event needs. A delete tears down infrastructure; it asks
// for the provider credentials plus the backup pair, because `cleanup.yml`
// takes a final archive on the way out and a delete that cannot back up is a
// delete that cannot be undone. It never asks for the bootstrap passwords —
// demanding the owner's password to destroy a machine would just be a lock on
// the exit.
export function secretErrors(opts: Opts, event: string | undefined): string[] {
  const eventKeys = event === "create"
    ? applicationSecrets
    : event === "delete"
      ? ["netbird-backup-recovery-key",
         "netbird-backup-r2-access-key-id",
         "netbird-backup-r2-secret-access-key"]
      : [];
  const keys = [...new Set([...providerSecrets, ...eventKeys, ...backendSecrets(opts)])];
  return keys.filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return { "vultr-api-key": "VULTR_API_KEY" };
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return providers["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
