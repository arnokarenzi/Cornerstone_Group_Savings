#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DB_PORT="${DB_PORT:-3306}"
BACKUP_FILE="${1:-}"
: "${DB_HOST:?Set DB_HOST before restoring}"
: "${DB_USER:?Set DB_USER before restoring}"
: "${RESTORE_TARGET_DB:?Set RESTORE_TARGET_DB to the exact database to restore into}"

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: RESTORE_TARGET_DB=staging_db CONFIRM_RESTORE=YES $0 /path/to/backup.sql.gz[.enc]" >&2
  exit 2
fi
if [[ ! "$RESTORE_TARGET_DB" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "RESTORE_TARGET_DB contains unsupported characters." >&2
  exit 2
fi
if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  echo "Refusing to restore without CONFIRM_RESTORE=YES. Imports can conflict with existing records." >&2
  exit 3
fi
if [[ "${NODE_ENV:-}" == "production" && "${ALLOW_PRODUCTION_RESTORE:-}" != "YES" ]]; then
  echo "Refusing restore from a production environment. Set ALLOW_PRODUCTION_RESTORE=YES only after independent verification and approval." >&2
  exit 3
fi
command -v gzip >/dev/null 2>&1 || { echo "Required command not found: gzip" >&2; exit 127; }
command -v mysql >/dev/null 2>&1 || { echo "Required command not found: mysql" >&2; exit 127; }

if [[ -f "${BACKUP_FILE}.sha256" ]]; then
  command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required to verify this backup." >&2; exit 127; }
  (cd "$(dirname "$BACKUP_FILE")" && sha256sum --check "$(basename "$BACKUP_FILE").sha256")
else
  echo "WARNING: No checksum file found. Check the backup source before proceeding." >&2
  if [[ "${CONFIRM_MISSING_CHECKSUM:-}" != "YES" ]]; then
    echo "Set CONFIRM_MISSING_CHECKSUM=YES only if you have independently verified this backup." >&2
    exit 3
  fi
fi

DECRYPTED_GZIP=""
cleanup() { if [[ -n "$DECRYPTED_GZIP" ]]; then rm -f "$DECRYPTED_GZIP"; fi; }
trap cleanup EXIT
SOURCE_GZIP="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.enc ]]; then
  : "${BACKUP_ENCRYPTION_PASSPHRASE:?Set BACKUP_ENCRYPTION_PASSPHRASE to decrypt this backup}"
  command -v openssl >/dev/null 2>&1 || { echo "Required command not found: openssl" >&2; exit 127; }
  DECRYPTED_GZIP="$(mktemp)"
  chmod 600 "$DECRYPTED_GZIP"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$BACKUP_FILE" -out "$DECRYPTED_GZIP"
  SOURCE_GZIP="$DECRYPTED_GZIP"
fi

gzip -t "$SOURCE_GZIP"
echo "Restoring into database '$RESTORE_TARGET_DB' on host '$DB_HOST'. Ensure this is the intended target."
MYSQL_PWD="${DB_PASSWORD:-}" gzip -dc "$SOURCE_GZIP" | MYSQL_PWD="${DB_PASSWORD:-}" mysql \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" "$RESTORE_TARGET_DB"
echo "Restore import completed. Validate key tables, row counts, financial totals, and sign-in using a test account before allowing use."
