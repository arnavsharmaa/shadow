#!/usr/bin/env bash
# Build an image and, on failure, surface the tail of the build log as a
# workflow annotation so the cause is visible without opening the job log.
set -uo pipefail
dockerfile="$1"
tag="$2"
log="$(mktemp)"
if docker build --progress=plain --file "$dockerfile" --tag "$tag" . 2>&1 | tee "$log"; then
  exit 0
fi
# Keep the last lines that look like errors plus the final 40 lines, within
# the annotation size limit; newlines must be encoded as %0A.
tail_lines="$(grep -iE 'error|ERR_|not found|cannot|failed' "$log" | tail -25; echo '--- last 40 lines ---'; tail -40 "$log")"
message="$(printf '%s' "$tail_lines" | cut -c1-300 | tail -c 3800 | sed ':a;N;$!ba;s/\n/%0A/g')"
echo "::error title=docker build failed (${dockerfile})::${message}"
exit 1
