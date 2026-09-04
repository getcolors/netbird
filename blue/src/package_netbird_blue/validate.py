"""Validation over desired state, the port of io.github.getcolors.netbird.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue import compute as once_compute
from package_once_blue import ssh as once_ssh
from package_once_blue.utils import registrable_domain
from package_once_blue.validate import providers as once_providers

profile_par = par_name("profile")

# provider-compute -> what that choice implies.
#
# `required` are the non-secret keys that provider's template interpolates,
# `secrets` the credentials it needs through COLORS_PAR_*, and `tofu-env` the
# subset OpenTofu reads from the process environment itself. Keeping the three
# together is what stops a provider being validated against one set of keys and
# run with another — a stage exporting a credential nobody checked for, or a
# check demanding a key no template uses. The keys of this map are the
# advertised providers; a provider without a template directory and a golden
# is not advertised, and this package advertises one.
#
# Two keys the template reads are deliberately not required. `vultr-name` is
# an optional override of the profile (Compute Name Standard), and
# `vultr-ssh-keys` is meaningful by its absence (SSH Keypair Standard). The
# third source list, `vultr-stun-sources`, is this package's extension of the
# standard's two: STUN is the one UDP port it publishes.
compute_providers = {
    "vultr": {
        "required": ["vultr-region", "vultr-plan", "vultr-os-id",
                     "vultr-ssh-sources", "vultr-http-sources", "vultr-stun-sources"],
        "secrets": ["vultr-api-key"],
        "tofu-env": {"vultr-api-key": "VULTR_API_KEY"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running: the only one it ever offered.
default_compute_provider = "vultr"

# How this package describes itself to ONCE's `compute`, the Compute Provider
# Standard's operations over a package-owned registry. The registry and the
# default are the data above; `sources` names the firewall lists the template
# reads — SSH must list at least one CIDR; an empty HTTP list means no public
# HTTP and an empty STUN list no public STUN. The name rules are ONCE's.
spec: once_compute.ComputeSpec = {
    "registry": compute_providers,
    "default": default_compute_provider,
    "sources": {"non_empty": ["ssh-sources"], "may_be_empty": ["http-sources", "stun-sources"]},
}

# Every key desired state must carry whichever provider is selected. The
# provider-scoped keys come from `compute_providers`.
#
# There is no `package` key — Compute Name Standard §5 removes a key that can
# hold exactly one value.
required = [
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
    "r2-bucket", "r2-endpoint",
]

image_keys = [
    "netbird-server-image", "netbird-dashboard-image", "netbird-traefik-image",
    "netbird-client-image", "netbird-authentik-image",
    "netbird-authentik-postgres-image", "netbird-authentik-redis-image",
]

host_re = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
email_re = re.compile(r"[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
# An explicit tag or digest is mandatory. A bare `repository/name` means
# `:latest` by implication and would walk straight past a suffix check for
# ":latest", which is why the shape is required rather than the suffix denied.
image_re = re.compile(r"[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})")
abs_path_re = re.compile(r"/[^\s]*")
# The compose bridge subnet is a package key, not a firewall source, so its
# shape is this package's to check.
cidr_re = re.compile(r"(?:\d{1,3}\.){3}\d{1,3}/\d{1,2}")
client_id_re = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,63}")


def _s(value) -> str:
    """Clojure's `str`: nil renders empty, booleans lowercase."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def missing(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


# `<provider>-<suffix>`: desired state names compute keys after the provider,
# so the shared steps reach them through the selected provider rather than a
# fixed prefix. ONCE's; named here so `tools` reads the same.
compute_key = once_compute.compute_key

# What this deployment calls its machine: `vultr-name` when present and not a
# placeholder, else the profile (Compute Name Standard). ONCE's; every label,
# including the firewall's, derives from this one answer and never from the
# raw override key or a second copy of the profile (§3).
compute_name = once_compute.compute_name


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


# A source list as desired state or an overlay string carries it. ONCE's, so
# the validator and the template can never disagree about what an entry is.
cidrs = once_compute.cidrs


def traefik_ip(opts: dict) -> str | None:
    """A fixed address for Traefik on the compose network, derived from the
    subnet rather than configured.

    It exists because of hairpin NAT. `netbird-server` must fetch the Authentik
    issuer's discovery document over its **public** URL — the issuer in a token
    has to match the one a browser used — but a container resolving that name
    gets the host's own public address, and the connection times out on the way
    back in. Mapping the name to Traefik's address on the shared network sends
    the request straight to the proxy, which still serves the real certificate
    for it, so TLS and the issuer string both stay honest.

    Derived, not a key: a value that can only correctly be `<subnet>.10` is a
    transcription step, and transcription drifts."""
    base = _s(opts.get("netbird-docker-subnet")).split("/")[0]
    octets = base.split(".")
    if len(octets) != 4:
        return None
    return ".".join([*octets[:3], "10"])


def zone(opts: dict) -> str | None:
    """The Cloudflare zone both public names belong to."""
    return registrable_domain(opts.get("netbird-host"))


def env_errors(env: dict) -> list[str]:
    if _s(env.get(profile_par)):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


