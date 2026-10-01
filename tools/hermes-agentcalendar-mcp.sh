#!/usr/bin/env bash
# MCP security contract:
# The principal is derived only from inherited HERMES_HOME.
# Approval is required before event_write.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agentcalendar-hermes-profile.sh
source "${SCRIPT_DIR}/agentcalendar-hermes-profile.sh"

derive_principal_from_hermes_home "${HERMES_HOME:-}" >/dev/null
exec "${SCRIPT_DIR}/agentcalendar-native-mcp.sh"
