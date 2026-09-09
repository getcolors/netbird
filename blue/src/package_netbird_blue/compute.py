"""Singleton compute delegation; DNS and warehouse configuration remain local."""
import json
from blue.cli import stage_dir
from pathlib import Path
from colors_compute import orchestrate, plan_deployment, read_deployment, validate, backend_plan, source_cidrs

TOPOLOGY = [{'count': 1}]


def requirements(opts):
    ssh = source_cidrs(opts, 'ssh-sources', 'netbird-ssh-sources')
    http = source_cidrs(opts, 'http-sources', 'netbird-http-sources')
    if not ssh: raise ValueError('SSH source list must not be empty')
    stun = source_cidrs(opts, 'stun-sources', 'netbird-stun-sources')
    return {'single_host': True, 'ipv6':False, 'security': {'egress': 'all', 'private_filter': False, 'ingress': [
        {'id': 'ssh', 'protocol': 'tcp', 'from_port': 22, 'to_port': 22, 'sources': ssh},
        *[{'id': 'web-' + str(port), 'protocol': 'tcp', 'from_port': port, 'to_port': port, 'sources': http} for port in (80, 443)],
        *([{'id':'stun','protocol':'udp','from_port':opts['netbird-stun-port'],'to_port':opts['netbird-stun-port'],'sources':stun}] if stun else [])
    ]}, 'legacy_state_keys': [opts['profile'] + '/netbird-infrastructure.tfstate']}


def settings(opts):
    return dict(opts)


def errors(opts):
    try:
        configured = settings(opts)
        result = validate(configured)
        if result:
            return result
        plan_deployment(configured, TOPOLOGY, requirements(configured))
        return []
    except (ValueError, TypeError, KeyError):
        return ['invalid singleton compute requirements']


def attach(opts, result):
    if result.get('status') not in ('planned', 'ready', 'present', 'destroyed'):
        return {**opts, 'blue/exit': 1, 'blue/err': '\n'.join(result.get('errors', [])) or 'compute lifecycle refused'}
    if result.get('status') == 'destroyed':
        return {**opts, 'blue/exit': 0, 'netbird/already-destroyed': True}
    cluster = result.get('cluster', {})
    node = next((node for node in cluster.get('nodes', []) if node['node_id'] == cluster.get('entry_node_id')), {})
    key = result.get('key', {})
    return {**opts, 'blue/exit': 0, 'colors-compute/cluster': cluster, 'colors-compute/key': key,
            **node, 'ssh-private-key-path': key.get('private_key_path') or node.get('ssh_identity_file')}


async def compute_step(opts):
    configured = settings(opts)
    planning = opts.get('blue/event') == 'build' or opts.get('blue/dry-run')
    result = plan_deployment(configured, TOPOLOGY, requirements(configured)) if planning else await orchestrate(configured, TOPOLOGY, requirements(configured))
    if planning:
        directory = Path(stage_dir(opts, 'compute'))
        stacks = [('shared', result['documents']['shared']), *[('nodes/' + node, docs) for node, docs in result['documents']['nodes'].items()]]
        for suffix, documents in stacks:
            target = directory / suffix
            target.mkdir(parents=True, exist_ok=True)
            state_key = result['state_keys']['shared'] if suffix == 'shared' else result['state_keys']['nodes'][suffix.split('/')[-1]]
            documents = {**documents, 'backend.tf.json': backend_plan(configured, state_key)['config']}
            for name, document in documents.items():
                (target / name).write_text(json.dumps(document, sort_keys=True, indent=2) + '\n')
    return attach(opts, result)


async def load_step(opts):
    if opts.get('blue/dry-run'):
        return opts
    return attach(opts, await read_deployment(settings(opts), requirements=requirements(opts)))