def state_errors(opts: dict) -> list[str]:
    """Every problem with desired state at once: the missing keys (this
    package's and the selected provider's), the package's own checks, then the
    Compute Provider Standard's — selection, the network contract over all
    three source lists, and the provider rules including the resolved machine
    name — which are ONCE's over `spec`."""
    errors: list[str] = []
    errors += [f":{k} is required"
               for k in [*required, *once_compute.required_keys(spec, opts)]
               if missing(opts.get(k))]
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    for k in ["netbird-host", "netbird-authentik-host"]:
        v = opts.get(k)
        if not missing(v) and not host_re.fullmatch(_s(v)):
            errors.append(f":{k} must be a fully qualified hostname")
    # One zone lookup serves both records, so a second name outside it would
    # render a record the DNS stage cannot create.
    if (not missing(opts.get("netbird-host"))
            and not missing(opts.get("netbird-authentik-host"))
            and registrable_domain(opts.get("netbird-host"))
            != registrable_domain(opts.get("netbird-authentik-host"))):
        errors.append(":netbird-authentik-host must share a zone with :netbird-host")
    if _s(opts.get("netbird-host")) == _s(opts.get("netbird-authentik-host")):
        errors.append(":netbird-authentik-host must differ from :netbird-host")
    for k in ["netbird-letsencrypt-email",
              "netbird-bootstrap-email", "netbird-authentik-bootstrap-email"]:
        v = opts.get(k)
        if not missing(v) and not email_re.fullmatch(_s(v)):
            errors.append(f":{k} must be an email address")
    # The two identities live in different NetBird accounts — the local one
    # created by /api/setup, the federated one created by its first Authentik
    # login — and there is no merge between them. One address for both would
    # read as a single identity that can reach both, which nothing provides.
    if (not missing(opts.get("netbird-authentik-bootstrap-email"))
            and _s(opts.get("netbird-authentik-bootstrap-email"))
            == _s(opts.get("netbird-bootstrap-email"))):
        errors.append(":netbird-authentik-bootstrap-email must differ from :netbird-bootstrap-email")
    for k in image_keys:
        v = opts.get(k)
        if not missing(v) and not image_re.fullmatch(_s(v)):
            errors.append(f":{k} must carry an explicit image tag or digest")
    # This package owns its templates rather than following an upstream
    # installer, so nothing tells it when a floating tag moved underneath it.
    for k in image_keys:
        v = _s(opts.get(k))
        if v.endswith(":latest") or v.endswith(":main"):
            errors.append(f":{k} must not track a floating tag; pin the version")
    if not (missing(opts.get("netbird-oidc-client-id"))
            or client_id_re.fullmatch(_s(opts.get("netbird-oidc-client-id")))):
        errors.append(":netbird-oidc-client-id must be 3-64 characters of letters, digits, dot, dash or underscore")
    stun = opts.get("netbird-stun-port")
    if not (missing(stun)
            or (isinstance(stun, int) and not isinstance(stun, bool) and 0 < stun < 65536)):
        errors.append(":netbird-stun-port must be a port number")
    if not (missing(opts.get("netbird-docker-subnet"))
            or cidr_re.fullmatch(_s(opts.get("netbird-docker-subnet")))):
        errors.append(":netbird-docker-subnet must be a CIDR block")
    if not (missing(opts.get("netbird-log-level"))
            or _s(opts.get("netbird-log-level")) in ("error", "warn", "info", "debug")):
        errors.append(":netbird-log-level must be error, warn, info, or debug")
    if not (missing(opts.get("netbird-backup-dir"))
            or abs_path_re.fullmatch(_s(opts.get("netbird-backup-dir")))):
        errors.append(":netbird-backup-dir must be an absolute path")
    retention = opts.get("netbird-backup-retention-days")
    if not (missing(retention)
            or (isinstance(retention, int) and not isinstance(retention, bool) and retention > 0)):
        errors.append(":netbird-backup-retention-days must be a positive integer")
    errors += once_compute.state_errors(spec, opts)
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
    return entry.get("secrets", [])


def provider_secrets(opts: dict) -> list[str]:
    """What talking to the providers needs, on any real event: the selected
    compute provider's credential, from the registry, and Cloudflare's."""
    return [*once_compute.secrets(spec, opts), "cloudflare-api-token"]


# What converging the machine needs, and therefore only a create.
#
# Everything else this deployment holds is generated on the host and never
# supplied: the relay secret, the session cookie key, the store encryption key,
# Authentik's SECRET_KEY and database password, the OIDC client secret, and the
# durable automation credential. The recovery key is the one exception — it is
# operator-supplied precisely because a key generated on the server would be
# lost with the server it protects.
application_secrets = [
    "netbird-bootstrap-password",
    "netbird-authentik-bootstrap-password",
    "netbird-backup-recovery-key",
    "netbird-backup-r2-access-key-id",
    "netbird-backup-r2-secret-access-key",
]


def secret_errors(opts: dict, event: str | None) -> list[str]:
    """Credentials a real event needs. A delete tears down infrastructure; it
    asks for the provider credentials plus the backup pair, because
    `cleanup.yml` takes a final archive on the way out and a delete that cannot
    back up is a delete that cannot be undone. It never asks for the bootstrap
    passwords — demanding the owner's password to destroy a machine would just
    be a lock on the exit."""
    per_event = {
        "create": application_secrets,
        "delete": ["netbird-backup-recovery-key",
                   "netbird-backup-r2-access-key-id",
                   "netbird-backup-r2-secret-access-key"],
    }.get(event, [])
    keys = [*provider_secrets(opts), *per_event, *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(k)}"
            for k in dict.fromkeys(keys) if missing(opts.get(k))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return once_compute.tofu_env(spec, opts)
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
        return entry.get("tofu-env", {})
    return {}
