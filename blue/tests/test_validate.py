from conftest import fixture, optout
from package_netbird_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_optout_fixture_is_valid():
    assert validate.state_errors(optout()) == []


# --- the spec handed to ONCE


def test_the_spec_carries_this_packages_registry_sources_and_default():
    # The operations are ONCE's; this is the data they run over. A colour
    # whose registry, sources or default drifts fails here, in that colour.
    assert list(validate.spec["registry"]) == ["vultr"]
    assert validate.spec["registry"] is validate.compute_providers
    assert validate.spec["registry"]["vultr"] == {
        "required": ["vultr-region", "vultr-plan", "vultr-os-id",
                     "vultr-ssh-sources", "vultr-http-sources", "vultr-stun-sources"],
        "secrets": ["vultr-api-key"],
        "tofu-env": {"vultr-api-key": "VULTR_API_KEY"},
    }
    # STUN is the third list, this package's extension of the standard's two.
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources"],
                                        "may_be_empty": ["http-sources", "stun-sources"]}
    assert validate.spec["default"] == "vultr"
    assert validate.spec["default"] == validate.default_compute_provider
    # The name rules are ONCE's.
    assert "name_rules" not in validate.spec


# --- the compute-provider registry


def test_unsupported_provider_names_the_advertised_ones():
    assert ":provider-compute must be one of vultr" in \
        validate.state_errors(fixture({"provider-compute": "digitalocean"}))


def test_required_keys_secrets_and_tofu_env_follow_the_selected_provider():
    assert ":vultr-plan is required" in validate.state_errors(fixture({"vultr-plan": None}))
    assert ":vultr-stun-sources is required" in \
        validate.state_errors(fixture({"vultr-stun-sources": None}))
    # Another provider's keys are neither required nor refused.
    assert validate.state_errors(fixture({"digitalocean-region": "ams3"})) == []
    assert validate.tofu_env(fixture(), "provider-compute") == {"vultr-api-key": "VULTR_API_KEY"}
    assert validate.tofu_env(fixture({"provider-compute": "digitalocean"}), "provider-compute") == {}


# --- the network contract (Compute Provider Standard §5)


def test_ssh_sources_must_not_be_empty():
    # ONCE's check, wired through `spec`: a machine nobody can reach is not a
    # deployment, while no public HTTP and no public STUN are both legitimate.
    assert ":vultr-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"vultr-ssh-sources": []}))
    assert ":vultr-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"vultr-ssh-sources": " , "}))
    assert validate.state_errors(fixture({"vultr-http-sources": []})) == []
    assert validate.state_errors(fixture({"vultr-stun-sources": []})) == []


def test_malformed_sources_are_refused_before_any_provider_call():
    assert ':vultr-http-sources entry "10.0.0.0" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"vultr-http-sources": ["0.0.0.0/0", "10.0.0.0"]}))
    assert ':vultr-stun-sources entry "office.example.com/32" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"vultr-stun-sources": "office.example.com/32"}))
    assert validate.state_errors(
        fixture({"vultr-ssh-sources": ["2001:db8::/32", "203.0.113.0/24"]})) == []


def test_machine_key_is_not_required():
    # The standard makes absence meaningful: requiring vultr-ssh-keys would
    # make every conforming deployment invalid.
    assert not any("vultr-ssh-keys" in e for e in validate.state_errors(fixture()))


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(fixture()) is True
    assert validate.keygen(optout()) is False


# --- Compute Name Standard ---------------------------------------------------


def test_a_name_key_is_not_required():
    # §1: a fresh colors.yml that omits it is complete.
    assert not any("vultr-name" in e for e in validate.state_errors(fixture()))


def test_the_machine_is_named_after_the_profile():
    assert validate.compute_name(fixture()) == "netbird-fixture"


def test_presence_is_the_only_switch():
    # §2: absent, blank and REPLACE_ME all mean the profile; anything else is
    # the name.
    for value in [None, "", "   ", "REPLACE_ME"]:
        assert validate.compute_name(fixture({"vultr-name": value})) == "netbird-fixture", repr(value)
    assert validate.compute_name(fixture({"vultr-name": "custom-box"})) == "custom-box"


