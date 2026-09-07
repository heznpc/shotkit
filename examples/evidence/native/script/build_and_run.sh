#!/usr/bin/env bash
set -euo pipefail
native_fixture_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "${native_fixture_root}/../../../bin/take-a-repo.js" "${native_fixture_root}" --json
