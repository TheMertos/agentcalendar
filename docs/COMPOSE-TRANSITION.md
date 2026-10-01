# Native host service and Compose transition

AgentCalendar's supported runtime is a native host service. Docker Compose remains available and is not removed. Do not delete the `agentcalendar-data` volume and do not stop the current container as part of this change. Interactive calendar access stays remote-only: no event mirror reads, no background sync worker, and no long-lived remote watch.

## Native layout

| Piece | Path |
| --- | --- |
| Hermes MCP wrapper | `tools/hermes-agentcalendar-mcp.sh` |
| Native launcher | `tools/agentcalendar-native-mcp.sh` |
| systemd user template | `deploy/systemd/user/agentcalendar@.service` |
| Data directory | `$HOME/.local/share/agentcalendar/<profile>/` |
| SecretFabric env file | `$HOME/.config/agentcalendar/<profile>.env` |

The wrapper derives the principal from `HERMES_HOME` and execs `node src/mcp/server.mjs` with `AGENTCAL_PROFILE`, `AGENTCAL_PRINCIPAL`, and `SECRET_FABRIC_PRINCIPAL` set to that principal. The user service uses `--service` and `AGENTCAL_NATIVE_HOLD=1`. It does not start sync.

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

## Compose

`compose.yaml` sets `AGENTCAL_SERVICE_MODE=docker` and `AGENTCAL_PRINCIPAL` from `AGENTCAL_PROFILE` (default `default`). It still starts only the MCP server. Leave the existing container and named volume in place until you retire them. The Hermes wrapper does not use `docker compose run`.
