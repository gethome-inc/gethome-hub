#!/usr/bin/env bash
# GetHome Hub — apply an update that was asked for from an app.
#
#   update-runner.sh          (no arguments; systemd runs it)
#
# Installed as /usr/local/lib/gethome-update.sh and started by
# gethome-update.path when the hub writes <DATA_DIR>/update/request.
#
# ── Why this exists ────────────────────────────────────────────────────────
# Updating means writing /opt/gethome, moving a symlink and restarting a
# systemd unit. The hub runs as an unprivileged user with NoNewPrivileges and
# ProtectSystem=full; it can do none of that, and giving it a sudo rule to do
# it would be handing the network-facing process root over the machine.
#
# So the same trade the radio switch makes: the hub writes one word into a
# directory it already owns, a .path unit notices, and this script — root,
# started by systemd, reachable from nothing else — does the work. Nothing new
# is exposed, and an app can still ask.
#
# ── What it is careful about ───────────────────────────────────────────────
# * The request is consumed *first*. The file is what re-arms the path unit, so
#   a run that dies half way must not leave one behind to be picked up forever.
# * The hub is restarted by the installer, in the middle of this script. That
#   is why progress goes to a file rather than to the process that is about to
#   be killed, and why this unit is deliberately not ordered After= the hub.
# * `install.sh` ends in failure even when its automatic rollback *worked* —
#   exit 1 plus @@ERROR@@ — and after a rollback the `current` symlink points
#   at the same build it started on, which is also what a failure before the
#   flip looks like. The two are told apart by the @@ROLLBACK@@ marker, which
#   is why that marker was added to install.sh.
# * What the hub is running afterwards is read from the *hub*, not from the
#   log. A log says what was attempted; only the API says what is live.
set -uo pipefail

CONF_DIR="${GETHOME_CONF:-/etc/gethome}"
HUB_ENV="$CONF_DIR/hub.env"
INSTALL_DIR="${GETHOME_DIR:-/opt/gethome}"

read_env() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n1; }

DATA_DIR=$(read_env DATA_DIR "$HUB_ENV")
[[ -n "$DATA_DIR" ]] || DATA_DIR=/var/lib/gethome/data
PORT=$(read_env PORT "$HUB_ENV")
[[ -n "$PORT" ]] || PORT=8420

UPDATE_DIR="$DATA_DIR/update"
REQUEST="$UPDATE_DIR/request"
STATUS_FILE="$UPDATE_DIR/status.json"
LOG_FILE="$UPDATE_DIR/last.log"

# Deliberately no --branch knob and no environment override for it. An update
# runs against a hub somebody already owns and depends on; a switch here would
# be one nobody pressing the button in an app could see. Testing another branch
# is `gethome-hubctl update --branch …` typed on this machine, knowingly.
BRANCH="main"

# How long to wait for the hub to answer again after the installer has finished.
# Thirty attempts two seconds apart, because coming back on a Zero 2 W is over a
# minute on its own. Overridable only so the test suite can drive the real
# script without waiting one — the same reason GETHOME_ZIGBEE_SCAN_DIR exists.
SETTLE_TRIES="${GETHOME_UPDATE_SETTLE_TRIES:-30}"
SETTLE_SLEEP="${GETHOME_UPDATE_SETTLE_SLEEP:-2}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Names and error text come from people and from the installer, so they carry
# quotes, backslashes and non-ASCII. Same helper as gethome-hubctl.
json_string() {
  printf '%s' "${1-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "${1-}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/ /g')"
}

RUN_ID=""
STATE="running"
STEP="starting"
STARTED_AT="$(now)"
FINISHED_AT=""
FROM_BUILD=""
LIVE_BUILD=""
ERROR_TEXT=""
ROLLED_BACK=""
HUB_ANSWERING="false"
WARNINGS=()
LAST_WRITE=0

