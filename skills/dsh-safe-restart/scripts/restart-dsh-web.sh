#!/usr/bin/env bash
# Restart the DSH Web process tree only after the caller has obtained consent.
set -euo pipefail

repo="${DSH_REPO:-}"
log="${DSH_RESTART_LOG:-/tmp/dsh-web-restart.log}"
# Coordination with dsh-web-supervisor (see workspace docs/specs/
# 2026-08-28-supervisor-planned-restart-design.md): the supervisor treats a
# down poll as a crash unless this marker is fresh, so it never races this
# script's own kill -> dry-boot -> relaunch sequence with its own rollback.
marker="${DSH_SUPERVISOR_MARKER:-$HOME/.dsh/.supervisor/planned-restart}"
# Session-log pre-flight env (see lib/session-health.ts): SESSIONS_ROOT is the
# operator DSH store's sessions dir (default <dsh home>/sessions) and may be
# overridden per invocation. PLUGIN_DIR is this package's root, derived from
# the script's own path — never a hard-coded location.
dsh_home="${DSH_HOME:-$HOME/.dsh}"
export SESSIONS_ROOT="${SESSIONS_ROOT:-$dsh_home/sessions}"
# Resolve the script's real location first: when invoked through a symlinked
# skill path (e.g. ~/.agents/skills/dsh-safe-restart/...), BASH_SOURCE keeps the
# link and "../../.." lands in ~/.agents — breaking the session-health preflight
# import (lib/session-health.js). readlink -f recovers the package checkout.
SCRIPT_SRC="${BASH_SOURCE[0]}"
if resolved="$(readlink -f "$SCRIPT_SRC" 2>/dev/null)" && [ -n "$resolved" ]; then
  SCRIPT_SRC="$resolved"
fi
PLUGIN_DIR="${DSH_SUPERVISOR_PLUGIN_DIR:-$(cd "$(dirname "$SCRIPT_SRC")/../../.." && pwd)}"
confirmed=false
dry_run=false
auto_mode=false
check_supervisor=false
reload_supervisor=false

dry_boot_and_verify() {
  local dsh_repo="$1"
  local port="${2:-0}"
  local marker="${3:-}"
  local dsh_home
  dsh_home="$(mktemp -d)"
  local log_tmp
  log_tmp="$(mktemp)"
  # ephemeral boot with isolated DSH_HOME
  DSH_HOME="$dsh_home" pnpm --dir "$dsh_repo" exec dsh web --port "$port" --no-open >"$log_tmp" 2>&1 &
  local pid=$!
  local ok=false
  for _ in $(seq 1 15); do
    if curl -s "http://127.0.0.1:$port/" 2>/dev/null | grep -q "${marker:-}"; then
      ok=true
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$dsh_home" "$log_tmp"
  [[ "$ok" == true ]]
}

