import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { failed } from "red/workflow";
import { compute } from "package-once-red";
import * as sshConfig from "./ssh-config.ts";
import * as validate from "./validate.ts";

import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCompose from "../resources/tools/ansible/compose.yml" with { type: "text" };
import ansibleConfig from "../resources/tools/ansible/config.yaml" with { type: "text" };
import ansibleDashboardEnv from "../resources/tools/ansible/dashboard.env" with { type: "text" };
import ansibleBlueprint from "../resources/tools/ansible/blueprint.yaml" with { type: "text" };
import ansibleBootstrap from "../resources/tools/ansible/bootstrap.sh" with { type: "text" };
import ansibleFederatedLogin from "../resources/tools/ansible/federated-login.py" with { type: "text" };
import ansibleSmoke from "../resources/tools/ansible/smoke.sh" with { type: "text" };
import ansibleS3 from "../resources/tools/ansible/s3.py" with { type: "text" };
import ansibleBackup from "../resources/tools/ansible/backup.sh" with { type: "text" };
import ansibleRestore from "../resources/tools/ansible/restore.sh" with { type: "text" };
import ansibleStatus from "../resources/tools/ansible/status.sh" with { type: "text" };
import ansibleBackupService from "../resources/tools/ansible/backup.service" with { type: "text" };
import ansibleBackupFailureService from "../resources/tools/ansible/backup-failure.service" with { type: "text" };
import ansibleBackupTimer from "../resources/tools/ansible/backup.timer" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureVultrTf from "../resources/tools/infrastructure/vultr/main.tf" with { type: "text" };

export const infrastructureTool = "netbird-infrastructure";
export const dnsTool = "netbird-dns";
export const ansibleTool = "netbird-ansible";
export const ansibleLocalTool = "netbird-ansible-local";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "netbird" });
}

const template = (name: string, content: string): Template => ({ name, content });

// The compute templates this colour carries, one static text import per
// provider directory (`infrastructure/<provider>/main.tf`), keyed by the
// registry name. Providers are selected by directory, never by conditionals
// inside one file; the rendered target is the same `main.tf` whichever
// directory it came from.
const infrastructureTemplates: Record<string, string> = {
  vultr: infrastructureVultrTf,
};

export function infrastructureTemplate(opts: Opts): Template {
  const provider = String(opts["provider-compute"]);
  const content = infrastructureTemplates[provider];
  if (content === undefined) throw new Error(`template not found: infrastructure/${provider}/main.tf`);
  return template(`infrastructure/${provider}/main.tf`, content);
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

// The source lists as validate parses them, so the template and the
// validator can never disagree about what an entry is.
export const cidrs = validate.cidrs;

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping: Record<string, string> = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  );
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

// What `build` and `--dry-run` render in place of a compute output: the
// documentation address, shaped like the selected provider's real `params` so
// every later stage sees the same keys either way. ONCE's.
export const fallbackParams = compute.fallbackParams;

// Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute output
// carries no `ip`. ONCE's; `infrastructureStep` is what wires it.
export const resolvedCompute = compute.resolvedCompute;

// ---------------------------------------------------------------- compute

// Template values for the compute stage. The name and the three source lists
// are resolved here once, so a template interpolates values and never branches
// on which provider it belongs to.
export function infrastructureData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "compute-name": validate.computeName(opts),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, validate.computeKey(opts, "ssh-sources"))),
    "http-sources-hcl": tofu.hclList(cidrs(opts, validate.computeKey(opts, "http-sources"))),
    "stun-sources-hcl": tofu.hclList(cidrs(opts, validate.computeKey(opts, "stun-sources"))),
  };
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const specs = [spec(infrastructureTemplate(opts), `${dir}/main.tf`, infrastructureData(opts))];
  const result = await tofu.tofuWithSpec(opts, specs,
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return resolvedCompute(result, fallbackParams(opts), compute.outputParams(result));
}

// -------------------------------------------------------------------- dns

