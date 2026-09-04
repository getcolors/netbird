import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StepError, type Opts } from "red/workflow";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const optout = (overrides: Opts = {}) => readFixture(optoutFile, overrides);

// ~/.ssh redirection: ONCE's ssh module and this package's ssh-config both
// read $HOME at call time, exactly so tests can point them at a fresh
// temporary home.
let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "netbird-red-test"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(optout())).toEqual([]);
  });

  // --- the spec handed to ONCE

  test("the spec carries this package's registry, sources and default", () => {
    // The operations are ONCE's; this is the data they run over. A colour
    // whose registry, sources or default drifts fails here, in that colour.
    expect(Object.keys(validate.spec.registry)).toEqual(["vultr"]);
    expect(validate.spec.registry).toBe(validate.computeProviders);
    expect(validate.spec.registry.vultr).toEqual({
      required: ["vultr-region", "vultr-plan", "vultr-os-id",
                 "vultr-ssh-sources", "vultr-http-sources", "vultr-stun-sources"],
      secrets: ["vultr-api-key"],
      tofuEnv: { "vultr-api-key": "VULTR_API_KEY" },
    });
    // STUN is the third list, this package's extension of the standard's two.
    expect(validate.spec.sources).toEqual({ nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources", "stun-sources"] });
    expect(validate.spec.default).toBe("vultr");
    expect(validate.spec.default).toBe(validate.defaultComputeProvider);
    // The name rules are ONCE's.
    expect(validate.spec.nameRules).toBeUndefined();
  });

  // --- the compute-provider registry

  test("an unsupported provider names the advertised ones", () => {
    expect(validate.stateErrors(fixture({ "provider-compute": "digitalocean" })))
      .toContain(":provider-compute must be one of vultr");
  });

  test("required keys, secrets and the tofu env follow the selected provider", () => {
    expect(validate.stateErrors(fixture({ "vultr-plan": null }))).toContain(":vultr-plan is required");
    expect(validate.stateErrors(fixture({ "vultr-stun-sources": null })))
      .toContain(":vultr-stun-sources is required");
    // Another provider's keys are neither required nor refused.
    expect(validate.stateErrors(fixture({ "digitalocean-region": "ams3" }))).toEqual([]);
    expect(validate.tofuEnv(fixture(), "provider-compute")).toEqual({ "vultr-api-key": "VULTR_API_KEY" });
    expect(validate.tofuEnv(fixture({ "provider-compute": "digitalocean" }), "provider-compute")).toEqual({});
  });

  // --- the network contract (Compute Provider Standard §5)

  test("ssh sources must not be empty; no public HTTP or STUN is fine", () => {
    // ONCE's check, wired through `spec`: a machine nobody can reach is not a
    // deployment, while no public HTTP and no public STUN are both legitimate.
    expect(validate.stateErrors(fixture({ "vultr-ssh-sources": [] })))
      .toContain(":vultr-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "vultr-ssh-sources": " , " })))
      .toContain(":vultr-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "vultr-http-sources": [] }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "vultr-stun-sources": [] }))).toEqual([]);
  });

  test("malformed sources are refused before any provider call", () => {
    expect(validate.stateErrors(fixture({ "vultr-http-sources": ["0.0.0.0/0", "10.0.0.0"] })))
      .toContain(':vultr-http-sources entry "10.0.0.0" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "vultr-stun-sources": "office.example.com/32" })))
      .toContain(':vultr-stun-sources entry "office.example.com/32" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "vultr-ssh-sources": ["2001:db8::/32", "203.0.113.0/24"] }))).toEqual([]);
  });

  test("the machine key and the name key are not required", () => {
    // The standard makes absence meaningful: requiring vultr-ssh-keys would
    // make every conforming keygen deployment invalid, and a fresh colors.yml
    // that omits vultr-name is complete (Compute Name Standard §1).
    const errors = validate.stateErrors(fixture());
    expect(errors.some((e) => e.includes("vultr-ssh-keys"))).toBe(false);
    expect(errors.some((e) => e.includes("vultr-name"))).toBe(false);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(fixture())).toBe(true);
    expect(validate.keygen(optout())).toBe(false);
  });

  test("the machine is named after the profile; presence is the only switch", () => {
    expect(validate.computeName(fixture())).toBe("netbird-fixture");
    for (const value of [null, "", "   ", "REPLACE_ME"]) {
      expect(validate.computeName(fixture({ "vultr-name": value }))).toBe("netbird-fixture");
    }
    expect(validate.computeName(fixture({ "vultr-name": "custom-box" }))).toBe("custom-box");
  });

  test("the name override is validated, not passed through", () => {
    expect(validate.stateErrors(fixture({ "vultr-name": "not a valid label!" }))
      .some((e) => e.includes("vultr-name"))).toBe(true);
    expect(validate.stateErrors(fixture({ "vultr-name": "netbird-box_1.a" }))).toEqual([]);
  });

  test("there is no package key", () => {
    // §5: a key that can hold exactly one value carries no information.
    expect(validate.required.includes("package")).toBe(false);
  });

  test("reports all errors at once", () => {
    const errors = validate.stateErrors(fixture({
      "netbird-host": "bad",
      "netbird-server-image": "floating",
      "netbird-letsencrypt-email": "not-an-email",
      "provider-dns": "other",
      "netbird-backup-retention-days": 0,
      "netbird-backup-dir": "relative/path",
      "netbird-stun-port": 70000,
      "netbird-docker-subnet": "nonsense",
      "vultr-os-id": "2284",
    }));
    expect(errors.length).toBeGreaterThanOrEqual(9);
    for (const part of ["host", "image", "letsencrypt-email", "provider-dns",
                        "os-id", "retention-days",
                        "backup-dir", "stun-port", "docker-subnet"]) {
      expect(errors.some((e) => e.includes(part))).toBe(true);
    }
  });

  test("both public names must share one zone and must differ", () => {
    expect(validate.stateErrors(fixture({ "netbird-authentik-host": "authentik.elsewhere.net" }))
      .some((e) => e.includes("share a zone"))).toBe(true);
    expect(validate.stateErrors(fixture({ "netbird-authentik-host": "idp.example.com" }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "netbird-authentik-host": "netbird.example.com" }))
      .some((e) => e.includes("must differ"))).toBe(true);
  });

  test("the two bootstrap identities must be distinct", () => {
    expect(validate.stateErrors(fixture({ "netbird-bootstrap-email": "admin@example.com" }))
      .some((e) => e.includes("netbird-authentik-bootstrap-email"))).toBe(true);
  });

  test("images: digests pass, floating and untagged are refused", () => {
    expect(validate.stateErrors(
      fixture({ "netbird-traefik-image": `traefik@sha256:${"a".repeat(64)}` }))).toEqual([]);
    for (const key of validate.imageKeys) {
      expect(validate.stateErrors(fixture({ [key]: "netbirdio/netbird-server:latest" }))
        .some((e) => e.includes("floating tag"))).toBe(true);
    }
    expect(validate.stateErrors(fixture({ "netbird-server-image": "netbirdio/netbird-server" }))
      .some((e) => e.includes("explicit image tag"))).toBe(true);
  });

  test("profile overlay is refused", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBe(1);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("a create names every operator secret and nothing generated", () => {
    const errors = validate.secretErrors(fixture(), "create").join("\n");
    for (const name of ["COLORS_PAR_VULTR_API_KEY", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                        "COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD",
                        "COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD",
                        "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY",
                        "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID",
                        "COLORS_PAR_NETBIRD_BACKUP_R2_SECRET_ACCESS_KEY"]) {
      expect(errors).toContain(name);
    }
    // Generated on the host and supplied by nobody.
    for (const absent of ["OIDC_CLIENT_SECRET", "RELAY", "SESSION",
                          "ENCRYPTION_KEY", "AUTHENTIK_SECRET_KEY", "PAT"]) {
      expect(errors).not.toContain(absent);
    }
  });

  test("a delete asks for the backup set but never the account passwords", () => {
    const errors = validate.secretErrors(fixture(), "delete").join("\n");
    expect(errors).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(errors).toContain("COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY");
    expect(errors).toContain("COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID");
    expect(errors).not.toContain("BOOTSTRAP_PASSWORD");
  });

  test("traefik has a derived fixed address", () => {
    expect(validate.traefikIp(fixture())).toBe("172.30.0.10");
    expect(validate.traefikIp(fixture({ "netbird-docker-subnet": "10.9.0.0/24" }))).toBe("10.9.0.10");
  });

  test("dns zone is the registrable domain", () => {
    expect(validate.zone(fixture())).toBe("example.com");
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("firewall sources parse and infrastructure data carries the ssh mode", () => {
    const data = tools.infrastructureData(fixture());
    expect(tools.cidrs(data, "vultr-http-sources")).toEqual(["0.0.0.0/0"]);
    expect(tools.cidrs(data, "vultr-stun-sources")).toEqual(["0.0.0.0/0"]);
    expect(data["ssh-keygen"]).toBe(true);
    expect(tools.infrastructureData(optout())["ssh-keygen"]).toBe(false);
  });

  test("cidrs accept overlay strings", () => {
    expect(tools.cidrs({ x: "10.0.0.0/8, 20.0.0.0/8" }, "x"))
      .toEqual(["10.0.0.0/8", "20.0.0.0/8"]);
  });

  test("every label derives from one resolved name", () => {
    // Compute Name Standard §3: the firewall asks the same function rather
    // than keeping a second copy of the profile.
    expect(tools.infrastructureData(fixture({ "vultr-name": "override-box" }))["compute-name"])
      .toBe("override-box");
  });

  test("dns creates both names unproxied, and no wildcard", () => {
    const json = tools.dnsJson(fixture({ ip: "192.0.2.10" }));
    expect(json).toContain("netbird.example.com");
    expect(json).toContain("authentik.example.com");
    expect(json).toContain("192.0.2.10");
    expect(json).toContain('"proxied" : false');
    expect(json).not.toContain("true");
    expect(json).not.toContain("*");
  });

  test("the inventory keeps one target", () => {
    const inventory = tools.inventory(fixture({ ip: "192.0.2.10" }));
    expect(inventory).toContain("192.0.2.10");
    expect(inventory).toContain("netbird-fixture");
  });

  test("the ansible stage renders the whole stack", () => {
    const targets = tools.ansibleSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
                        "config.yaml", "dashboard.env", "blueprint.yaml",
                        "bootstrap.sh", "federated-login.py", "smoke.sh", "s3.py",
                        "backup.sh", "restore.sh", "status.sh", "backup.service",
                        "backup-failure.service", "backup.timer", "inventory.json"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
  });

  test("operator secrets reach the host as lookups, not values", () => {
    // `.colors/` is generated output and the goldens are committed, so the
    // secret must never be the thing that lands on disk — the expression is.
    // The lookups live literally in the template rather than in the data map,
    // because the renderer HTML-escapes a value it interpolates and Ansible
    // would receive `&#39;` instead of a quote.
    const template = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/main.yml"), "utf8");
    for (const par of ["COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD",
                       "COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD",
                       "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY",
                       "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID",
                       "COLORS_PAR_NETBIRD_BACKUP_R2_SECRET_ACCESS_KEY"]) {
      expect(template).toContain(`lookup('env','${par}')`);
    }
  });

  test("the data map carries no operator secret", () => {
    const spec = tools.ansibleSpecs(fixture())
      .find((s) => String(s.target).endsWith("main.yml"));
    const data = spec?.data ?? {};
    expect(data["netbird-host"]).toBe("netbird.example.com");
    for (const key of ["netbird-bootstrap-password", "netbird-authentik-bootstrap-password",
                       "netbird-backup-recovery-key", "netbird-backup-r2-access-key-id",
                       "netbird-backup-r2-secret-access-key"]) {
      expect(data[key]).toBeUndefined();
    }
  });

  test("generated secrets are placeholders in the rendered config", () => {
    const template = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/config.yaml"), "utf8");
    for (const ph of ["__RELAY_AUTH_SECRET__", "__SESSION_COOKIE_ENCRYPTION_KEY__",
                      "__DATASTORE_ENCRYPTION_KEY__"]) {
      expect(template).toContain(ph);
    }
  });

  test("a delete without compute skips the host entirely", async () => {
    const result = await tools.ansibleStep(fixture({ "red/event": "delete" }));
    expect(result["red/exit"]).toBe(0);
  });

  test("acceptance is skipped outside a real create", async () => {
    for (const event of ["build", "delete"]) {
      const result = await tools.acceptanceStep(fixture({ "red/event": event }));
      expect(result["red/exit"]).toBe(0);
    }
  });

  test("the server reaches authentik through traefik", () => {
    const compose = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/compose.yml"), "utf8");
    expect(compose).toContain("extra_hosts");
    expect(compose).toContain("<{ netbird-authentik-host }>:<{ traefik-ip }>");
  });

  test("the dashboard carries the variable its startup script demands", () => {
    const env = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/dashboard.env"), "utf8");
    expect(env).toContain("USE_AUTH0=false");
    expect(env).not.toContain("NETBIRD_AGENT_NETWORK_ONLY=true");
  });

  test("authentik accepts the federation callback", () => {
    const blueprint = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/blueprint.yaml"), "utf8");
    expect(blueprint).toContain("/oauth2/callback");
  });

  test("tool dirs live under <workdir>/<profile>", () => {
    const opts = { workdir: "/work", profile: "netbird-fixture" };
    expect(tools.toolDir(opts, tools.infrastructureTool))
      .toBe("/work/netbird-fixture/netbird-infrastructure");
    expect(tools.toolDir(opts, tools.ansibleLocalTool))
      .toBe("/work/netbird-fixture/netbird-ansible-local");
  });

  test("backend advice writes the conventional state address", () => {
    const work = mkdtempSync(join(tmpdir(), "netbird-red-backend"));
    try {
      const opts = fixture({ workdir: work, "provider-backend": "r2" });
      workflow.backendAdvice(tools.dnsTool)(opts);
      const backend = JSON.parse(readFileSync(
        join(work, "netbird-fixture", "netbird-dns", "backend.tf.json"), "utf8"));
      const s3 = backend.terraform.backend.s3;
      expect(s3.bucket).toBe("tofu-state-example");
      expect(s3.key).toBe("netbird-fixture/netbird-dns.tfstate");
      expect(s3.endpoints.s3).toBe("https://example.eu.r2.cloudflarestorage.com");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// --- ssh keypair (SSH Keypair Standard) --------------------------------------

describe("ssh", () => {
  test("build renders a stable placeholder path", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "build" }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    expect(opts["vultr-ssh-keys"]).toBe(opts["ssh-public-key-path"]);
    expect(String(opts["ssh-private-key-path"])).not.toContain(home);
  });

  test("a dry-run renders the placeholder too", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "create", "red/dry-run": true }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
  });

  test("real events render the real path", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "create" }));
    expect(opts["ssh-private-key-path"]).toBe(join(home, ".ssh", "netbird-fixture"));
    expect(opts["ssh-public-key-path"]).toBe(join(home, ".ssh", "netbird-fixture.pub"));
  });

  test("opt-out passes through untouched", () => {
    for (const event of ["build", "create", "delete"]) {
      const opts = ssh.withMachineKey(optout({ "red/event": event }));
      expect(opts["vultr-ssh-keys"]).toBe("00000000-0000-0000-0000-000000000000");
      expect(opts["ssh-public-key-path"]).toBeUndefined();
      expect(opts["ssh-keygen"]).toBeUndefined();
    }
  });

  test("first create generates the keypair", async () => {
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    const prv = join(home, ".ssh", "netbird-fixture");
    const pub = `${prv}.pub`;
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(prv)).toBe(true);
    expect(existsSync(pub)).toBe(true);
    // ed25519, no passphrase, profile-named comment
    expect(readFileSync(pub, "utf8")).toContain("ssh-ed25519");
    expect(readFileSync(pub, "utf8")).toContain("netbird-fixture managed by Colors");
    // 600 on the private key, 700 on ~/.ssh
    expect(statSync(prv).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  test("converge reuses an existing key", async () => {
    write(join(home, ".ssh", "netbird-fixture"), "private");
    write(join(home, ".ssh", "netbird-fixture.pub"), "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }),
      async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/err"]).toBeUndefined();
    expect(readFileSync(join(home, ".ssh", "netbird-fixture"), "utf8")).toBe("private");
  });

  test("state without a key is an error", async () => {
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }),
      async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("does not hold the machine key");
    expect(String(opts["red/err"])).toContain("rebuild");
  });

  test("a key without state is never overwritten", async () => {
    const prv = join(home, ".ssh", "netbird-fixture");
    write(prv, "irreplaceable");
    write(`${prv}.pub`, "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("no compute state is readable");
    expect(String(opts["red/err"])).toContain("survives");
    expect(readFileSync(prv, "utf8")).toBe("irreplaceable");
  });

  test("half a keypair is an error", async () => {
    write(join(home, ".ssh", "netbird-fixture"), "private");
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("half a keypair");
  });

  test("opt-out generates nothing", async () => {
    const opts = await ssh.ensureKey(optout({ "red/event": "create" }), async () => undefined);
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(join(home, ".ssh"))).toBe(false);
  });

  test("preflight passes when no account key matches, or when it is ours", async () => {
    const clean = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => [{ id: "1", name: "someone-else", public: "ssh-ed25519 BBBB" }]);
    expect(clean["red/err"]).toBeUndefined();
    const owned = await ssh.preflight(
      ssh.withMachineKey(fixture({ "red/event": "create",
        "once/ssh-state-params": { ssh_key_id: "abc" } })),
      async () => [{ id: "abc", name: "netbird-fixture", public: "ssh-ed25519 AAAA" }]);
    expect(owned["red/err"]).toBeUndefined();
  });

  test("preflight refuses our leftover key", async () => {
    write(join(home, ".ssh", "netbird-fixture.pub"), "ssh-ed25519 AAAA comment");
    const opts = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => [{ id: "abc", name: "netbird-fixture", public: "ssh-ed25519 AAAA" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("previous delete");
    expect(String(opts["red/err"])).toContain("delete that key");
  });

  test("preflight refuses a foreign key and says do not delete it", async () => {
    write(join(home, ".ssh", "netbird-fixture.pub"), "ssh-ed25519 OURS comment");
    const opts = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => [{ id: "abc", name: "netbird-fixture", public: "ssh-ed25519 THEIRS" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("Do not delete it");
  });

  test("preflight failure is an error, not a skip", async () => {
    const opts = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => { throw new Error("HTTP 500"); });
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("cannot list");
  });

  test("delete removes the keypair; ~/.ssh itself survives", () => {
    write(join(home, ".ssh", "netbird-fixture"), "private");
    write(join(home, ".ssh", "netbird-fixture.pub"), "public");
    ssh.cleanupStep(fixture({ "red/event": "delete", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "netbird-fixture"))).toBe(false);
    expect(existsSync(join(home, ".ssh", "netbird-fixture.pub"))).toBe(false);
    expect(existsSync(join(home, ".ssh"))).toBe(true);
  });

  test("cleanup is inert on create and in opt-out mode", () => {
    write(join(home, ".ssh", "netbird-fixture"), "private");
    ssh.cleanupStep(fixture({ "red/event": "create", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "netbird-fixture"))).toBe(true);
    ssh.cleanupStep(optout({ "red/event": "delete" }));
    expect(existsSync(join(home, ".ssh", "netbird-fixture"))).toBe(true);
  });
});

// --- ~/.ssh/config (SSH Config Standard) -------------------------------------

describe("ssh-config", () => {
  test("the alias is the profile and the identity file keeps the tilde", () => {
    expect(sshConfig.hostAlias(fixture())).toBe("netbird-fixture");
    expect(sshConfig.identityFile(fixture())).toBe("~/.ssh/netbird-fixture");
    expect(sshConfig.identityFile(fixture())).not.toContain(home);
  });

  test("the marker is the alias alone", () => {
    expect(sshConfig.beginMarker("netbird-vultr")).toBe("# BEGIN netbird-vultr ANSIBLE MANAGED BLOCK");
    expect(sshConfig.endMarker("netbird-vultr")).toBe("# END netbird-vultr ANSIBLE MANAGED BLOCK");
  });

  test("a foreign stanza is found; our own block is not foreign", () => {
    expect(sshConfig.foreignStanzaLine(
      ["Host other", "    HostName 192.0.2.1", "", "Host netbird-fixture"],
      "netbird-fixture")).toBe(4);
    const alias = "netbird-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, "    HostName 192.0.2.1",
       sshConfig.endMarker(alias)], alias)).toBeUndefined();
  });

  test("a stanza after our block is still foreign", () => {
    const alias = "netbird-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, sshConfig.endMarker(alias),
       `Host ${alias}`], alias)).toBe(4);
  });

  test("a block under a retired marker is foreign", () => {
    const alias = "netbird-vultr";
    expect(sshConfig.foreignStanzaLine(
      [`# BEGIN netbird ${alias} ANSIBLE MANAGED BLOCK`, `Host ${alias}`,
       `# END netbird ${alias} ANSIBLE MANAGED BLOCK`], alias)).toBe(2);
  });

  test("multi-pattern host lines count; unrelated files are left alone", () => {
    expect(sshConfig.foreignStanzaLine(["Host web netbird-fixture db"], "netbird-fixture")).toBe(1);
    expect(sshConfig.foreignStanzaLine(["Host build", "Host netbird-other"], "netbird-fixture"))
      .toBeUndefined();
  });

  test("an option above the first Host is refused; comments and Host openers are fine", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host a"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# comment", "", "IdentitiesOnly yes", "Host a"])).toBe(3);
    expect(sshConfig.leadingOptionLine(["Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# lead comment", "", "Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Match host b", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# nothing here", ""])).toBeUndefined();
  });

  test("preflight refuses rather than overwrites", () => {
    const refused = sshConfig.preflight(fixture(), {
      adoptError: () => "already declares `Host x`",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    const clean = sshConfig.preflight(fixture(), {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(clean["red/exit"]).toBeUndefined();
  });

  test("adopt and placement errors read the real file and mention the recovery", () => {
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost netbird-fixture\n");
    expect(String(sshConfig.adoptError(fixture()))).toContain("Host netbird-fixture");
    expect(String(sshConfig.placementError(fixture()))).toContain("Host *");
  });

  test("the local play renders no address and follows keygen mode", () => {
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7" }));
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/netbird-fixture");
    expect(data["ssh-keygen"]).toBe(true);
    expect(tools.ansibleLocalData(optout())["ssh-keygen"]).toBe(false);
  });

  test("the local stage renders three files", () => {
    const targets = tools.ansibleLocalSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["/ansible.cfg", "/inventory.ini", "/main.yml"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
    expect(targets.every((t) => t.includes("netbird-ansible-local"))).toBe(true);
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  // The compute state is read once per run, through the injectable reader,
  // on a real create or delete. Every lifecycle test stubs it: undefined is a
  // readable state holding no compute, a map is a recorded `params`, and a
  // throw is a backend that cannot be read.
  const start = (opts: Opts, state: Record<string, unknown> | undefined) =>
    workflow.startStep(opts, {}, async () => state);
  // The shape `red/tofu` throws: the SDK's StepError. Only that is an
  // unreadable backend; anything else propagates as a defect.
  const startUnreadable = (opts: Opts) =>
    workflow.startStep(opts, {}, async () => { throw new StepError("tofu output failed: no backend"); });
  // What a real delete asks for: the providers and the final backup's set.
  const credentials = { "vultr-api-key": "v", "cloudflare-api-token": "c",
    "netbird-backup-recovery-key": "k",
    "netbird-backup-r2-access-key-id": "a", "netbird-backup-r2-secret-access-key": "s" };

  test("build and dry-run need no credentials and never touch ~/.ssh or the state", async () => {
    // The standard forbids reading, creating, or requiring anything under
    // ~/.ssh on a build or dry-run: they render from desired state alone.
    // A poisoned config proves nothing in the build path reads it, and a
    // throwing reader proves nothing on these paths reads the backend.
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost netbird-fixture\n");
    for (const overrides of [{ "red/event": "build" },
                             { "red/event": "create", "red/dry-run": true },
                             { "red/event": "delete", "red/dry-run": true }]) {
      const result = await startUnreadable(fixture(overrides));
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
    }
  });

  test("a real create requires credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(result["red/err"])).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(String(result["red/err"])).toContain("COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD");
  });

  test("a real delete asks for the providers and the backup set only", async () => {
    // The thunk handed to ONCE carries the event: a delete still never asks
    // for an account password.
    const result = await start(fixture({ "red/event": "delete", "compute-prevent-destroy": false }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(result["red/err"])).toContain("COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY");
    expect(String(result["red/err"])).not.toContain("BOOTSTRAP_PASSWORD");
  });

  test("delete is protected", async () => {
    const result = await start(fixture({ "red/event": "delete" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
  });

  // --- provider switching is a rebuild, never an apply

  test("a provider switch is refused on create and delete", async () => {
    for (const event of ["create", "delete"]) {
      const result = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { provider: "digitalocean", ip: "203.0.113.9" });
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"]))
        .toContain("state holds a digitalocean machine; set provider-compute back to digitalocean and delete first");
      // The validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected.
      expect(String(result["red/err"])).not.toContain("required credential is not set");
    }
  });

  test("legacy state is accepted on the default provider", async () => {
    // A deployment created before this package recorded a provider carries
    // no `params.provider`; it is a Vultr machine, and Vultr is selected.
    for (const event of ["create", "delete"]) {
      const result = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { ip: "203.0.113.9" });
      expect(String(result["red/err"])).not.toContain("state holds");
      expect(String(result["red/err"])).toContain("required credential is not set");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), { provider: "vultr", ip: "203.0.113.9" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
  });

  test("an unreadable backend counts as no state on create", async () => {
    // A fresh clone has no readable state and must still be able to create.
    const result = await startUnreadable(fixture({ "red/event": "create" }));
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("could not read");
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
  });

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // No reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does. The SDK's output read
    // throws its StepError there, which ONCE's `readState` counts as an
    // unreadable state, so the create reports its credentials.
    const work = mkdtempSync(join(tmpdir(), "netbird-red-fresh"));
    try {
      const result = await workflow.startStep(fixture({ workdir: work, "red/event": "create" }), {});
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an unreadable backend fails a real delete closed", async () => {
    // Swallowing it is how a teardown ends up converging against 192.0.2.10.
    const result = await startUnreadable(fixture({ ...credentials, "red/event": "delete",
      "compute-prevent-destroy": false }));
    expect(result["red/exit"]).toBe(1);
    expect(String(result["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(result["red/err"])).toContain("no backend");
  });

  test("a real delete adopts the recorded address", async () => {
    const adopted = await start(fixture({ ...credentials, "red/event": "delete", "compute-prevent-destroy": false }),
      { provider: "vultr", ip: "203.0.113.9", user: "root" });
    expect(adopted["red/exit"]).toBe(0);
    expect(adopted.ip).toBe("203.0.113.9");
    // A readable state without compute leaves the address unset, and the
    // cleanup step skips itself.
    const empty = await start(fixture({ ...credentials, "red/event": "delete", "compute-prevent-destroy": false }),
      undefined);
    expect(empty["red/exit"]).toBe(0);
    expect(empty.ip).toBeUndefined();
  });

  test("the create graph orders the stack", () => {
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "create" }) ?? []).slice(1);
    expect(next("netbird/start")).toEqual(["netbird/infrastructure"]);
    expect(next("netbird/infrastructure")).toEqual(["netbird/ssh-config"]);
    expect(next("netbird/ssh-config")).toEqual(["netbird/dns"]);
    // DNS before convergence: Traefik asks Let's Encrypt for a certificate as
    // soon as it starts, and TLS-ALPN-01 only succeeds once the names resolve.
    expect(next("netbird/dns")).toEqual(["netbird/ansible"]);
    expect(next("netbird/ansible")).toEqual(["netbird/acceptance"]);
  });

  test("delete removes the config block before the destroy and the key after it", () => {
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("netbird/start")).toEqual(["netbird/ansible"]);
    expect(next("netbird/ansible")).toEqual(["netbird/dns"]);
    expect(next("netbird/dns")).toEqual(["netbird/ssh-config"]);
    expect(next("netbird/ssh-config")).toEqual(["netbird/infrastructure"]);
    expect(next("netbird/infrastructure")).toEqual(["netbird/ssh-cleanup"]);
    expect(next("netbird/ssh-cleanup")).toEqual([]);
  });
});
