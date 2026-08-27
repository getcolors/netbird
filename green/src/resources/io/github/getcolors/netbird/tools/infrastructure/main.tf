terraform {
  required_providers {
    vultr = { source = "vultr/vultr", version = "~> 2.0" }
  }
}

provider "vultr" {
  # api key comes from VULTR_API_KEY in the environment
}

locals {
  ssh_sources  = <{ ssh-sources-hcl|safe }>
  http_sources = <{ http-sources-hcl|safe }>
  stun_sources = <{ stun-sources-hcl|safe }>
}

<% if ssh-keygen %># The machine keypair this deployment generated and owns (SSH Keypair
# Standard): the account resource is named after the profile and lives in this
# stack's state, which is what makes its ownership decidable. Never reference a
# literal key id here in keygen mode.
resource "vultr_ssh_key" "machine" {
  name    = "<{ profile }>"
  ssh_key = trimspace(file("<{ ssh-public-key-path }>"))
}

<% endif %># Every label derives from one resolved name (Compute Name Standard §3), which
# defaults to the profile. Templates never branch on whether an override was
# supplied — that decision was made once, in Clojure.
resource "vultr_firewall_group" "netbird" {
  description = "<{ compute-name }>-firewall"
}

resource "vultr_firewall_rule" "ssh" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.netbird.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# 80 carries only the redirect to 443. Certificate issuance uses TLS-ALPN-01 on
# 443, so closing 80 would not break ACME — it would only strip the redirect.
resource "vultr_firewall_rule" "http" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.netbird.id
  protocol          = "tcp"
  port              = "80"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# 443 carries the dashboard, the management and signal gRPC streams, the relay
# WebSocket, the API and the embedded IdP — the combined server multiplexes all
# of them behind Traefik.
resource "vultr_firewall_rule" "https" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.netbird.id
  protocol          = "tcp"
  port              = "443"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# The only UDP this deployment publishes. STUN is bundled into the combined
# server, so there is no coturn container and no legacy 49152-65535 relay
# range: relayed traffic rides the WebSocket on 443.
resource "vultr_firewall_rule" "stun" {
  for_each          = toset(local.stun_sources)
  firewall_group_id = vultr_firewall_group.netbird.id
  protocol          = "udp"
  port              = "<{ netbird-stun-port }>"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

resource "vultr_instance" "netbird" {
  # `label` is the console name and updates in place. There is deliberately no
  # `hostname`: Vultr implements a hostname change as an OS reinstall, so the
  # provider marks that attribute ForceNew, and editing the name would destroy
  # the instance and its disk rather than rename it. Compute Name Standard §4:
  # a rename takes effect at the provider, and the guest hostname lags until a
  # rebuild.
  label             = "<{ compute-name }>"
  region            = "<{ vultr-region }>"
  plan              = "<{ vultr-plan }>"
  os_id             = <{ vultr-os-id }>
  firewall_group_id = vultr_firewall_group.netbird.id
  # IPv6 is off rather than unmanaged. Docker will happily publish on a v6
  # address, and firewall rules and source CIDRs can diverge from their v4
  # counterparts; for a single-node box one family is one set of rules to get
  # right instead of two.
  enable_ipv6       = false
  # SSH keys are ids already in the account, and ForceNew: changing the key set
  # destroys and recreates the instance instead of re-authorizing it. Rotation
  # is a rebuild, never an edit on a machine whose disk you intend to keep.
<% if ssh-keygen %>  ssh_key_ids = [vultr_ssh_key.machine.id]
<% else %>  ssh_key_ids = ["<{ vultr-ssh-keys }>"]
<% endif %>  # Wait for ssh before starting Ansible.
  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
<% if ssh-keygen %>    private_key = file("<{ ssh-private-key-path }>")
<% endif %>  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

output "params" {
  value = {
    ip     = vultr_instance.netbird.main_ip
    user   = "root"
    sudoer = "root"
    name   = "<{ compute-name }>"
<% if ssh-keygen %>    ssh_key_id = vultr_ssh_key.machine.id
<% endif %>  }
}