// Two explicit records, both unproxied.
//
// Unproxied because Cloudflare's proxy is an HTTP proxy: UDP STUN on 3478 does
// not survive it, and TLS-ALPN-01 — which is how these certificates are issued
// — terminates at the proxy rather than at Traefik. `signoz` proxies its single
// record; this deployment cannot.
//
// Two explicit names rather than a wildcard. The upstream article needs a
// wildcard because it exposes services through NetBird's own reverse proxy;
// this package routes Authentik with Traefik directly, so nothing resolves
// under the wildcard and publishing one would only widen the surface a future
// catch-all router could serve.
export function dnsJson(opts: Opts): string {
  return tofu.constructsJson([
    tofu.construct("resource", "cloudflare_dns_record", "netbird", {
      zone_id: "${data.cloudflare_zone.zone.id}",
      name: opts["netbird-host"], content: opts.ip, type: "A",
      proxied: false, ttl: 60,
    }),
    tofu.construct("resource", "cloudflare_dns_record", "authentik", {
      zone_id: "${data.cloudflare_zone.zone.id}",
      name: opts["netbird-authentik-host"], content: opts.ip, type: "A",
      proxied: false, ttl: 60,
    }),
  ]);
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, dnsTool);
  const data: Opts = {
    ...opts,
    ip: opts.ip ?? fallbackParams(opts).ip,
    "netbird-zone": validate.zone(opts),
  };
  const specs = [
    spec(template("dns/main.tf", dnsMainTf), `${dir}/main.tf`, data),
    rawSpec(`${dir}/record.tf.json`, dnsJson(data)),
  ];
  return tofu.tofuWithSpec(opts, specs, { dir, env: credentialEnv(opts, "provider-dns") });
}

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local/ansible.cfg", ansibleLocalCfg), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local/inventory.ini", ansibleLocalInventory), `${dir}/inventory.ini`, data),
    spec(template("ansible-local/main.yml", ansibleLocalMain), `${dir}/main.yml`, data),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ip: opts.ip ?? fallbackParams(opts).ip,
      user: opts.user ?? "root",
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
}

// ---------------------------------------------------------------- ansible

function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value ?? null);
}

export function inventory(opts: Opts): string {
  return pretty({
    all: {
      children: {
        netbird: {
          hosts: {
            [String(opts.profile)]: {
              ansible_host: opts.ip ?? "192.0.2.10",
              ansible_user: "root",
            },
          },
        },
      },
    },
  });
}

