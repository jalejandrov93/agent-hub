# Quota (Quota-Arc / CodexBar)

## Quota Arc and CodexBar

[Quota Arc](https://github.com/jalejandrov93/Quota-Arc) is a small notch pinned
to a screen edge that shows how much of each coding assistant's quota is used.
On Windows it can also show an **Agent Hub** cell, read from this dashboard:
jobs running and queued, open circuit breakers and human holds. When the
assistants live inside WSL, Quota Arc reads their quotas from
[CodexBar](https://github.com/steipete/CodexBar) running there.

Nothing needs configuring on the agent-hub side beyond running the dashboard
service ([Getting started](getting-started.md)).
Setup on the other two sides lives in Quota Arc's
[WSL remote mode guide](https://github.com/jalejandrov93/Quota-Arc/blob/main/docs/wsl-remote-mode.md),
which starts with a quick start. In short:

```sh
# inside WSL, from a Quota-Arc checkout
./wsl/install.sh                    # CodexBar: prints the sudo commands for its systemd unit
systemctl --user enable --now agent-hub-dashboard
```

```powershell
# on Windows
curl.exe http://127.0.0.1:8787/health          # CodexBar
curl.exe http://127.0.0.1:7777/api/state       # agent-hub dashboard
setx QUOTAARC_CODEXBAR_URL http://127.0.0.1:8787
```

**Always use `127.0.0.1`, never `localhost`, from Windows.** Windows resolves
`localhost` to `::1` first, and both this dashboard and CodexBar listen on IPv4
only, so a `localhost` request hangs until it times out rather than falling back.