usage() {
  cat <<'EOF'
Usage: restart-dsh-web.sh --repo <deepseek-harness> [--log <path>] [--confirm|--auto] [--dry-run]
       restart-dsh-web.sh --check-supervisor
       restart-dsh-web.sh --reload-supervisor

Safely hand over the DSH Web process that owns ports 3000 and 3080.

Options:
  --repo <path>        DeepSeek Harness checkout (or set DSH_REPO).
  --log <path>         Append-only launch log (or set DSH_RESTART_LOG).
  --confirm            Permit a real process handover (human-gated). Required unless --dry-run.
  --auto               Permit auto handover (supervisor, no consent prompt). Alias for --confirm with auto log prefix.
  --dry-run            Print the resolved process tree; never stop or launch anything.
  --check-supervisor   Report supervisor-daemon freshness (fresh|stale|absent); changes nothing.
  --reload-supervisor  Reload the daemon only when it predates the newest lib/*.js build.
  -h, --help           Show this help text.

The supervisor daemon caches this package's lib/*.js in RAM like `dsh web`
does, and a stale daemon rolls back a healthy boot with its old rules. Every
real restart therefore reloads it first when stale; DSH_SUPERVISOR_RELOAD_WAIT
(seconds, default 15) bounds the wait for systemd to bring it back.
EOF
}

fail() {
  printf '[restart] FAIL: %s\n' "$1" >&2
  exit "${2:-1}"
}

# --- supervisor daemon freshness -------------------------------------------------
# `dsh web` is not the only process that caches this package's lib/*.js in RAM:
# the standalone dsh-web-supervisor daemon does too, and it is the process that
# decides whether a boot is healthy or must be rolled back. A daemon started
# BEFORE the newest build keeps running the old rollback rules — on 2026-09-13
# exactly that judged a slow boot as down and rolled `dsh web` back in a loop
# ("rollback - degraded: This operation was aborted") while the port answered in
# 1.4ms. So: never swap `dsh web` under a stale daemon.
#
# Only systemd owns a relaunch (dsh-web-supervisor.service has Restart=always);
# a daemon someone started by hand has no owner to bring it back, so this step
# reports and leaves it alone rather than killing it.

# MainPID of the supervisor unit, or empty unless that pid really is the daemon.
supervisor_main_pid() {
  local pid cmdline
  pid="$(systemctl --user show -p MainPID --value dsh-web-supervisor.service 2>/dev/null | tr -dc '0-9' || true)"
  [[ -n "$pid" && "$pid" != 0 ]] || return 0
  [[ -d "/proc/$pid" ]] || return 0
  # Never signal a pid that is not this daemon, whatever systemd reports.
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == *"bin.js daemon"* ]] || return 0
  printf '%s' "$pid"
}

# Newest mtime among the package's built lib/*.js, or empty when unbuilt.
newest_lib_mtime() {
  local newest="" file stamp
  for file in "$PLUGIN_DIR"/lib/*.js; do
    [[ -f "$file" ]] || continue
    stamp="$(stat -c %Y "$file" 2>/dev/null || true)"
    [[ -n "$stamp" ]] || continue
    if [[ -z "$newest" || "$stamp" -gt "$newest" ]]; then newest="$stamp"; fi
  done
  printf '%s' "$newest"
}

# Classify the daemon: fresh | stale | absent | unknown.
supervisor_daemon_state() {
  SUPERVISOR_PID="$(supervisor_main_pid)"
  SUPERVISOR_LIB="$(newest_lib_mtime)"
  if [[ -z "$SUPERVISOR_PID" ]]; then
    SUPERVISOR_VERDICT=absent
    return 0
  fi
  SUPERVISOR_START="$(stat -c %Y "/proc/$SUPERVISOR_PID" 2>/dev/null || true)"
  if [[ -z "$SUPERVISOR_START" || -z "$SUPERVISOR_LIB" ]]; then
    SUPERVISOR_VERDICT=unknown
    return 0
  fi
  if (( SUPERVISOR_LIB > SUPERVISOR_START )); then
    SUPERVISOR_VERDICT=stale
  else
    SUPERVISOR_VERDICT=fresh
  fi
}

print_supervisor_state() {
  case "$SUPERVISOR_VERDICT" in
    fresh) printf '[restart] supervisor daemon: fresh pid=%s start=%s lib=%s\n' "$SUPERVISOR_PID" "$SUPERVISOR_START" "$SUPERVISOR_LIB" ;;
    stale) printf '[restart] supervisor daemon: stale pid=%s start=%s lib=%s (built after this daemon started)\n' "$SUPERVISOR_PID" "$SUPERVISOR_START" "$SUPERVISOR_LIB" ;;
    unknown) printf '[restart] supervisor daemon: unknown pid=%s (lib build time unavailable)\n' "$SUPERVISOR_PID" ;;
    *) printf '[restart] supervisor daemon: absent\n' ;;
  esac
}

# Reload the daemon when it predates the newest build; report the verdict either
# way. A failed reload is fatal: continuing would hand the swap to the very
# process that can roll it back in a loop.
ensure_supervisor_current() {
  supervisor_daemon_state
  if [[ "$SUPERVISOR_VERDICT" != stale ]]; then
    print_supervisor_state
    return 0
  fi
  local old_pid="$SUPERVISOR_PID"
  local wait_s="${DSH_SUPERVISOR_RELOAD_WAIT:-15}"
  local new_pid=""
  print_supervisor_state
  printf '[restart] reloading the supervisor daemon so it runs the built lib/*.js\n'
  kill -TERM "$old_pid" 2>/dev/null || true
  for _ in $(seq 1 "$wait_s"); do
    sleep 1
    new_pid="$(supervisor_main_pid)"
    if [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]]; then break; fi
    new_pid=""
  done
  if [[ -z "$new_pid" ]]; then
    printf '[restart] FAIL: supervisor daemon %s did not come back within %ss\n' "$old_pid" "$wait_s" >&2
    return 1
  fi
  printf '[restart] supervisor daemon: reloaded %s -> %s\n' "$old_pid" "$new_pid"
}

# Single-flight + log scoping (D6, spec 2026-09-13-supervisor-safety-net-design):
# take the SAME boot.lock and append the SAME boot-boundary sentinel as the
# supervisor's own performSingleBootRestart, by calling the package's helper —
# never by re-implementing either marker here. The lock is owned by this shell's
# PID ($$), so it stays valid for as long as the script runs, and it is released
# on every exit path via the trap below.
BOOT_GUARD_HELPER="${PLUGIN_DIR}/lib/bin.js"
boot_guard_acquire() {
  if [[ ! -f "$BOOT_GUARD_HELPER" ]]; then
    fail "boot.lock helper is missing: $BOOT_GUARD_HELPER (run 'pnpm build' in the supervisor package)" 69
  fi
  if ! node "$BOOT_GUARD_HELPER" boot-guard acquire --pid "$$" >>"$log" 2>&1; then
    fail 'another boot holds boot.lock (a dsh web boot or another restart is in flight)' 75
  fi
}
boot_guard_release() {
  [[ -f "$BOOT_GUARD_HELPER" ]] || return 0
  node "$BOOT_GUARD_HELPER" boot-guard release --pid "$$" >>"$log" 2>&1 || true
}

while (($#)); do
  case "$1" in
    --repo)
      (($# >= 2)) || fail '--repo requires a path' 64
      repo="$2"
      shift 2
      ;;
    --log)
      (($# >= 2)) || fail '--log requires a path' 64
      log="$2"
      shift 2
      ;;
    --confirm)
      confirmed=true
      shift
      ;;
    --auto)
      confirmed=true
      auto_mode=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --check-supervisor)
      check_supervisor=true
      shift
      ;;
    --reload-supervisor)
      reload_supervisor=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1" 64
      ;;
  esac
done

# Standalone supervisor-daemon modes: they never touch dsh web, so they need no
# --repo, no listeners and no consent.
if [[ "$check_supervisor" == true ]]; then
  supervisor_daemon_state
  print_supervisor_state
  exit 0
fi
if [[ "$reload_supervisor" == true ]]; then
  ensure_supervisor_current || fail 'supervisor daemon could not be reloaded — fix it before swapping dsh web' 70
  exit 0
fi

[[ -n "$repo" ]] || fail 'provide --repo or DSH_REPO' 64
[[ -f "$repo/package.json" ]] || fail "repo has no package.json: $repo" 64
if [[ "$dry_run" != true && "$confirmed" != true ]]; then
  fail 'refusing live restart without --confirm' 64
fi

for command in ss ps grep sort; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

listener_pids="$({ ss -tlnp 2>/dev/null || true; } | grep -E ':(3000|3080|3081|3082)([[:space:]]|$)' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
[[ -n "$listener_pids" ]] || fail 'no listeners found on ports 3000/3080 (proxy) or 3081/3082 (local-pin-gate topology)'

resolve_tree() {
  local current="$1"
  local parent command_line
  while [[ -n "$current" && "$current" != 1 ]]; do
    command_line="$(ps -o cmd= -p "$current" 2>/dev/null || true)"
    # Never walk into a service manager: when dsh-web runs as a systemd
    # --user unit (ExecStart=node ... directly, no intervening pnpm
    # wrapper), the parent of the listener process IS the manager itself.
    # Without this guard the loop keeps climbing (no "pnpm" match, parent
    # != 1 yet) and includes the manager's own PID in tree_pids -- SIGTERM
    # to it tears down every user unit, not just dsh-web (2026-08-28
    # incident: killed the whole systemd --user session).
    case "$command_line" in
      *systemd\ --user*) break ;;
    esac
    printf '%s\n' "$current"
    [[ "$command_line" == *pnpm* ]] && break
    parent="$(ps -o ppid= -p "$current" 2>/dev/null | tr -d '[:space:]')"
    [[ "$parent" == "$current" ]] && break
    current="$parent"
  done
}

tree_pids="$(for pid in $listener_pids; do resolve_tree "$pid"; done | sort -u)"
[[ -n "$tree_pids" ]] || fail 'could not resolve a process tree for the listeners'

# dsh-web.service has Restart=always: a raw `kill -TERM` on its MainPID looks
# like a crash to systemd, which immediately relaunches it -- racing this
# script's own relaunch for ports 3000/3080 (observed live 2026-08-28: restart
# counter climbed past 20 before either side won). When systemd owns it,
# defer the whole stop/start to systemctl instead of managing PIDs directly.
systemd_managed=false
systemctl --user is-active --quiet dsh-web.service 2>/dev/null && systemd_managed=true

printf '[restart] listener pids: %s\n' "$(tr '\n' ' ' <<<"$listener_pids")"
printf '[restart] process tree: %s\n' "$(tr '\n' ' ' <<<"$tree_pids")"
printf '[restart] managed by: %s\n' "$([[ "$systemd_managed" == true ]] && echo 'systemd (dsh-web.service)' || echo 'raw process (no systemd unit)')"

if [[ "$dry_run" == true ]]; then
  printf '[restart] dry-run: no process will be stopped or launched\n'
  exit 0
fi

# --- safe-guard: don't restart while tools are still running (torn prevention) ---
# Scan for dangling open turns (turn/start without turn/end) within last 5m.
# If found, wait up to 30s for them to finish, then require --auto to force.
check_dangling() {
  local count_dangling
  count_dangling() {
    node --input-type=module <<'NODE' 2>/dev/null || echo 0
import fs from 'node:fs'
import { execSync } from 'node:child_process'
try{
  const root = (process.env.DSH_HOME || (await import('node:os')).homedir() + '/.dsh') + '/sessions'
  let count=0
  for(const proj of fs.readdirSync(root)){
    const pp = root + '/' + proj
    try{ if(!fs.statSync(pp).isDirectory()) continue }catch{continue}
    for(const sess of fs.readdirSync(pp)){
      const p = pp + '/' + sess + '/session.jsonl.zstd'
      try{ fs.statSync(p) }catch{continue}
      try{
        const st = fs.statSync(p)
        if(Date.now() - st.mtimeMs > 5*60*1000) continue
      }catch{continue}
      try{
        const out = execSync(`zstd -d -c ${JSON.stringify(p)} 2>/dev/null | tail -n 20`, {encoding:'utf8', timeout:2000})
        const lastStart = out.lastIndexOf('"type":"turn/start"')
        if(lastStart!==-1 && !out.slice(lastStart).includes('"type":"turn/end"')) count++
      }catch{}
    }
  }
  console.log(count)
}catch{ console.log(0) }
NODE
  }
  local dangling
  dangling="$(count_dangling)"
  if [[ "$dangling" != "0" && -n "$dangling" ]]; then
    printf '[restart] WARN: %s dangling open turn(s) within 5m — tools may be running\n' "$dangling" | tee -a "$log" >&2
    if [[ "$auto_mode" != true ]]; then
      printf '[restart] waiting 30s for tools to finish (re-run with --auto to force)\n' | tee -a "$log" >&2
      for _ in $(seq 1 30); do sleep 1; done
      local dangling2
      dangling2="$(count_dangling)"
      if [[ "$dangling2" != "0" && -n "$dangling2" ]]; then
        printf '[restart] still %s dangling after wait — aborting (use --auto to force)\n' "$dangling2" | tee -a "$log" >&2
        fail "refusing restart with $dangling2 dangling turn(s) — tools still running" 64
      fi
    fi
  fi
}
check_dangling

mkdir -p "$(dirname "$log")"
printf '[restart] stopping process tree: %s\n' "$(tr '\n' ' ' <<<"$tree_pids")" >> "$log"

# Mark this as an intentional restart before the port goes down, so
# dsh-web-supervisor's health poll does not race us with its own rollback.
# The boot.lock below is the single-flight half of the same contract; both are
# released on every exit path (success or failure) via the trap.
mkdir -p "$(dirname "$log")"
boot_guard_acquire
mkdir -p "$(dirname "$marker")"
date -Iseconds > "$marker"
trap 'boot_guard_release; rm -f "$marker"' EXIT

# Reload a stale supervisor daemon BEFORE the swap: it is the process that
# decides whether the boot below is healthy, and a daemon running pre-build
# rules can roll it back in a loop. Done while dsh web is still up, so the
# fresh daemon observes the planned-restart marker written just above.
ensure_supervisor_current || fail 'stale supervisor daemon could not be reloaded — refusing to swap dsh web under old rollback rules' 70

if [[ "$systemd_managed" == true ]]; then
  # systemctl stop is a clean, intentional stop -- Restart=always does not
  # fire for it, unlike an out-of-band kill of the unit's MainPID.
  printf '[restart] stopping dsh-web.service via systemctl\n' >> "$log"
  systemctl --user stop dsh-web.service 2>>"$log" || fail 'systemctl --user stop dsh-web.service failed'
else
  kill -TERM $tree_pids 2>/dev/null || true

  tree_stopped=false
  for _ in $(seq 1 20); do
    alive=false
    for pid in $tree_pids; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=true
        break
      fi
    done
    if [[ "$alive" == false ]]; then
      tree_stopped=true
      break
    fi
    sleep 0.5
  done

  if [[ "$tree_stopped" != true ]]; then
    printf '[restart] process tree did not stop after TERM; sending KILL\n' >> "$log"
    kill -KILL $tree_pids 2>/dev/null || true
    sleep 1
  fi
fi

for port in 3000 3080 3081 3082; do
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    fail "port $port remains held; refusing to double-boot"
  fi
done

# Pre-flight: never let a corrupt session log brick the boot
# Runs only AFTER the old tree is stopped and the ports are free (above) and
# BEFORE the fresh boot below, so a live writer can never race the repair.
# Deliberately NON-FATAL (the block's exit status is dropped): a transient
# scan error must never block a legitimate restart.
if [ -n "$SESSIONS_ROOT" ] && [ -d "$SESSIONS_ROOT" ]; then
  node --input-type=module -e "import('${PLUGIN_DIR}/lib/session-health.js').then(async m => {
    const r = await m.runSessionHealthCheck(process.env.SESSIONS_ROOT, { repair: true, quarantine: false });
    console.log('[session-health] fixed=' + r.fixed + ' quarantined=' + r.quarantined + ' remaining=' + r.remaining);
  })" || true
fi

command -v curl >/dev/null 2>&1 || fail 'required command is unavailable: curl'

if [[ "$systemd_managed" == true ]]; then
  printf '[restart] starting dsh-web.service via systemctl\n' >> "$log"
  systemctl --user start dsh-web.service 2>>"$log" || fail 'systemctl --user start dsh-web.service failed'
else
  command -v setsid >/dev/null 2>&1 || fail 'required command is unavailable: setsid'
  command -v pnpm >/dev/null 2>&1 || fail 'required command is unavailable: pnpm'

  printf '[restart] launching DSH Web from %s\n' "$repo" >> "$log"
  (
    cd "$repo"
    setsid nohup "$(command -v pnpm)" dsh web --no-open </dev/null >> "$log" 2>&1 &
  )
fi

for _ in $(seq 1 90); do
  # 401 is healthy: dsh-web is up but requires the browser token (matches
  # dsh-web-supervisor's own health-poller convention since DSH 0.1.2).
  # Under the local-pin-gate topology (2026-09-02) :3080 is the maestro PIN
  # proxy (303 -> login / 200 authed) and the raw webserver lives on :3082 —
  # accept any dsh-web surface that answers 200/401/303.
  code_3080="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ || true)"
  if [[ "$code_3080" == 200 || "$code_3080" == 401 || "$code_3080" == 303 ]]; then
    printf '[restart] DSH Web is serving HTTP %s on port 3080\n' "$code_3080"
    exit 0
  fi
  code_3082="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3082/ || true)"
  if [[ "$code_3082" == 200 || "$code_3082" == 401 ]]; then
    printf '[restart] DSH Web raw webserver is serving HTTP %s on port 3082\n' "$code_3082"
    exit 0
  fi
  sleep 1
done

fail 'DSH Web did not serve HTTP 200/401/303 on :3080 (PIN proxy) or :3082 (raw webserver) before timeout'