// Template values for the Ansible stage.
//
// Deliberately carries none of the operator secrets. They reach the host as
// Ansible `lookup('env', ...)` expressions written literally into main.yml,
// where `PRESERVE_JINJA_DELIMITERS` passes them through untouched — routing
// them through this map instead would let the renderer HTML-escape the quotes
// and hand Ansible `&#39;`. The secret therefore exists only in the process
// that needs it: not in `.colors/`, not in a golden, not in this map.
export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "traefik-ip": validate.traefikIp(opts),
    "ssh-keygen": validate.keygen(opts),
  };
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
  const files: Array<[string, string]> = [
    ["ansible.cfg", ansibleCfg],
    ["main.yml", ansibleMain],
    ["cleanup.yml", ansibleCleanup],
    ["compose.yml", ansibleCompose],
    ["config.yaml", ansibleConfig],
    ["dashboard.env", ansibleDashboardEnv],
    ["blueprint.yaml", ansibleBlueprint],
    ["bootstrap.sh", ansibleBootstrap],
    ["federated-login.py", ansibleFederatedLogin],
    ["smoke.sh", ansibleSmoke],
    ["s3.py", ansibleS3],
    ["backup.sh", ansibleBackup],
    ["restore.sh", ansibleRestore],
    ["status.sh", ansibleStatus],
    ["backup.service", ansibleBackupService],
    ["backup-failure.service", ansibleBackupFailureService],
    ["backup.timer", ansibleBackupTimer],
  ];
  return [
    ...files.map(([name, content]) =>
      spec(template(`ansible/${name}`, content), `${dir}/${name}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(data)),
  ];
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  if (opts["red/event"] === "delete" && !opts.ip) {
    // No compute in state: there is no host to stop, and the cleanup play
    // would only fail against the placeholder address.
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "main.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// ------------------------------------------------------------- acceptance

async function run(args: string[]) {
  return runtime.exec(args, { timeoutMs: 20000 });
}

async function out(args: string[]): Promise<string> {
  return String((await run(args)).out ?? "").trim();
}

// True once `args` exits zero, retrying every five seconds.
export async function waitFor(args: string[], attempts: number): Promise<boolean> {
  for (let remaining = attempts; ; remaining -= 1) {
    const result = await run(args);
    if (result.exit === 0) return true;
    if (remaining <= 0) return false;
    await Bun.sleep(5000);
  }
}

// Why the certificate for `host` is not acceptable, or undefined when it is.
//
// Traefik answers 443 with a self-signed default certificate when ACME has
// failed, so a reachable HTTPS endpoint proves nothing on its own. Three
// separate facts are checked: the chain validates against the system trust
// store (`curl` without `-k` fails otherwise), the certificate names this host,
// and it is not about to expire. Matching the issuer string against "Let's
// Encrypt" would be the brittle version — chains get renamed, and a renamed
// chain is not an outage.
export async function certError(host: string): Promise<string | undefined> {
  const sClient = `echo | openssl s_client -servername ${host} -connect ${host}:443 2>/dev/null`;
  if ((await run(["curl", "-fsS", "-o", "/dev/null", `https://${host}/`])).exit !== 0) {
    return `the certificate for ${host} is not trusted by the system store; Traefik is ` +
      "probably serving its self-signed default because ACME failed";
  }
  if (!(await out(["sh", "-c", `${sClient} | openssl x509 -noout -ext subjectAltName`])).includes(host)) {
    return `the certificate served for ${host} does not name it`;
  }
  if ((await run(["sh", "-c", `${sClient} | openssl x509 -noout -checkend 604800`])).exit !== 0) {
    return `the certificate for ${host} expires within seven days and has not renewed`;
  }
  return undefined;
}

// Whether a TCP port refuses a connection from out here. `bind to loopback`
// regresses silently while every positive check still passes, so absence is
// asserted rather than assumed.
export async function closed(host: unknown, port: number): Promise<boolean> {
  const probe = `timeout 5 bash -c '</dev/tcp/${host}/${port}' 2>/dev/null`;
  return (await run(["sh", "-c", probe])).exit !== 0;
}

// Public health checks after a real create.
//
// What runs here is what the internet can see. The end-to-end proofs that need
// the host's own credentials — the device-code grant, two peers exchanging
// traffic over the relay — run inside the playbook, where the durable PAT
// lives.
export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const host = String(opts["netbird-host"]);
  const authentikHost = String(opts["netbird-authentik-host"]);
  const ip = opts.ip;
  if (!(await waitFor(["curl", "-fsS", "-o", "/dev/null", `https://${host}/`], 60))) {
    return { ...opts, "red/exit": 1,
      "red/err": "the NetBird dashboard did not become reachable over HTTPS" };
  }
  const certErrors = (await Promise.all([host, authentikHost].map(certError)))
    .filter((error): error is string => error !== undefined);
  // The dashboard substitutes its configuration into the built assets at
  // container start, and the script that does it exits non-zero on a missing
  // variable while supervisord carries on. nginx then serves the placeholders
  // verbatim and every request for `/` still returns 200 — so the page has to
  // be read, not merely fetched. This shipped once already.
  const page = await out(["curl", "-fsS", `https://${host}/`]);
  const chunks = [...new Set(page.match(/\/_next\/static\/chunks\/[A-Za-z0-9_.\-]+\.js/g) ?? [])]
    .slice(0, 6);
  let unsubstituted: string | undefined;
  for (const url of chunks) {
    if ((await out(["curl", "-fsS", `https://${host}${url}`])).includes("$NETBIRD_")) {
      unsubstituted = url;
      break;
    }
  }
  const disco = await out(["curl", "-fsS",
    `https://${authentikHost}/application/o/netbird/.well-known/openid-configuration`]);
  // Ports that must not be open from outside. Postgres, Redis and Authentik's
  // own 9000 are reachable only on the compose network; the article opens 9000
  // for first-run setup, and this package never does.
  const open: number[] = [];
  for (const port of [5432, 6379, 9000, 9090, 8080]) {
    if (!(await closed(ip, port))) open.push(port);
  }
  if (certErrors.length > 0) {
    return { ...opts, "red/exit": 1, "red/err": certErrors.join("; ") };
  }
  if (unsubstituted) {
    return { ...opts, "red/exit": 1,
      "red/err": `the dashboard is serving unsubstituted configuration in ` +
        `${unsubstituted}; init_react_envs failed at container start ` +
        "(a missing variable makes it exit 1 while nginx keeps serving)" };
  }
  if (!disco.includes("device_authorization_endpoint")) {
    return { ...opts, "red/exit": 1,
      "red/err": "the Authentik issuer does not advertise a device " +
        "authorization endpoint; CLI enrolment would fail" };
  }
  if (open.length > 0) {
    return { ...opts, "red/exit": 1,
      "red/err": `ports that must not be public answered: ${open.join(", ")}` };
  }
  return { ...opts, "red/exit": 0,
    "netbird/acceptance": {
      dashboard: "configured",
      certificates: "trusted",
      oidc: "complete",
      "closed-ports": "confirmed",
    } };
}
