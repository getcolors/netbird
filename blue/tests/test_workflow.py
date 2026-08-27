from conftest import fixture
from package_netbird_blue import workflow


async def test_build_and_dry_run_need_no_credentials():
    result = await workflow.start_step({**fixture(), "blue/event": "build"}, env={})
    assert result["blue/exit"] == 0
    result = await workflow.start_step(
        {**fixture(), "blue/event": "create", "blue/dry-run": True}, env={})
    assert result["blue/exit"] == 0


async def test_build_and_dry_run_never_touch_ssh():
    # The standard forbids reading, creating, or requiring anything under
    # ~/.ssh on a build or dry-run: they render from desired state alone.
    for opts in [{**fixture(), "blue/event": "build"},
                 {**fixture(), "blue/event": "create", "blue/dry-run": True}]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert str(result["ssh-public-key-path"]).startswith("/home/build-placeholder"), \
            "a build must not name the operator's home directory"


async def test_real_create_requires_credentials():
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_VULTR_API_KEY" in result["blue/err"]
    assert "COLORS_PAR_CLOUDFLARE_API_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD" in result["blue/err"]


async def test_delete_is_protected():
    result = await workflow.start_step({**fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in result["blue/err"]


def test_graph_orders_the_stack():
    create = {"blue/event": "create"}
    assert workflow.wire_fn("netbird/start", create)[1:] == ("netbird/infrastructure",)
    assert workflow.wire_fn("netbird/infrastructure", create)[1:] == ("netbird/ssh-config",)
    assert workflow.wire_fn("netbird/ssh-config", create)[1:] == ("netbird/dns",)
    # DNS before convergence: Traefik asks Let's Encrypt for a certificate as
    # soon as it starts, and TLS-ALPN-01 only succeeds once the names resolve.
    assert workflow.wire_fn("netbird/dns", create)[1:] == ("netbird/ansible",)
    assert workflow.wire_fn("netbird/ansible", create)[1:] == ("netbird/acceptance",)


def test_delete_removes_the_key_after_the_compute_destroy():
    # The ordering is what makes "key present ⇔ deployment exists" hold: a
    # failed destroy never reaches the cleanup step, and correctly leaves the
    # key that is still the only credential to whatever survived.
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("netbird/start", delete)[1:] == ("netbird/ansible",)
    assert workflow.wire_fn("netbird/infrastructure", delete)[1:] == ("netbird/ssh-cleanup",)
    assert workflow.wire_fn("netbird/ssh-cleanup", delete)[1:] == ()


def test_backend_addresses_key_state_by_profile_and_tool():
    dir = workflow.tools.tool_dir(fixture(), workflow.tools.infrastructure_tool)
    assert dir.endswith(".colors/netbird-fixture/netbird-infrastructure")