def test_the_override_is_validated_not_passed_through():
    # §2: validate against the provider's naming rules rather than reading it
    # unread.
    assert any("vultr-name" in e
               for e in validate.state_errors(fixture({"vultr-name": "not a valid label!"})))
    assert validate.state_errors(fixture({"vultr-name": "netbird-box_1.a"})) == []


def test_there_is_no_package_key():
    # §5: a key that can hold exactly one value carries no information.
    assert not any("package" in e for e in validate.state_errors(fixture()))
    assert "package" not in validate.required


# --- desired state -----------------------------------------------------------


def test_reports_all_errors():
    errors = validate.state_errors(fixture({
        "netbird-host": "bad",
        "netbird-server-image": "floating",
        "netbird-letsencrypt-email": "not-an-email",
        "provider-dns": "other",
        "netbird-backup-retention-days": 0,
        "netbird-backup-dir": "relative/path",
        "netbird-stun-port": 70000,
        "netbird-docker-subnet": "nonsense",
        "vultr-os-id": "2284"}))
    assert len(errors) >= 9
    for part in ["host", "image", "letsencrypt-email", "provider-dns",
                 "os-id", "retention-days", "backup-dir", "stun-port", "docker-subnet"]:
        assert any(part in e for e in errors), part


def test_both_public_names_must_share_one_zone():
    # The DNS stage looks a single zone up and creates both records in it, so a
    # second name outside that zone would render a record it cannot create.
    assert any("share a zone" in e for e in validate.state_errors(
        fixture({"netbird-authentik-host": "authentik.elsewhere.net"})))
    assert validate.state_errors(fixture({"netbird-authentik-host": "idp.example.com"})) == []


def test_the_two_public_names_must_differ():
    assert any("must differ" in e for e in validate.state_errors(
        fixture({"netbird-authentik-host": "netbird.example.com"})))


def test_the_two_identities_must_be_distinct():
    # They live in different NetBird accounts — the local one created by
    # /api/setup, the federated one created by its first Authentik login — and
    # nothing merges them.
    assert any("netbird-authentik-bootstrap-email" in e for e in validate.state_errors(
        fixture({"netbird-bootstrap-email": "admin@example.com"})))


def test_there_is_no_owner_email_key():
    assert "netbird-owner-email" not in validate.required


def test_accepts_a_digest_pin():
    assert validate.state_errors(fixture(
        {"netbird-traefik-image": "traefik@sha256:" + "a" * 64})) == []


def test_no_image_may_float():
    for key in validate.image_keys:
        assert any("floating tag" in e for e in validate.state_errors(
            fixture({key: "netbirdio/netbird-server:latest"}))), key


def test_an_untagged_image_is_refused():
    # `repository/name` means :latest by implication and would walk past a
    # suffix-only check for ":latest".
    assert any("explicit image tag" in e for e in validate.state_errors(
        fixture({"netbird-server-image": "netbirdio/netbird-server"})))


def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "other"})
    assert not validate.env_errors({})


# --- credentials -------------------------------------------------------------


def test_a_create_names_every_operator_secret():
    errors = "\n".join(validate.secret_errors(fixture(), "create"))
    for name in ["COLORS_PAR_VULTR_API_KEY", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                 "COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD",
                 "COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD",
                 "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY",
                 "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID",
                 "COLORS_PAR_NETBIRD_BACKUP_R2_SECRET_ACCESS_KEY"]:
        assert name in errors, name
    # Generated on the host and supplied by nobody.
    for absent in ["OIDC_CLIENT_SECRET", "RELAY", "SESSION", "ENCRYPTION_KEY",
                   "AUTHENTIK_SECRET_KEY", "PAT"]:
        assert absent not in errors, absent


def test_a_delete_does_not_ask_for_the_account_passwords():
    # Destroying a machine must not require the credentials needed to converge
    # one; a missing owner password should not be a lock on the exit.
    errors = "\n".join(validate.secret_errors(fixture(), "delete"))
    assert "COLORS_PAR_VULTR_API_KEY" in errors
    assert "BOOTSTRAP_PASSWORD" not in errors


def test_a_delete_still_asks_for_what_the_final_backup_needs():
    # cleanup.yml takes a last archive on the way out, and a delete that cannot
    # back up is a delete that cannot be undone.
    errors = "\n".join(validate.secret_errors(fixture(), "delete"))
    assert "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY" in errors
    assert "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID" in errors