current_build() {
  local target
  target="$(readlink -f "$INSTALL_DIR/current" 2>/dev/null)" || return 0
  [[ -n "$target" ]] && basename "$target"
}

# Built in a variable and then written, rather than redirecting a { … } group
# into a temp file: a group's exit status is its last command's, which is how
# the Zigbee override once silently never got written at all. And renamed into
# place rather than written over, because the hub reads this file at any moment
# and a half-written one is a parse error rather than a stale answer.
write_status() {
  local json warnings_json="" w
  for w in ${WARNINGS+"${WARNINGS[@]}"}; do
    [[ -n "$warnings_json" ]] && warnings_json+=","
    warnings_json+="$(json_string "$w")"
  done
  json="{"
  json+="\"id\":$(json_string "$RUN_ID"),"
  json+="\"state\":$(json_string "$STATE"),"
  json+="\"step\":$(json_string "$STEP"),"
  json+="\"startedAt\":$(json_string "$STARTED_AT"),"
  json+="\"heartbeat\":$(json_string "$(now)"),"
  json+="\"fromBuild\":$(json_string "$FROM_BUILD"),"
  json+="\"hubAnswering\":${HUB_ANSWERING},"
  json+="\"warnings\":[${warnings_json}]"
  [[ -n "$LIVE_BUILD" ]] && json+=",\"liveBuild\":$(json_string "$LIVE_BUILD")"
  [[ -n "$FINISHED_AT" ]] && json+=",\"finishedAt\":$(json_string "$FINISHED_AT")"
  [[ -n "$ERROR_TEXT" ]] && json+=",\"error\":$(json_string "$ERROR_TEXT")"
  json+="}"

  if printf '%s\n' "$json" > "$STATUS_FILE.tmp" 2>/dev/null; then
    chmod 0644 "$STATUS_FILE.tmp" 2>/dev/null || true
    mv -f "$STATUS_FILE.tmp" "$STATUS_FILE" 2>/dev/null || rm -f "$STATUS_FILE.tmp"
  fi
  LAST_WRITE=$(date +%s)
}

# @@NAME:value@@ → value. Anchored on the marker itself so a value containing
# an @ (an error message can) still comes back whole.
marker_value() {
  printf '%s' "$1" | sed -n "s/^.*@@$2:\(.*\)@@.*$/\1/p" | head -n1
}

CODE=1
LAST_LINE=""
handle_line() {
  local line="$1"
  printf '%s\n' "$line" >> "$LOG_FILE"
  case "$line" in
    *"@@EXIT:"*"@@"*)     CODE="$(marker_value "$line" EXIT)" ;;
    *"@@STEP:"*"@@"*)     STEP="$(marker_value "$line" STEP)"; write_status; return ;;
    *"@@WARN:"*"@@"*)     WARNINGS+=("$(marker_value "$line" WARN)"); write_status; return ;;
    *"@@ERROR:"*"@@"*)    ERROR_TEXT="$(marker_value "$line" ERROR)" ;;
    *"@@ROLLBACK:"*"@@"*) ROLLED_BACK=1 ;;
    *) [[ -n "${line// /}" ]] && LAST_LINE="$line" ;;
  esac
  # A heartbeat, so a stalled run can be told from a slow one. `apt` and the
  # health wait can both be quiet for a while, but neither is silent for ten
  # seconds at a stretch, so this costs a handful of writes per update.
  local age=$(( $(date +%s) - LAST_WRITE ))
  [[ $age -ge 10 ]] && write_status
}

# ── The request ────────────────────────────────────────────────────────────
# One line, the run id, written in place by the hub — the shape `radio-mode`
# uses and for the same reason: it is a single small write, which is what
# PathModified is guaranteed to notice, and a torn read costs a retry rather
# than a wrong answer. So: read, validate, and give it one more go before
# concluding there is nothing here.
read_request() {
  local raw
  raw="$(tr -d '[:space:]' < "$REQUEST" 2>/dev/null)"
  [[ "$raw" =~ ^[A-Za-z0-9._-]{8,64}$ ]] && printf '%s' "$raw"
}

