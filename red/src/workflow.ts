import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider, "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// Compute params recorded in the infrastructure state; undefined when the
// state holds none. An unreadable backend throws the SDK's `StepError`, which
// `compute.readState` turns into `{ error }` — create and delete treat the two
// differently. Kept local, and injectable into `startStep`, so tests never
// shell out to tofu.
export async function stateOutput(opts: Opts): Promise<compute.Params | undefined> {
  const outputs = await tofu.outputs(
    tools.toolDir(opts, tools.infrastructureTool),
    tools.backendCredentialEnv(opts),
  );
  const params = outputs.params;
  return params && typeof params === "object" ? params as compute.Params : undefined;
}

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  reader: compute.StateReader = stateOutput,
): Promise<Opts> {
  // The state is read once, up front, on the same defaulted and overlaid opts
  // the validators see — the overlay is what carries the backend credentials —
  // and only for the two events that touch a provider. The validator and the
  // after-validate share the one read; the reader is injectable so tests never
  // shell out to tofu.
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const context: PreflightContext = {
    event: typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined,
    real: !overlaid["red/dry-run"],
  };
  const state: compute.StateRead = compute.lifecycleEvent(context)
    ? await compute.readState(overlaid, reader) : {};
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Standard §4 before the credentials: a recorded provider that differs
      // from the selected one reports the actionable error, not a missing
      // token for the provider that was just selected. The thunk carries the
      // event, so a delete still asks for no account password.
      (current, _environment, ctx) => (compute.lifecycleEvent(ctx)
        ? compute.providerValidator(validate.spec, current, state.params,
                                    () => validate.secretErrors(current, ctx.event))
        : []),
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    // The machine key's create matrix and the Vultr preflight run before any
    // template is rendered: an unowned key on disk or at the provider stops
    // the run while stopping is still free. Delete fills the same template
    // values — a destroy renders before it destroys — and adopts the recorded
    // address, but checks no key, because its key cleanup runs after the
    // compute destroy.
    afterValidate: async (current, _environment, { event, real }) => {
      if (real && event === "delete") return compute.adoptState(current, "delete", state);
      if (real && event === "create") {
        let next = await ssh.ensureKey(current, async () => state.params);
        if (failed(next)) return next;
        next = await ssh.preflight(ssh.withMachineKey(next));
        if (!failed(next)) next = sshConfig.preflight(next);
        return failed(next) ? next : { ...next, "red/exit": 0 };
      }
      return { ...ssh.withMachineKey(current), "red/exit": 0 };
    },
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "netbird/start": [startStep, "netbird/ansible"],
      "netbird/ansible": [tools.ansibleStep, "netbird/dns"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "netbird/dns": [tools.dnsStep, "netbird/ssh-config"],
      "netbird/ssh-config": [tools.ansibleLocalStep, "netbird/infrastructure"],
      "netbird/infrastructure": [tools.infrastructureStep, "netbird/ssh-cleanup"],
      "netbird/ssh-cleanup": [ssh.cleanupStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "netbird/start": [startStep, "netbird/infrastructure"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine.
    "netbird/infrastructure": [tools.infrastructureStep, "netbird/ssh-config"],
    "netbird/ssh-config": [tools.ansibleLocalStep, "netbird/dns"],
    // DNS before convergence: Traefik asks Let's Encrypt for a certificate
    // the moment it starts, and TLS-ALPN-01 only succeeds once the names
    // resolve to this host. The record existing is necessary but not
    // sufficient — the playbook additionally waits for public resolvers to
    // carry it before starting anything.
    "netbird/dns": [tools.dnsStep, "netbird/ansible"],
    "netbird/ansible": [tools.ansibleStep, "netbird/acceptance"],
    "netbird/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? ""}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "netbird/infrastructure", "netbird/dns", "netbird/ssh-config",
  "netbird/ansible", "netbird/acceptance", "netbird/ssh-cleanup",
];

function create() {
  let wf = workflow({ start: "netbird/start", wireFn });
  wf = adviceAdd(wf, "netbird/infrastructure", "before", "netbird.workflow/backend",
    backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "netbird/dns", "before", "netbird.workflow/backend",
    backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const netbirdWorkflow = create();
