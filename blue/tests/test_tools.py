from conftest import fixture, optout
from package_netbird_blue import tools, validate


def spec_for(opts, file):
    return next(s for s in tools.ansible_specs(opts)
                if str(s["target"]).endswith(file))


def resource(path):
    return (tools.ROOT / path).read_text()


def test_firewall_sources_parse():
    data = tools.infrastructure_data(fixture())
    assert tools.cidrs(data, "vultr-http-sources") == ["0.0.0.0/0"]
    assert tools.cidrs(data, "vultr-stun-sources") == ["0.0.0.0/0"]


def test_infrastructure_data_carries_the_ssh_mode():
    assert tools.infrastructure_data(fixture())["ssh-keygen"] is True
    assert tools.infrastructure_data(optout())["ssh-keygen"] is False


def test_every_label_derives_from_one_resolved_name():
    # Compute Name Standard §3: one function answers "what is this deployment's
    # machine called", and the firewall asks it too rather than keeping a
    # second copy of the profile.
    data = tools.infrastructure_data(fixture({"vultr-name": "override-box"}))
    assert data["compute-name"] == "override-box"


def test_dns_zone_is_registrable_domain():
    assert validate.zone(fixture()) == "example.com"


def test_dns_creates_both_names_unproxied():
    # Unproxied because Cloudflare's proxy is an HTTP proxy: UDP STUN does not
    # survive it and TLS-ALPN-01 would terminate at the proxy, not at Traefik.
    json_text = tools.dns_json({**fixture(), "ip": "192.0.2.10"})
    assert "netbird.example.com" in json_text
    assert "authentik.example.com" in json_text
    assert "192.0.2.10" in json_text
    assert '"proxied" : false' in json_text
    assert "true" not in json_text


def test_dns_publishes_no_wildcard():
    # The sources need one because they expose services through NetBird's own
    # reverse proxy. Traefik routes Authentik directly here, so nothing
    # resolves under a wildcard and publishing one would only widen the
    # surface.
    assert "*" not in tools.dns_json({**fixture(), "ip": "192.0.2.10"})


def test_inventory_keeps_one_target():
    inventory = tools.inventory({**fixture(), "ip": "192.0.2.10"})
    assert "192.0.2.10" in inventory
    assert "netbird-fixture" in inventory


def test_ansible_renders_the_whole_stack():
    targets = [str(s["target"]) for s in tools.ansible_specs(fixture())]
    for file in ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml", "config.yaml",
                 "dashboard.env", "blueprint.yaml", "bootstrap.sh", "smoke.sh",
                 "s3.py", "backup.sh", "restore.sh", "status.sh", "backup.service",
                 "backup-failure.service", "backup.timer", "inventory.json"]:
        assert any(t.endswith(file) for t in targets), file


def test_operator_secrets_reach_the_host_as_lookups_not_values():
    # `.colors/` is generated output and the goldens are committed, so the
    # secret must never be the thing that lands on disk — the expression is.
    # The lookups live literally in the template rather than in the data map,
    # because the renderer HTML-escapes a value it interpolates and Ansible
    # would receive `&#39;` instead of a quote.
    template = resource("tools/ansible/main.yml")
    for par in ["COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD",
                "COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD",
                "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY",
                "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID",
                "COLORS_PAR_NETBIRD_BACKUP_R2_SECRET_ACCESS_KEY"]:
        assert f"lookup('env','{par}')" in template, par


def test_the_data_map_carries_no_operator_secret():
    data = spec_for(fixture(), "main.yml")["data"]
    assert data["netbird-host"] == "netbird.example.com"
    for key in ["netbird-bootstrap-password", "netbird-authentik-bootstrap-password",
                "netbird-backup-recovery-key", "netbird-backup-r2-access-key-id",
                "netbird-backup-r2-secret-access-key"]:
        assert data.get(key) is None, key


def test_generated_secrets_are_placeholders_in_the_rendered_config():
    # The three server secrets are substituted on the host at install time, so
    # what `build` renders — and what a golden commits — is the placeholder.
    template = resource("tools/ansible/config.yaml")
    for placeholder in ["__RELAY_AUTH_SECRET__", "__SESSION_COOKIE_ENCRYPTION_KEY__",
                        "__DATASTORE_ENCRYPTION_KEY__"]:
        assert placeholder in template, placeholder


async def test_a_delete_without_compute_skips_the_host_entirely():
    # There is no machine to stop, and the cleanup play would only fail against
    # the placeholder address.
    result = await tools.ansible_step({**fixture(), "blue/event": "delete"})
    assert result["blue/exit"] == 0


async def test_acceptance_is_skipped_outside_a_real_create():
    for event in ["build", "delete"]:
        result = await tools.acceptance_step({**fixture(), "blue/event": event})
        assert result["blue/exit"] == 0


def test_traefik_has_a_derived_fixed_address():
    # netbird-server maps the Authentik hostname to it, so it cannot float. It
    # is derived rather than configured: a value that can only correctly be
    # `<subnet>.10` is a transcription step.
    assert validate.traefik_ip(fixture()) == "172.30.0.10"
    assert validate.traefik_ip(fixture({"netbird-docker-subnet": "10.9.0.0/24"})) == "10.9.0.10"


def test_the_server_reaches_authentik_through_traefik():
    # A container resolving the public name gets this host's own address and
    # dies in hairpin NAT; the issuer must stay the public URL, so the name is
    # pointed at the proxy instead.
    compose = resource("tools/ansible/compose.yml")
    assert "extra_hosts" in compose
    assert "<{ netbird-authentik-host }>:<{ traefik-ip }>" in compose


def test_the_dashboard_carries_the_variable_its_startup_script_demands():
    # `init_react_envs` exits 1 without USE_AUTH0 and supervisord carries on,
    # so nginx serves every $NETBIRD_* placeholder verbatim while `/` still
    # returns 200. This shipped once.
    env = resource("tools/ansible/dashboard.env")
    assert "USE_AUTH0=false" in env
    # Upstream gates this behind its agent-network preset, where the dashboard
    # hides the standard surfaces.
    assert "NETBIRD_AGENT_NETWORK_ONLY=true" not in env


def test_authentik_accepts_the_federation_callback():
    # The dashboard authenticates against the embedded Dex, which federates to
    # Authentik: the redirect Authentik receives is Dex's callback, not the
    # dashboard's.
    assert "/oauth2/callback" in resource("tools/ansible/blueprint.yaml")


def test_the_federated_login_is_shipped():
    # The account that matters is created by its first federated login, and
    # nothing in the NetBird API will create it on that user's behalf.
    targets = [str(s["target"]) for s in tools.ansible_specs(fixture())]
    assert any(t.endswith("federated-login.py") for t in targets)