RUN_ID="$(read_request)"
if [[ -z "$RUN_ID" ]]; then
  sleep 1
  RUN_ID="$(read_request)"
fi
if [[ -z "$RUN_ID" ]]; then
  rm -f "$REQUEST"
  exit 0
fi

# Consumed before any work: this file is what re-arms the path unit for the
# *next* update, and a run that dies must not leave one to be picked up again.
rm -f "$REQUEST"

mkdir -p "$UPDATE_DIR"
: > "$LOG_FILE"
chmod 0644 "$LOG_FILE" 2>/dev/null || true
FROM_BUILD="$(current_build)"
write_status

if ! command -v gethome-hubctl >/dev/null 2>&1; then
  STATE="failed"
  STEP="starting"
  FINISHED_AT="$(now)"
  ERROR_TEXT="This machine has no gethome-hubctl, so the hub can't update itself. Reinstalling it from GetHome Studio brings it forward — nothing paired is lost."
  printf '%s\n' "$ERROR_TEXT" >> "$LOG_FILE"
  write_status
  # Zero, like every other outcome — see the note at the foot of this file. This
  # is the branch somebody presses again, and a handful of non-zero exits inside
  # systemd's start-limit window would leave the unit refusing to start even
  # after gethome-hubctl turns up.
  exit 0
fi

handle_line "$ gethome-hubctl update --branch $BRANCH"

# The `while` reads from a process substitution rather than a pipe, so it runs
# in *this* shell and the variables it sets survive. The installer's exit status
# comes back as one more marker line, because a process substitution has no
# status to collect.
while IFS= read -r line; do
  handle_line "$line"
done < <( gethome-hubctl update --branch "$BRANCH" 2>&1; printf '@@EXIT:%s@@\n' "$?" )

# ── What happened ──────────────────────────────────────────────────────────
if [[ "$CODE" == "0" ]]; then
  STATE="succeeded"
elif [[ -n "$ROLLED_BACK" ]]; then
  STATE="rolled-back"
else
  STATE="failed"
fi

# `gethome-hubctl` can refuse before the installer ever runs — another update
# already holds the lock, or the installer download came back empty — and it
# says so on stderr rather than in the marker vocabulary. Its own last words
# beat "the update failed", which tells nobody anything.
if [[ "$STATE" != "succeeded" && -z "$ERROR_TEXT" ]]; then
  ERROR_TEXT="${LAST_LINE:-The update stopped without saying why. The installer log is the whole story.}"
fi

# Ask the hub what it is running, rather than believing the log. It has just
# been restarted, so give it a real minute: on a Zero 2 W coming back is over
# a minute on its own.
INFO=""
for _ in $(seq 1 "$SETTLE_TRIES"); do
  INFO="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/v1/hub" 2>/dev/null)" && [[ -n "$INFO" ]] && break
  sleep "$SETTLE_SLEEP"
done
if [[ -n "$INFO" ]]; then
  HUB_ANSWERING="true"
  LIVE_BUILD="$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' <<<"$INFO" | head -n1)"
fi
[[ -n "$LIVE_BUILD" ]] || LIVE_BUILD="$(current_build)"

FINISHED_AT="$(now)"
STEP="done"
write_status

# Always zero, including for a failure and for a rollback.
#
# A rolled-back update is not a failed unit: the hub is up, on the build it
# started on, and this script did exactly its job — it ran the update and wrote
# down what happened. Exiting non-zero would park `gethome-update.service` in
# `failed`, and enough of those inside systemd's start-limit window leave the
# unit refusing to start until somebody runs `reset-failed` on a machine the
# owner is not sitting at. That is the trap `zigbee-detect.sh` already carries a
# `reset-failed` for; the cheaper answer is not to fail. The outcome lives in
# status.json, in the log beside it, and in the journal.
exit 0
