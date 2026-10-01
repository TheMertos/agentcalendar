#!/usr/bin/env bash
# Shared Hermes profile → AgentCalendar principal naming (fail closed).

# Derive canonical AgentCalendar principal from inherited HERMES_HOME.
# @param $1 HERMES_HOME value
# @stdout principal name
derive_principal_from_hermes_home() {
  local home="${1:-}"
  home="${home#"${home%%[![:space:]]*}"}"
  home="${home%"${home##*[![:space:]]}"}"
  while [[ "${home}" == */ && "${home}" != "/" ]]; do
    home="${home%/}"
  done
  if [[ -z "${home}" ]]; then
    echo "HERMES_HOME is required" >&2
    return 1
  fi

  local principal=""
  if [[ "${home}" =~ ^(.+)/\.hermes/profiles/([^/]+)$ ]]; then
    principal="${BASH_REMATCH[2]}"
  elif [[ "${home}" =~ ^(.+)/\.hermes$ ]]; then
    principal="default"
  else
    echo "cannot derive principal from HERMES_HOME (expected .../.hermes or .../.hermes/profiles/<name>)" >&2
    return 1
  fi

  if ! validate_agentcalendar_profile_name "${principal}"; then
    echo "derived principal contains invalid characters" >&2
    return 1
  fi

  printf '%s' "${principal}"
}

# Validate a profile/principal name.
# @param $1 profile name
validate_agentcalendar_profile_name() {
  local name="${1:-}"
  [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}
