"""The steps and every template spec, the port of io.github.getcolors.netbird.tools."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec
from package_once_blue import compute as once_compute

from . import ssh_config, validate

infrastructure_tool = "netbird-infrastructure"
dns_tool = "netbird-dns"
ansible_tool = "netbird-ansible"
ansible_local_tool = "netbird-ansible-local"
ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="netbird")


def template(path: str, file: str) -> dict:
    """A template from the tree this colour carries, keyed the way green names
    its classpath resources: dots in `path` are directories."""
    name = f"tools/{path.replace('.', '/')}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


# The source lists as validate parses them, so the template and the
# validator can never disagree about what an entry is.
cidrs = validate.cidrs


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        merged.update(validate.tofu_env(opts, slot))
    result = {}
    for key, env_var in merged.items():
        value = "" if opts.get(key) is None else str(opts.get(key))
        if value:
            result[env_var] = value
    return result or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


# What `build` and `--dry-run` render in place of a compute output: the
# documentation address, shaped like the selected provider's real `params` so
# every later stage sees the same keys either way. ONCE's.
fallback_params = once_compute.fallback_params

# Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute output
# carries no `ip`. ONCE's; `infrastructure_step` is what wires it.
resolved_compute = once_compute.resolved_compute


# ---------------------------------------------------------------- compute


def infrastructure_data(opts: dict) -> dict:
    """Template values for the compute stage. The name and the three source
    lists are resolved here once, so a template interpolates values and never
    branches on which provider it belongs to."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "compute-name": validate.compute_name(opts),
            "ssh-sources-hcl": tofu.hcl_list(
                cidrs(opts, validate.compute_key(opts, "ssh-sources"))),
            "http-sources-hcl": tofu.hcl_list(
                cidrs(opts, validate.compute_key(opts, "http-sources"))),
            "stun-sources-hcl": tofu.hcl_list(
                cidrs(opts, validate.compute_key(opts, "stun-sources")))}


def infrastructure_template(opts: dict) -> dict:
    """Providers are selected by template directory,
    `infrastructure/<provider>/`, not by conditionals inside one file; the
    rendered target is the same `main.tf` whichever directory it came from."""
    return template(f"infrastructure.{opts.get('provider-compute')}", "main.tf")


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    specs = [spec(infrastructure_template(opts), f"{dir}/main.tf",
                  infrastructure_data(opts))]
    result = await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return resolved_compute(result, fallback_params(opts), once_compute.output_params(result))


# -------------------------------------------------------------------- dns


def dns_json(opts: dict) -> str:
    """Two explicit records, both unproxied.

    Unproxied because Cloudflare's proxy is an HTTP proxy: UDP STUN on 3478
    does not survive it, and TLS-ALPN-01 — which is how these certificates are
    issued — terminates at the proxy rather than at Traefik. `signoz` proxies
    its single record; this deployment cannot.

    Two explicit names rather than a wildcard. The upstream article needs a
    wildcard because it exposes services through NetBird's own reverse proxy;
    this package routes Authentik with Traefik directly, so nothing resolves
    under the wildcard and publishing one would only widen the surface a future
    catch-all router could serve."""
    return tofu.constructs_json([
        tofu.construct("resource", "cloudflare_dns_record", "netbird",
                       {"zone_id": "${data.cloudflare_zone.zone.id}",
                        "name": opts.get("netbird-host"),
                        "content": opts.get("ip"), "type": "A",
                        "proxied": False, "ttl": 60}),
        tofu.construct("resource", "cloudflare_dns_record", "authentik",
                       {"zone_id": "${data.cloudflare_zone.zone.id}",
                        "name": opts.get("netbird-authentik-host"),
                        "content": opts.get("ip"), "type": "A",
                        "proxied": False, "ttl": 60})])


async def dns_step(opts: dict) -> dict:
    dir = tool_dir(opts, dns_tool)
    data = {**opts,
            "ip": opts.get("ip") or fallback_params(opts)["ip"],
            "netbird-zone": validate.zone(opts)}
    specs = [spec(template("dns", "main.tf"), f"{dir}/main.tf", data),
             raw_spec(f"{dir}/record.tf.json", dns_json(data))]
    return await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-dns"))


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------- ansible


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    return json.dumps(value)


def inventory(opts: dict) -> str:
    return _pretty(
        {"all": {"children": {"netbird": {"hosts": {
            opts.get("profile"): {"ansible_host": opts.get("ip") or "192.0.2.10",
                                  "ansible_user": "root"}}}}}})


def ansible_data(opts: dict) -> dict:
    """Template values for the Ansible stage.

    Deliberately carries none of the operator secrets. They reach the host as
    Ansible `lookup('env', ...)` expressions written literally into main.yml,
    where `preserve-jinja-delimiters` passes them through untouched — routing
    them through this map instead would let the renderer HTML-escape the quotes
    and hand Ansible `&#39;`. The secret therefore exists only in the process
    that needs it: not in `.colors/`, not in a golden, not in this map."""
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "traefik-ip": validate.traefik_ip(opts),
            "ssh-keygen": validate.keygen(opts)}


