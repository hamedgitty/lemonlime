#!/usr/bin/env bash
# Firewall for self-hosted cloud threads (compose.yaml), run as root on the Docker host.
#
#   sudo bash scripts/sandbox-firewall.sh          # apply (safe to run again)
#   sudo bash scripts/sandbox-firewall.sh remove   # take the rules out
#
# Sandboxes run code you didn't write (dependencies, agent commands). With these rules a
# sandbox can reach the internet and the proxy's runner port, and nothing else:
#   - not other sandboxes (other people's dev servers and databases),
#   - not this host, nor private networks (your LAN or cloud VPC),
#   - not the cloud metadata service (169.254.169.254, which hands out the server's own
#     cloud credentials),
#   - not outbound mail ports (spam).
# The proxy can still reach every sandbox's runner port. scripts/install-ubuntu.sh
# installs this as a systemd service so it comes back after a reboot.
set -euo pipefail

SUBNET="${LEMONLIME_SANDBOX_SUBNET:-172.30.0.0/16}"
PROXY_IP="${LEMONLIME_PROXY_IP:-172.30.0.2}"
BRIDGE="${LEMONLIME_SANDBOX_BRIDGE:-lemonlime-sb}"
RUNNER_PORT="${LEMONLIME_RUNNER_PORT:-7420}"
CHAIN=LEMONLIME-SANDBOX
INPUT_CHAIN=LEMONLIME-SANDBOX-IN

[ "$(id -u)" -eq 0 ] || { echo "sandbox-firewall: run as root" >&2; exit 1; }

unhook() {
  while iptables -D DOCKER-USER -j "$CHAIN" 2>/dev/null; do :; done
  while iptables -D INPUT -i "$BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null; do :; done
  for c in "$CHAIN" "$INPUT_CHAIN"; do
    iptables -F "$c" 2>/dev/null || true
    iptables -X "$c" 2>/dev/null || true
  done
}

if [ "${1:-}" = "remove" ]; then
  unhook
  echo "sandbox-firewall: removed"
  exit 0
fi

# Docker creates DOCKER-USER when it starts; make sure it exists so this can run first.
iptables -N DOCKER-USER 2>/dev/null || true
unhook

# Traffic between containers, and from containers to the outside, passes DOCKER-USER.
iptables -N "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# The proxy reaches runners; sandboxes reach the proxy (its :8080 runner API, and its
# public site, which is how apps on this host are reached too).
iptables -A "$CHAIN" -s "$PROXY_IP" -d "$SUBNET" -p tcp --dport "$RUNNER_PORT" -j RETURN
iptables -A "$CHAIN" -s "$SUBNET" -d "$PROXY_IP" -p tcp -m multiport --dports 80,443,8080 -j RETURN
# Anything else inside the sandbox network: sandbox to sandbox.
iptables -A "$CHAIN" -s "$SUBNET" -d "$SUBNET" -j DROP
# Out of the sandbox network: no metadata service, private ranges or mail ports.
for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  iptables -A "$CHAIN" -s "$SUBNET" -d "$net" -j DROP
done
iptables -A "$CHAIN" -s "$SUBNET" -p tcp -m multiport --dports 25,465,587 -j DROP
iptables -A "$CHAIN" -j RETURN
iptables -I DOCKER-USER 1 -j "$CHAIN"

# Traffic from the sandbox network to this host itself goes through INPUT instead.
# Containers resolve names through Docker's built-in DNS inside their own network
# namespace, so they never need the host.
iptables -N "$INPUT_CHAIN"
iptables -A "$INPUT_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$INPUT_CHAIN" -s "$SUBNET" -j DROP
iptables -A "$INPUT_CHAIN" -j RETURN
iptables -I INPUT 1 -i "$BRIDGE" -j "$INPUT_CHAIN"

echo "sandbox-firewall: sandboxes in $SUBNET can reach the internet and the proxy only"
