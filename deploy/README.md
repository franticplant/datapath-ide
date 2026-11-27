# Deploying the sync bridge

`server/bridge.mjs` is one Node process. It serves the IDE, keeps a workspace directory in sync with
every connected browser tab over `/ws`, and answers MCP on `POST /mcp`. Any setup that keeps it
running and puts HTTPS in front of it will work. This page covers what every deployment needs,
then walks through the systemd + Tailscale setup whose files live in this directory.

## What any deployment needs

- **Node.js 22 or newer**, and a persistent workspace directory the bridge can write to.
- **A token.** In order of precedence, the bridge takes `--token`, `$DATAPATH_BRIDGE_TOKEN`,
  `--token-file`, the systemd credential `bridge-token`, or else generates
  `<workspace>/.bridge-token` (mode 0600). Anyone holding the token can read and write the workspace
  and, where a tab allows it, drive the IDE.
- **HTTPS for phones.** The offline app (service worker, Add to Home Screen) needs a secure context.
  Keep the bridge on loopback and let a proxy terminate TLS: Tailscale Serve, Caddy, nginx and so on.
  The proxy must pass WebSocket upgrades on `/ws`. The app uses only relative URLs, so it works at a
  host's root or under a path prefix, as long as the proxy strips the prefix.

| Option | Purpose |
|---|---|
| `--host 127.0.0.1 --port 18473` | Where to listen (default) |
| `--listen-fd N` / systemd `LISTEN_FDS` | Use a socket opened by a supervisor instead of listening itself |
| `--dir DIR` | Workspace directory (default `workspace`) |
| `--token TOKEN` / `--token-file FILE` | Access token; a token from a file or credential is never logged |
| `--no-wasm` | Drop the server-side Icarus tools `verilog_simulate` and `verilog_elaborate`; automatic under `node --jitless` |
| `--poll-ms 1000` | How often to pick up edits made directly on disk |

The quickest way to run it is `make serve-sync WORKSPACE=…`, in the foreground, which prints a
pairing link. Everything below is about running it permanently.

## Reference setup: systemd + Tailscale Serve

The files here deploy the bridge as a hardened systemd service and publish it to a tailnet with
Tailscale Serve. They were written for a RHEL-family host (Rocky Linux 10, systemd 257, SELinux
enforcing). The unit files work on any recent systemd. `install.sh` additionally assumes `dnf`,
and it loads the SELinux module only where SELinux is enabled.

```
browser / phone / MCP client ──https, tailnet only──▶ tailscaled (Serve :47391)
                                                        │
                       datapath-bridge.socket   127.0.0.1:18473, loopback peers only
                                                        │ fd 3
                       datapath-bridge.service  node bridge.mjs (no network of its own)
```

| File | Role |
|---|---|
| `systemd/datapath-bridge.socket` | systemd owns the loopback listener and hands it to the service |
| `systemd/datapath-bridge.service` | The sandboxed service |
| `systemd/jitless.conf` | Optional drop-in: no JIT, writable+executable memory forbidden |
| `systemd/selinux.conf` | Drop-in that runs the service in its own SELinux domain |
| `selinux/datapath_bridge.{te,fc}` | That domain: `datapath_bridge_t` |
| `install.sh` | Installs or updates on the host (run as root) |
| `push.sh` | Copies a release from a checkout to the host and runs `install.sh` |
| `datapath-pair` | Prints the pairing link and QR code, or the MCP settings |

### How the service is confined

- **Network: inbound only.** With `PrivateNetwork=yes` the process has no interfaces and no DNS, and
  it can't connect anywhere. Its only way in is the socket systemd passes it, and the socket's eBPF
  filter (`IPAddressAllow=localhost`) admits only loopback peers. `RestrictAddressFamilies=AF_UNIX`
  stops it from creating IP sockets at all.
- **Identity.** It runs as a `DynamicUser` inside a user namespace, with no capabilities,
  `NoNewPrivileges` and locked securebits.
- **Files.** The OS is read-only. `/home`, `/srv`, `/mnt`, `/media`, the rest of `/opt`, and the SSH,
  credstore and Tailscale state are hidden. The workspace is the only writable path, and nothing it
  can write is executable (`NoExecPaths=/`).
- **Kernel and syscalls.** Kernel tunables, modules, logs, clock, hostname, cgroups and other
  processes are all protected; it can't create namespaces or use realtime scheduling. A seccomp
  allowlist (`@system-service` minus the privileged groups) applies on top.
- **SELinux.** `datapath_bridge_t` has no permission to bind or connect to any port and can't
  execute other programs. It can read the application files and read and write the workspace.
- **Secrets.** The token is a `LoadCredentialEncrypted=` credential, encrypted with the TPM where one
  exists or with the host key otherwise. It is never stored in the workspace or the journal.
- **Limits.** Memory, task, CPU and file-descriptor limits apply, and `node` runs with
  `--disallow-code-generation-from-strings`.

