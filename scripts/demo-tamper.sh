#!/usr/bin/env bash
# Simulates an insider with database owner rights altering an audit record. They must first
# disable the append-only trigger — and the hash chain still catches it.
set -euo pipefail
echo "Disabling the append-only trigger and altering an audit row..."
databricks psql aiper-dev -- -q -c \
  "ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only; \
   UPDATE audit_log SET action='document.opened' WHERE id = (SELECT max(id) FROM audit_log WHERE action='document.saved'); \
   ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;" > /dev/null
echo "Done. Click 'Verify audit integrity' in the Audit tab — it will name the altered row."
echo "Run scripts/demo-reset.sh afterwards to restore a clean chain."
