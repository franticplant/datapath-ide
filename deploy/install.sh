#!/bin/bash
# Install or update the Datapath Studio bridge on this host (Rocky/RHEL 10, systemd >= 257).
# Run as root from an unpacked release: /opt/datapath-studio/releases/<id>/deploy/install.sh
#   --enforce-selinux   build the SELinux module without the permissive line (after reviewing AVCs)
#   --jitless           also install the JIT-free MemoryDenyWriteExecute profile (no WASM tools)
#   --uninstall         stop and remove units, Serve mapping and SELinux module (keeps workspace + token)
# Environment: SERVE_PORT (tailnet HTTPS port, default 47391), KEEP_RELEASES (default 3).
set -euo pipefail

PREFIX=/opt/datapath-studio
UNIT=datapath-bridge
LOOPBACK=127.0.0.1:18473
SERVE_PORT=${SERVE_PORT:-47391}
KEEP_RELEASES=${KEEP_RELEASES:-3}
CRED=/etc/credstore.encrypted/$UNIT.token
DROPIN=/etc/systemd/system/$UNIT.service.d
RELEASE=$(cd "$(dirname "$0")/.." && pwd -P)
ENFORCE=0 JITLESS=0 UNINSTALL=0
for arg; do
  case $arg in
    --enforce-selinux) ENFORCE=1 ;;
    --jitless) JITLESS=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
step() { printf '\n==> %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }

if [ $UNINSTALL = 1 ]; then
  step 'removing Tailscale Serve mapping, units and SELinux module'
  tailscale serve --https="$SERVE_PORT" off 2>/dev/null || true
  systemctl disable --now "$UNIT.socket" "$UNIT.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT.socket" "/etc/systemd/system/$UNIT.service" /usr/local/sbin/datapath-pair /etc/datapath-bridge.env
  rm -rf "$DROPIN"
  systemctl daemon-reload
  semanage port -d -p tcp "${LOOPBACK##*:}" 2>/dev/null || true
  semodule -r datapath_bridge 2>/dev/null || true
  echo "kept: workspace /var/lib/private/$UNIT, token $CRED, releases $PREFIX"
  exit 0
fi

case $RELEASE in "$PREFIX"/releases/*) ;; *) echo "expected to run from $PREFIX/releases/<id>, not $RELEASE" >&2; exit 1 ;; esac

step 'Node.js 22 from AppStream (no npm, no weak deps)'
rpm -q nodejs >/dev/null 2>&1 || dnf -y -q install --setopt=install_weak_deps=False nodejs
node_major=$(/usr/bin/node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || { echo "need Node >= 22, have $node_major" >&2; exit 1; }

step "release $(basename "$RELEASE")"
chown -R root:root "$RELEASE"
chmod -R u=rwX,go=rX "$RELEASE"
ln -sfn "$RELEASE" "$PREFIX/current.new" && mv -Tf "$PREFIX/current.new" "$PREFIX/current"
# Keep the newest releases (the current one is always kept).
ls -1dt "$PREFIX"/releases/*/ | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  [ "${old%/}" = "$RELEASE" ] || rm -rf -- "$old"
done

step 'bridge token (systemd credential, encrypted with the host key)'
if [ ! -s "$CRED" ]; then
  install -d -m 0700 "$(dirname "$CRED")"
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' \
    | systemd-creds encrypt --with-key=host --name=bridge-token - "$CRED"
  chmod 0600 "$CRED"
  echo "created $CRED"
else
  echo "keeping $CRED"
fi

step 'systemd units'
install -m 0644 "$RELEASE/deploy/systemd/$UNIT.socket" "$RELEASE/deploy/systemd/$UNIT.service" /etc/systemd/system/
install -d -m 0755 "$DROPIN"
if [ $JITLESS = 1 ]; then install -m 0644 "$RELEASE/deploy/systemd/jitless.conf" "$DROPIN/"; else rm -f "$DROPIN/jitless.conf"; fi

if selinuxenabled 2>/dev/null; then
  step "SELinux domain datapath_bridge_t ($([ $ENFORCE = 1 ] && echo enforcing || echo permissive))"
  rpm -q selinux-policy-devel >/dev/null 2>&1 || dnf -y -q install selinux-policy-devel
  build=$(mktemp -d)
  trap 'rm -rf "$build"' EXIT
  cp "$RELEASE/deploy/selinux/datapath_bridge.fc" "$build/"
  if [ $ENFORCE = 1 ]; then sed '/#@PERMISSIVE@/d' "$RELEASE/deploy/selinux/datapath_bridge.te" > "$build/datapath_bridge.te"
  else sed 's/^#@PERMISSIVE@ //' "$RELEASE/deploy/selinux/datapath_bridge.te" > "$build/datapath_bridge.te"; fi
  make -s -C "$build" -f /usr/share/selinux/devel/Makefile datapath_bridge.pp
  semodule -i "$build/datapath_bridge.pp"
  semanage port -a -t datapath_bridge_port_t -p tcp "${LOOPBACK##*:}" 2>/dev/null \
    || semanage port -m -t datapath_bridge_port_t -p tcp "${LOOPBACK##*:}"
  restorecon -RF "$PREFIX"
  [ -d "/var/lib/private/$UNIT" ] && restorecon -RF "/var/lib/private/$UNIT"
  install -m 0644 "$RELEASE/deploy/systemd/selinux.conf" "$DROPIN/"
else
  rm -f "$DROPIN/selinux.conf"
fi

step 'pairing helper'
dns=$(tailscale status --json --self=true --peers=false | sed -n 's/^ *"DNSName": "\(.*\)\.",*$/\1/p' | head -1)
[ -n "$dns" ] || { echo 'could not read this node'"'"'s tailnet DNS name' >&2; exit 1; }
printf 'PUBLIC_URL=https://%s:%s/\nLOOPBACK_URL=http://%s/\n' "$dns" "$SERVE_PORT" "$LOOPBACK" > /etc/datapath-bridge.env
install -m 0750 "$RELEASE/deploy/datapath-pair" /usr/local/sbin/datapath-pair

step 'start'
systemd-analyze verify "/etc/systemd/system/$UNIT.socket" "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
systemctl enable --now "$UNIT.socket"
systemctl restart "$UNIT.service"   # picks up the new release; also starts it before the first request

step "Tailscale Serve: https://$dns:$SERVE_PORT/ -> http://$LOOPBACK (tailnet only, never Funnel)"
tailscale serve --bg --https="$SERVE_PORT" "http://$LOOPBACK"

step 'checks'
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fsS "http://$LOOPBACK/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://$LOOPBACK/healthz"; echo
systemctl --no-pager --lines=3 status "$UNIT.service" | sed -n '1,4p'
systemd-analyze security --no-pager "$UNIT.service" | tail -1
if selinuxenabled 2>/dev/null; then ps -eZ | grep -E 'datapath_bridge_t' | head -1 || echo 'WARNING: service is not running in datapath_bridge_t'; fi
echo
echo "Done. Pair devices with: datapath-pair   (prints the one-time URL + QR code)"