`systemd-analyze security datapath-bridge.service` scores the service 0.2 ("SAFE"), with or without
the jitless profile. That score rounds away the jitless profile's one extra protection,
`MemoryDenyWriteExecute`.

**Trade-offs.** `MemoryDenyWriteExecute` is off by default, because V8's JIT (and so WebAssembly,
which the server-side Icarus tools use) needs writable+executable pages. The `--jitless` profile
turns it on and gives up those two tools; simulation still runs in each browser tab. The service
uses the distro's Node and libraries rather than a `RootDirectory=`, so they keep receiving
security updates.

### Install, update, remove

From a checkout, with root SSH access to the host:

```sh
deploy/push.sh HOST                    # new release in /opt/datapath-studio/releases/<id>, then install.sh
deploy/push.sh HOST --jitless          # with the JIT-free profile
deploy/push.sh HOST --enforce-selinux  # SELinux domain enforcing instead of permissive
ssh -t HOST 'bash /opt/datapath-studio/current/deploy/install.sh --uninstall'   # keeps workspace and token
```

You can run `install.sh` again at any time. Each run:
1. Installs Node from the distro without weak dependencies.
2. Makes the release root-owned and read-only, and keeps the last three releases.
3. Creates the token once.
4. Installs the units and the SELinux module.
5. Restarts the service.
6. Maps `tailscale serve --https=$SERVE_PORT` (default 47391) to the socket.
7. Prints a health check and the security score.

The SELinux domain is installed **permissive** at first: it logs what it would deny but blocks
nothing. Once `ausearch -m AVC,USER_AVC -su datapath_bridge_t` shows nothing unexpected, redeploy
with `--enforce-selinux`.

To use another proxy, skip the Serve step and point the proxy at `127.0.0.1:18473`.

## Pairing browsers and phones

Each browser needs the token once. Open the bridge URL with `?bridgeToken=<token>` appended. The
page saves the token and removes it from the address bar and from history. In the reference setup,
`datapath-pair` on the host prints this link together with a QR code. You can also paste the token
into **Sync & MCP Bridge**, which opens from the status pill or the command palette.

- **Desktop:** open the link. The status pill changes to `● Synced`.
- **iPhone:** open the link in Safari, then Share → **Add to Home Screen**. A Home Screen app keeps
  its own storage, so pair it once more from inside the app.
- **Android:** open the link in Chrome, then ⋮ → **Install app**. The installed app shares Chrome's
  storage and is already paired.

If the server is unreachable (for example, the phone's VPN is off), the pill shows
`○ Reconnecting (local)`. Edits are kept locally and pushed when the connection comes back.

**Allow MCP remote control** is a per-tab setting. It lets MCP clients drive that tab: open files,
run simulations, move the waveform cursor. Sync works with it on or off. A pairing link turns it on
unless the link includes `bridgeRemote=0`, which `datapath-pair` always adds.

**Using another copy of the IDE.** Any copy of the IDE, such as the GitHub Pages site, can sync with
a bridge. Add `bridgeUrl=wss://<bridge host>/ws` to the pairing link, or enter the URL in the dialog.
The token is stored per origin, so every site on that origin can read it (for example, all
`<user>.github.io` pages). Prefer the IDE that the bridge serves itself.

To unpair one device, clear the token in its dialog. To revoke every device, rotate the token: in
the reference setup, delete `/etc/credstore.encrypted/datapath-bridge.token` and redeploy.

## Connecting MCP clients

The endpoint is `<bridge URL>/mcp` with the header `Authorization: Bearer <token>`. On the bridge host
itself, `http://127.0.0.1:18473/mcp` also works. Keep the token in an environment variable such as
`DATAPATH_BRIDGE_TOKEN` rather than in a config file. In the reference setup,
`ssh HOST datapath-pair --token` prints it.

Claude Code, in a project `.mcp.json` (the file holds no secret):

```json
{ "mcpServers": { "datapath-studio": {
    "type": "http",
    "url": "https://bridge.example.ts.net:47391/mcp",
    "headers": { "Authorization": "Bearer ${DATAPATH_BRIDGE_TOKEN}" } } } }
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.datapath-studio]
url = "https://bridge.example.ts.net:47391/mcp"
bearer_token_env_var = "DATAPATH_BRIDGE_TOKEN"
```

Clients that speak only stdio can run `node mcp/server.mjs --url <bridge URL> --token "$DATAPATH_BRIDGE_TOKEN"`.

## Operating the reference setup

```sh
systemctl status datapath-bridge.socket datapath-bridge.service
journalctl -u datapath-bridge -f
curl -s http://127.0.0.1:18473/healthz        # {"ok":true,"rev":…,"clients":…}
tailscale serve status
```

The workspace is at `/var/lib/datapath-bridge/workspace`, which points into
`/var/lib/private/datapath-bridge`. Back it up like any other state directory. Files edited there
directly reach every tab within the poll interval.
