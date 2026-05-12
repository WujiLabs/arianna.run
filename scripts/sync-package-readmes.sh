#!/usr/bin/env bash
# Sync package READMEs from the root README.
#
# Each per-package README is regenerated from a fixed per-package preamble plus
# the verbatim content of the root README. Idempotent: re-running produces the
# same bytes.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root_readme="${repo_root}/README.md"

if [[ ! -f "${root_readme}" ]]; then
  echo "error: root README not found at ${root_readme}" >&2
  exit 1
fi

write_package_readme() {
  local pkg_dir="$1"
  local pkg_name="$2"
  local bin_name="$3"
  local blurb="$4"

  local out="${repo_root}/${pkg_dir}/README.md"
  if [[ ! -d "${repo_root}/${pkg_dir}" ]]; then
    echo "error: package directory missing: ${pkg_dir}" >&2
    exit 1
  fi

  {
    printf '# %s\n\n' "${pkg_name}"
    printf '%s\n\n' "${blurb}"
    printf 'Installs the `%s` binary. Part of the [arianna.run](https://arianna.run) monorepo — see the project README below for the full architecture.\n\n' "${bin_name}"
    printf -- '---\n\n'
    cat "${root_readme}"
  } > "${out}"

  echo "wrote ${out} ($(wc -c < "${out}" | tr -d ' ') bytes)"
}

write_package_readme \
  "packages/cli" \
  "@arianna/cli" \
  "arianna" \
  "Command-line interface for arianna.run: \`arianna talk\`, \`arianna events\`, and the \`arianna profile\` / \`arianna fork\` profile-management surface."

write_package_readme \
  "packages/host" \
  "@arianna/tui" \
  "arianna-tui" \
  "Terminal UI and host daemon for arianna.run. Ships the \`arianna-tui\` front-end plus the shared \`127.0.0.1:9000\` daemon that brokers Docker operations across profiles."