ANSIBLE_FILES = [
    "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml", "config.yaml",
    "dashboard.env", "blueprint.yaml", "bootstrap.sh", "federated-login.py",
    "smoke.sh", "s3.py", "backup.sh", "restore.sh", "status.sh",
    "backup.service", "backup-failure.service", "backup.timer",
]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [*[spec(template("ansible", name), f"{dir}/{name}", data)
              for name in ANSIBLE_FILES],
            raw_spec(f"{dir}/inventory.json", inventory(data))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("ip"):
        # No compute in state: there is no host to stop, and the cleanup play
        # would only fail against the placeholder address.
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "main.yml", "delete": "cleanup.yml"},
        host_key_checking=False)


# ------------------------------------------------------------- acceptance


async def wait_for(args: list[str], attempts: int) -> bool:
    """True once `args` exits zero, retrying every five seconds."""
    n = attempts
    while True:
        result = await runtime.exec(args, timeout_ms=20000)
        if result.exit == 0:
            return True
        if n > 0:
            await asyncio.sleep(5)
            n -= 1
        else:
            return False


async def run(args: list[str]):
    return await runtime.exec(args, timeout_ms=20000)


async def out(args: list[str]) -> str:
    return str((await run(args)).out or "").strip()


async def cert_error(host: str) -> str | None:
    """Why the certificate for `host` is not acceptable, or None when it is.

    Traefik answers 443 with a self-signed default certificate when ACME has
    failed, so a reachable HTTPS endpoint proves nothing on its own. Three
    separate facts are checked: the chain validates against the system trust
    store (`curl` without `-k` fails otherwise), the certificate names this
    host, and it is not about to expire. Matching the issuer string against
    "Let's Encrypt" would be the brittle version — chains get renamed, and a
    renamed chain is not an outage."""
    s_client = (f"echo | openssl s_client -servername {host}"
                f" -connect {host}:443 2>/dev/null")
    if (await run(["curl", "-fsS", "-o", "/dev/null", f"https://{host}/"])).exit != 0:
        return (f"the certificate for {host} is not trusted by the system store; Traefik is "
                "probably serving its self-signed default because ACME failed")
    san = await out(["sh", "-c", f"{s_client} | openssl x509 -noout -ext subjectAltName"])
    if host not in san:
        return f"the certificate served for {host} does not name it"
    if (await run(["sh", "-c", f"{s_client} | openssl x509 -noout -checkend 604800"])).exit != 0:
        return f"the certificate for {host} expires within seven days and has not renewed"
    return None


async def closed(host: str, port: int) -> bool:
    """Whether a TCP port refuses a connection from out here. `bind to
    loopback` regresses silently while every positive check still passes, so
    absence is asserted rather than assumed."""
    result = await run(["sh", "-c",
                        f"timeout 5 bash -c '</dev/tcp/{host}/{port}' 2>/dev/null"])
    return result.exit != 0


async def acceptance_step(opts: dict) -> dict:
    """Public health checks after a real create.

    What runs here is what the internet can see. The end-to-end proofs that
    need the host's own credentials — the device-code grant, two peers
    exchanging traffic over the relay — run inside the playbook, where the
    durable PAT lives."""
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    host = opts.get("netbird-host")
    authentik = opts.get("netbird-authentik-host")
    ip = opts.get("ip")
    if not await wait_for(["curl", "-fsS", "-o", "/dev/null", f"https://{host}/"], 60):
        return {**opts, "blue/exit": 1,
                "blue/err": "the NetBird dashboard did not become reachable over HTTPS"}
    cert_errors = [e for e in [await cert_error(h) for h in (host, authentik)] if e]
    # The dashboard substitutes its configuration into the built assets at
    # container start, and the script that does it exits non-zero on a missing
    # variable while supervisord carries on. nginx then serves the placeholders
    # verbatim and every request for `/` still returns 200 — so the page has to
    # be read, not merely fetched. This shipped once already.
    page = await out(["curl", "-fsS", f"https://{host}/"])
    chunks = list(dict.fromkeys(
        re.findall(r"/_next/static/chunks/[A-Za-z0-9_.\-]+\.js", page)))[:6]
    unsubstituted = None
    for url in chunks:
        if "$NETBIRD_" in await out(["curl", "-fsS", f"https://{host}{url}"]):
            unsubstituted = url
            break
    disco = await out(["curl", "-fsS",
                       f"https://{authentik}/application/o/netbird/.well-known/openid-configuration"])
    # Ports that must not be open from outside. Postgres, Redis and Authentik's
    # own 9000 are reachable only on the compose network; the article opens
    # 9000 for first-run setup, and this package never does.
    open_ports = [p for p in [5432, 6379, 9000, 9090, 8080] if not await closed(ip, p)]
    if cert_errors:
        return {**opts, "blue/exit": 1, "blue/err": "; ".join(cert_errors)}
    if unsubstituted:
        return {**opts, "blue/exit": 1,
                "blue/err": (f"the dashboard is serving unsubstituted configuration in "
                             f"{unsubstituted}; init_react_envs failed at container start "
                             "(a missing variable makes it exit 1 while nginx keeps serving)")}
    if "device_authorization_endpoint" not in disco:
        return {**opts, "blue/exit": 1,
                "blue/err": ("the Authentik issuer does not advertise a device "
                             "authorization endpoint; CLI enrolment would fail")}
    if open_ports:
        return {**opts, "blue/exit": 1,
                "blue/err": ("ports that must not be public answered: "
                             + ", ".join(str(p) for p in open_ports))}
    return {**opts, "blue/exit": 0,
            "netbird/acceptance": {"dashboard": "configured",
                                   "certificates": "trusted",
                                   "oidc": "complete",
                                   "closed-ports": "confirmed"}}
