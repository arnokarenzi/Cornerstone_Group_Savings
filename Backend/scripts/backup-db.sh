#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-"${SCRIPT_DIR}/../../backups"}"
DB_PORT="${DB_PORT:-3306}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"

: "${DB_HOST:?Set DB_HOST before running this backup}"
: "${DB_USER:?Set DB_USER before running this backup}"
: "${DB_NAME:?Set DB_NAME before running this backup}"

if [[ ! "$DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "DB_NAME contains unsupported filename characters." >&2
  exit 2
fi
if [[ ! "$DB_PORT" =~ ^[0-9]+$ ]]; then
  echo "DB_PORT must be a number." >&2
  exit 2
fi
if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "RETENTION_DAYS must be a non-negative number." >&2
  exit 2
fi
if [[ "${NODE_ENV:-}" == "production" && -z "$ENCRYPTION_PASSPHRASE" ]]; then
  echo "Production backups must be encrypted. Set BACKUP_ENCRYPTION_PASSPHRASE in the trusted scheduler/secret manager." >&2
  exit 2
fi
if [[ -n "$ENCRYPTION_PASSPHRASE" && ${#ENCRYPTION_PASSPHRASE} -lt 20 ]]; then
  echo "BACKUP_ENCRYPTION_PASSPHRASE must be at least 20 characters long." >&2
  exit 2
fi
for command_name in mysqldump gzip sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Required command not found: $command_name" >&2; exit 127; }
done
if [[ -n "$ENCRYPTION_PASSPHRASE" ]]; then
  command -v openssl >/dev/null 2>&1 || { echo "Required command not found: openssl" >&2; exit 127; }
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
SUFFIX=".sql.gz"
if [[ -n "$ENCRYPTION_PASSPHRASE" ]]; then SUFFIX=".sql.gz.enc"; fi
FINAL_FILE="$BACKUP_DIR/cornestone-${DB_NAME}-${TIMESTAMP}${SUFFIX}"
TEMP_GZIP="$FINAL_FILE.gzip-tmp"
TEMP_FILE="$FINAL_FILE.tmp"
cleanup() { rm -f "$TEMP_GZIP" "$TEMP_FILE"; }
trap cleanup EXIT

# Dump table data without CREATE DATABASE/USE statements, so restores can be
# tested against a separately-created staging database.
MYSQL_PWD="${DB_PASSWORD:-}" mysqldump \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  --single-transaction --quick --routines --triggers --events \
  --hex-blob --default-character-set=utf8mb4 "$DB_NAME" | gzip -c > "$TEMP_GZIP"

gzip -t "$TEMP_GZIP"
if [[ -n "$ENCRYPTION_PASSPHRASE" ]]; then
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$TEMP_GZIP" -out "$TEMP_FILE"
  mv "$TEMP_FILE" "$FINAL_FILE"
else
  mv "$TEMP_GZIP" "$FINAL_FILE"
fi
(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$FINAL_FILE")" > "$(basename "$FINAL_FILE").sha256"
)
chmod 600 "$FINAL_FILE" "$FINAL_FILE.sha256"

# Prune only this script's own dated backup files; never remove unrelated files.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "cornestone-${DB_NAME}-*.sql.gz" -o -name "cornestone-${DB_NAME}-*.sql.gz.enc" \) -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name "cornestone-${DB_NAME}-*.sql.gz*.sha256" -mtime "+$RETENTION_DAYS" -delete

echo "Backup completed: $FINAL_FILE"
echo "Checksum saved: $FINAL_FILE.sha256"
if [[ -n "$ENCRYPTION_PASSPHRASE" ]]; then
  echo "Backup is encrypted with AES-256-CBC/PBKDF2. Store the passphrase separately and securely."
else
  echo "WARNING: This backup is NOT encrypted. Store it only in a protected location or set BACKUP_ENCRYPTION_PASSPHRASE."
fi
echo "A backup is not proven until a restore has been tested."
