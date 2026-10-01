# Native host service

AgentCalendar's supported runtime is a native host service. Interactive calendar access stays remote-only: no event mirror reads, no background sync worker, and no long-lived remote watch. This repository does not ship a container image or Compose file.

## Native layout

| Piece | Path |
| --- | --- |
| Hermes MCP wrapper | `tools/hermes-agentcalendar-mcp.sh` |
| Native launcher | `tools/agentcalendar-native-mcp.sh` |
| systemd user template | `deploy/systemd/user/agentcalendar@.service` |
| Data directory | `$HOME/.local/share/agentcalendar/<profile>/` |
| SecretFabric env file | `$HOME/.config/agentcalendar/<profile>.env` |

The wrapper derives the principal from `HERMES_HOME` and execs `node src/mcp/server.mjs` with `AGENTCAL_PROFILE`, `AGENTCAL_PRINCIPAL`, and `SECRET_FABRIC_PRINCIPAL` set to that principal. When `SECRET_FABRIC_URL` or `SECRET_FABRIC_API_TOKEN` is empty, it fills only those empty values from `~/.config/agentcalendar/<profile>.env` (`$XDG_CONFIG_HOME/agentcalendar/<profile>.env` when `XDG_CONFIG_HOME` is set). Inherited non-empty values are kept. The process still exits if either value is missing, and it never prints secret values. The user service uses `--service` and `AGENTCAL_NATIVE_HOLD=1`. It does not start sync.

## Install and enable

Replace `<profile>` with the Hermes profile name (`default` for `~/.hermes`).

```bash
mkdir -p ~/.config/systemd/user ~/.config/agentcalendar
cp /home/mert/agentcalendar/deploy/systemd/user/agentcalendar@.service ~/.config/systemd/user/agentcalendar@.service
install -m 700 -d ~/.config/agentcalendar
umask 077
cat > ~/.config/agentcalendar/<profile>.env <<'EOF'
SECRET_FABRIC_URL=http://127.0.0.1:3000
SECRET_FABRIC_API_TOKEN=replace-me
EOF
chmod 600 ~/.config/agentcalendar/<profile>.env
systemctl --user daemon-reload
systemctl --user enable --now agentcalendar@<profile>.service
```

If the checkout is not `~/agentcalendar`, edit `WorkingDirectory` and `ExecStart` in the copied unit before `daemon-reload`.

Hermes MCP:

```bash
hermes mcp add agentcalendar -- /home/mert/agentcalendar/tools/hermes-agentcalendar-mcp.sh
```
