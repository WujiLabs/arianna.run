#!/usr/bin/env bash
# dump-retcon-session.sh
#
# Read-only dump of a retcon session for offline analysis.
#
# Reads ~/.retcon/proxy.db (SQLite event log + projected views) and emits a
# Markdown bundle with session metadata, per-turn entries, and summary stats.
#
# Schema this script depends on (retcon CURRENT_SCHEMA_VERSION=6, see
# ~/retcon/src/db.ts):
#   sessions(id, task_id, created_at, ended_at, harness, actor, ...)
#   tasks(id, session_id, name, description, created_at)
#   revisions(id, task_id, asset_cid, parent_revision_id, classification,
#             stop_reason, sealed_at, created_at)
#   blobs(cid, bytes BLOB, size, created_at)
#
# Per-revision data flow:
#   revision.asset_cid -> blob is dag-json {request_body_cid, response_body_cid}
#   request_body_cid   -> blob is dag-json top body with messages[] linkified
#                         to per-message CIDs. Each linked blob is a single
#                         Anthropic message ({role, content}) as dag-json.
#   response_body_cid  -> blob is gzipped SSE stream from /v1/messages.
#
# Usage:
#   dump-retcon-session.sh --list                     # list sessions
#   dump-retcon-session.sh <session-id>               # dump to stdout
#   dump-retcon-session.sh <session-id> --out FILE    # dump to file
#   dump-retcon-session.sh --self                     # auto-detect THIS session
#
# Dependencies: bash, sqlite3, jq, gunzip. macOS / BSD tools OK.

set -euo pipefail

DB="${RETCON_DB:-$HOME/.retcon/proxy.db}"

# ---- helpers ---------------------------------------------------------------

die() { echo "error: $*" >&2; exit 1; }

[[ -r "$DB" ]] || die "cannot read $DB"
command -v sqlite3 >/dev/null || die "sqlite3 not on PATH"
command -v jq      >/dev/null || die "jq not on PATH"
command -v gunzip  >/dev/null || die "gunzip not on PATH"

# Run a SQLite query against the DB, read-only, with no headers.
# We open the DB via "file:...?mode=ro" so concurrent writes from the daemon
# can't be blocked by our reader.
sql() {
  sqlite3 "file:${DB}?mode=ro" -bail -cmd ".timeout 5000" "$@"
}

# Dump a blob's raw bytes to stdout. CIDs are base32-ish [a-z0-9]; reject
# anything else as defense-in-depth (we string-interpolate them into SQL).
#
# Why writefile-to-tempfile and not /dev/stdout? sqlite3 CLI's writefile()
# returns the byte count as a result row in addition to writing the bytes,
# and the result row gets mixed into stdout. Writing to a real path keeps
# the bytes clean.
blob_bytes() {
  local cid="$1"
  [[ "$cid" =~ ^[A-Za-z0-9]+$ ]] || die "invalid cid: $cid"
  local tmp
  tmp=$(mktemp -t retcon-blob)
  sqlite3 "file:${DB}?mode=ro" -bail \
    "SELECT writefile('${tmp}', bytes) FROM blobs WHERE cid='${cid}';" \
    >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
  cat "$tmp"
  rm -f "$tmp"
}

# Decode a dag-json blob (Anthropic message, top body, or asset). retcon's
# dag-json output for these payloads is JSON-compatible: byte-for-byte
# valid utf-8 JSON when the value is a plain object whose links use the
# {"/": "<cid>"} convention. So we can parse with jq directly.
blob_json() {
  blob_bytes "$1"
}

# Truncate / oneliner-ize a string for preview.
preview() {
  local s="$1" n="${2:-200}"
  # Replace whitespace runs with spaces, then truncate.
  printf '%s' "$s" \
    | tr '\n\r\t' '   ' \
    | awk -v n="$n" '{
        if (length($0) > n) print substr($0, 1, n) "..."
        else print $0
      }'
}

# Format a unix-millis timestamp as ISO local time.
fmt_ts_ms() {
  local ms="$1"
  [[ -z "$ms" || "$ms" == "NULL" ]] && { echo "(null)"; return; }
  # macOS BSD date: -r expects seconds.
  local s=$((ms / 1000))
  date -r "$s" "+%Y-%m-%d %H:%M:%S"
}

# Format a duration in ms as a human-readable string.
fmt_dur_ms() {
  local ms="$1"
  if (( ms < 1000 )); then echo "${ms}ms"; return; fi
  local s=$((ms / 1000))
  local h=$((s / 3600))
  local m=$(( (s % 3600) / 60 ))
  local sec=$((s % 60))
  if (( h > 0 )); then printf '%dh%dm%ds\n' "$h" "$m" "$sec"
  elif (( m > 0 )); then printf '%dm%ds\n' "$m" "$sec"
  else printf '%ds\n' "$sec"; fi
}

# ---- modes -----------------------------------------------------------------

cmd_list() {
  printf 'Sessions in %s:\n\n' "$DB"
  printf '%-38s  %-19s  %-19s  %5s  %s\n' \
    "session_id" "first_turn" "last_turn" "turns" "actor/harness"
  printf '%-38s  %-19s  %-19s  %5s  %s\n' \
    "$(printf '%.0s-' {1..38})" "$(printf '%.0s-' {1..19})" \
    "$(printf '%.0s-' {1..19})" "-----" "-------------"
  sql -separator $'\t' "
    SELECT s.id,
           COALESCE(MIN(r.created_at), s.created_at),
           COALESCE(MAX(r.sealed_at), s.created_at),
           COUNT(r.id),
           COALESCE(s.actor,'-') || '/' || COALESCE(s.harness,'-')
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.id
      LEFT JOIN revisions r ON r.task_id = t.id
     GROUP BY s.id
     ORDER BY COALESCE(MAX(r.sealed_at), s.created_at) DESC;
  " | while IFS=$'\t' read -r sid first last n meta; do
    printf '%-38s  %-19s  %-19s  %5s  %s\n' \
      "$sid" "$(fmt_ts_ms "$first")" "$(fmt_ts_ms "$last")" "$n" "$meta"
  done
}

# Try to find THIS orchestrator session by cwd. Scans the top N most-recent
# sessions; for each, checks up to 5 revisions for the cwd needle (in either
# the system block or the first user message — claude-code subagents like
# haiku web search and suggestion mode strip the system prompt so we have
# to look in messages too). Returns session_id or empty.
detect_self() {
  local needle="${RETCON_SELF_NEEDLE:-$(pwd)}"
  local sids
  sids=$(sql "
    SELECT s.id
      FROM sessions s
      JOIN tasks t ON t.session_id = s.id
      JOIN revisions r ON r.task_id = t.id
     GROUP BY s.id
     ORDER BY MAX(r.sealed_at) DESC
     LIMIT 10;
  ")
  while read -r sid; do
    [[ -z "$sid" ]] && continue
    local assets
    assets=$(sql "
      SELECT r.asset_cid
        FROM revisions r
        JOIN tasks t ON t.id = r.task_id
       WHERE t.session_id='$sid'
         AND r.asset_cid IS NOT NULL
       ORDER BY r.created_at ASC LIMIT 5;
    ")
    while read -r a; do
      [[ -z "$a" ]] && continue
      local req_cid
      req_cid=$(blob_json "$a" | jq -r '.request_body_cid // empty')
      [[ -z "$req_cid" ]] && continue
      local rc_json msg0_cid
      rc_json=$(blob_json "$req_cid")
      if printf '%s' "$rc_json" | grep -q -F "$needle"; then
        echo "$sid"; return 0
      fi
      msg0_cid=$(printf '%s' "$rc_json" | jq -r '.messages[0]."/" // empty')
      if [[ -n "$msg0_cid" ]]; then
        if blob_bytes "$msg0_cid" | grep -q -F "$needle"; then
          echo "$sid"; return 0
        fi
      fi
    done <<< "$assets"
  done <<< "$sids"
  return 1
}

# Render a single revision as Markdown.
# Args: rev_id rev_index
render_revision() {
  local rev_id="$1" idx="$2"
  # Replace empty fields with '-' sentinels so bash 3.2's read (which
  # collapses consecutive IFS tabs) doesn't shift later columns into the
  # wrong variable. asset_cid, stop_reason, sealed_at can all be NULL.
  local row
  row=$(sql -separator $'\t' "
    SELECT id, COALESCE(asset_cid,'-'), classification,
           COALESCE(stop_reason,'-'), created_at,
           COALESCE(sealed_at,'-')
      FROM revisions WHERE id='$rev_id';")
  IFS=$'\t' read -r r_id asset cls sr c_at s_at <<< "$row"
  [[ "$asset" == "-" ]] && asset=""
  [[ "$sr"    == "-" ]] && sr=""
  [[ "$s_at"  == "-" ]] && s_at=""
  local dur_ms=0
  if [[ -n "$s_at" && "$s_at" != "NULL" ]]; then
    # Both stamps are millis; use awk for float subtraction (sealed_at can
    # come back as e.g. 1776065576116.66 — stored as REAL because of the
    # Date.now() drift sentinel some retcon versions emit).
    dur_ms=$(awk -v a="$s_at" -v b="$c_at" 'BEGIN{printf "%d", a-b}')
  fi

  printf '\n---\n\n## Turn %d  `%s`\n\n' "$idx" "$r_id"
  printf -- '- **created_at**: %s  (`%s`)\n' "$(fmt_ts_ms "$c_at")" "$c_at"
  printf -- '- **sealed_at**:  %s  (`%s`)\n' "$(fmt_ts_ms "$s_at")" "$s_at"
  printf -- '- **duration**:   %s\n' "$(fmt_dur_ms "$dur_ms")"
  printf -- '- **classification**: %s\n' "$cls"
  printf -- '- **stop_reason**: %s\n' "${sr:-(null)}"

  if [[ -z "$asset" || "$asset" == "" ]]; then
    printf -- '- _no asset_cid (likely in_flight or upstream error)_\n'
    return 0
  fi

  # Resolve asset → request_body_cid + response_body_cid
  local asset_json req_cid resp_cid
  asset_json=$(blob_json "$asset")
  req_cid=$(jq -r '.request_body_cid // empty'  <<< "$asset_json")
  resp_cid=$(jq -r '.response_body_cid // empty' <<< "$asset_json")

  # --- Request side ---
  if [[ -n "$req_cid" ]]; then
    local top_json model
    top_json=$(blob_json "$req_cid")
    model=$(jq -r '.model // "?"' <<< "$top_json")
    printf -- '- **model**: %s\n' "$model"

    # Resolve the LAST message link in messages[] — that's the user input
    # this turn was responding to. (Earlier messages are the conversation
    # history that the previous turn already covered.)
    local last_msg_cid
    last_msg_cid=$(jq -r '
      (.messages // []) as $m
      | if ($m|length) == 0 then empty
        else ($m[-1] | if type=="object" and ."/" then ."/" else empty end)
        end
    ' <<< "$top_json")

    if [[ -n "$last_msg_cid" ]]; then
      local msg_json role text_preview
      msg_json=$(blob_json "$last_msg_cid")
      role=$(jq -r '.role // "?"' <<< "$msg_json")
      # Concatenate all text-typed content blocks; tool_result blocks are
      # noisy so we summarize them instead of dumping. .content can also
      # be a bare string (older Anthropic shape) — handle both.
      text_preview=$(jq -r '
        if (.content | type) == "string" then .content
        else
          (.content // [])
          | map(
              if .type=="text" then (.text // "")
              elif .type=="tool_result" then
                ("[tool_result for " + (.tool_use_id // "?") + "]")
              elif .type=="tool_use" then
                ("[tool_use " + (.name // "?") + "]")
              else "" end)
          | join(" | ")
        end
      ' <<< "$msg_json")
      printf -- '- **last user (%s)**: ' "$role"
      preview "$text_preview" 200
    fi
  fi

  # --- Response side ---
  if [[ -n "$resp_cid" ]]; then
    # Gzipped SSE stream. Pipe through gunzip, then walk the stream to
    # collect: assistant text deltas, tool_use blocks, and final usage.
    local sse_tmp
    sse_tmp=$(mktemp -t retcon-sse)
    blob_bytes "$resp_cid" | gunzip -c > "$sse_tmp" 2>/dev/null || true

    # Use jq -s with a reducer? Simpler: extract just the data: lines and
    # filter to the events we care about, then aggregate with awk.
    local agg
    agg=$(awk '
      # Each SSE message is "event: X\ndata: {...}\n\n". We only care about
      # the data: lines. Print one JSON per line for downstream parsing.
      /^data: / { print substr($0, 7) }
    ' "$sse_tmp" \
      | jq -s -c '
          # Inputs: array of SSE data payloads. Walk them, building:
          #   assistant_text: concat of all text_delta pieces
          #   tool_uses: [{name, input_json_str}, ...]
          #   input_tokens / output_tokens from message_start / message_delta
          reduce .[] as $e (
            { assistant_text: "", tool_uses: [], in_tok: 0, out_tok: 0,
              cur_block: null, cur_input: "" };
            if $e.type == "message_start" then
              .in_tok = ($e.message.usage.input_tokens // 0)
              | .out_tok = ($e.message.usage.output_tokens // 0)
            elif $e.type == "content_block_start" then
              if $e.content_block.type == "tool_use" then
                .cur_block = "tool_use"
                | .cur_input = ""
                | .tool_uses += [{name: ($e.content_block.name // "?"), input_str: ""}]
              elif $e.content_block.type == "server_tool_use" then
                .cur_block = "server_tool_use"
                | .cur_input = ""
                | .tool_uses += [{name: ("server:" + ($e.content_block.name // "?")), input_str: ""}]
              elif $e.content_block.type == "text" then
                .cur_block = "text"
              elif $e.content_block.type == "thinking" then
                .cur_block = "thinking"
              else
                .cur_block = ($e.content_block.type // "other")
              end
            elif $e.type == "content_block_delta" then
              if $e.delta.type == "text_delta" and .cur_block == "text" then
                .assistant_text += ($e.delta.text // "")
              elif $e.delta.type == "input_json_delta"
                   and (.cur_block == "tool_use" or .cur_block == "server_tool_use") then
                .cur_input += ($e.delta.partial_json // "")
              else . end
            elif $e.type == "content_block_stop" then
              if (.cur_block == "tool_use" or .cur_block == "server_tool_use")
                 and (.tool_uses | length) > 0 then
                .tool_uses[-1].input_str = .cur_input
                | .cur_input = ""
                | .cur_block = null
              else .cur_block = null end
            elif $e.type == "message_delta" then
              .out_tok = ($e.usage.output_tokens // .out_tok)
            else . end
          )
      ' 2>/dev/null || echo "{}")

    rm -f "$sse_tmp"

    local in_tok out_tok asst_text n_tools
    in_tok=$(jq -r '.in_tok // 0' <<< "$agg")
    out_tok=$(jq -r '.out_tok // 0' <<< "$agg")
    asst_text=$(jq -r '.assistant_text // ""' <<< "$agg")
    n_tools=$(jq -r '.tool_uses // [] | length' <<< "$agg")

    printf -- '- **input_tokens**: %s\n' "$in_tok"
    printf -- '- **output_tokens**: %s\n' "$out_tok"
    printf -- '- **assistant text**: '
    if [[ -z "$asst_text" ]]; then
      echo "(none)"
    else
      preview "$asst_text" 200
    fi

    if (( n_tools > 0 )); then
      printf -- '- **tool calls** (%s):\n' "$n_tools"
      jq -r '.tool_uses[] | "\(.name)\t\(.input_str)"' <<< "$agg" \
      | while IFS=$'\t' read -r name input; do
          # Try to extract a one-line summary from the JSON input.
          local input_preview
          if [[ -n "$input" ]] && jq -e . >/dev/null 2>&1 <<< "$input"; then
            input_preview=$(jq -r '
              if type=="object" then
                to_entries
                | map(
                    .key + "=" + (
                      .value
                      | if type=="string" then
                          (if length > 80 then (.[0:80] + "...") else . end)
                        else (tostring | if length > 80 then (.[0:80] + "...") else . end)
                        end
                    )
                  )
                | .[0:5] | join(", ")
              else tostring end
            ' <<< "$input")
          else
            input_preview="(streaming-incomplete)"
          fi
          printf -- '  - **%s**: ' "$name"
          preview "$input_preview" 220
        done
    fi
  fi
}

cmd_dump() {
  local sid="$1" outfile="${2:-}"
  local out
  if [[ -n "$outfile" ]]; then
    out="$outfile"
    : > "$out"
    exec 3>"$out"
  else
    exec 3>&1
  fi

  # Validate session exists.
  local exists
  exists=$(sql "SELECT count(*) FROM sessions WHERE id='$sid';")
  [[ "$exists" == "1" ]] || die "session $sid not found in $DB"

  # Header + metadata. Use '-' as placeholder for empty fields because
  # bash 3.2's `read` collapses consecutive IFS tabs (so empty middle
  # columns shift later columns into the wrong variable).
  local s_row
  s_row=$(sql -separator $'\t' "
    SELECT id, task_id, created_at, COALESCE(ended_at,'-'),
           COALESCE(harness,'-'), COALESCE(actor,'-')
      FROM sessions WHERE id='$sid';")
  IFS=$'\t' read -r s_id s_task s_created s_ended s_harness s_actor <<< "$s_row"
  [[ "$s_ended"   == "-" ]] && s_ended=""
  [[ "$s_harness" == "-" ]] && s_harness=""
  [[ "$s_actor"   == "-" ]] && s_actor=""

  local stats
  stats=$(sql -separator $'\t' "
    SELECT COUNT(r.id),
           COALESCE(MIN(r.created_at),0),
           COALESCE(MAX(r.sealed_at),0),
           COALESCE(GROUP_CONCAT(DISTINCT r.classification),'')
      FROM revisions r
      JOIN tasks t ON t.id = r.task_id
     WHERE t.session_id='$sid';")
  IFS=$'\t' read -r n_rev first_at last_at cls_list <<< "$stats"

  # Models used: hydrate the top body of every revision and collect distinct
  # `model` values. Cheap (one tiny dag-json blob per revision).
  local models
  models=$(sql "
    SELECT DISTINCT r.asset_cid
      FROM revisions r
      JOIN tasks t ON t.id = r.task_id
     WHERE t.session_id='$sid' AND r.asset_cid IS NOT NULL;
  " | while read -r a; do
      [[ -z "$a" ]] && continue
      local rc
      rc=$(blob_json "$a" | jq -r '.request_body_cid // empty')
      [[ -z "$rc" ]] && continue
      blob_json "$rc" | jq -r '.model // empty'
    done | sort -u | paste -sd "," -)

  # Try to extract a project path. The system prompt usually carries a
  # "Working directory: ..." line in claude-code; sub-agents (haiku web
  # search, suggestion mode) don't, so we scan the first ~20 revisions
  # and check both the top body's `system` and the first message blob.
  local project_path=""
  local scan_assets
  scan_assets=$(sql "
    SELECT r.asset_cid FROM revisions r
      JOIN tasks t ON t.id = r.task_id
     WHERE t.session_id='$sid' AND r.asset_cid IS NOT NULL
     ORDER BY r.created_at ASC LIMIT 20;")
  while read -r a; do
    [[ -z "$a" ]] && continue
    local rc
    rc=$(blob_json "$a" | jq -r '.request_body_cid // empty')
    [[ -z "$rc" ]] && continue
    local rc_json msg_cids
    rc_json=$(blob_json "$rc")
    # Try the concatenated system text first. claude-code's main agent has
    # this; subagents (haiku web search, suggestion mode) don't.
    local sys_text
    sys_text=$(printf '%s' "$rc_json" \
      | jq -r '(.system // []) | map(.text // "") | join("\n")')
    local found
    found=$(printf '%s' "$sys_text" \
      | grep -oE 'Working directory: [^[:space:]]+' \
      | head -1 | sed 's/Working directory: //' || true)
    if [[ -n "$found" ]]; then project_path="$found"; break; fi
    # Fall back: search the first 3 message blobs. CC inlines a CLAUDE.md
    # / claudeMd context block in an early system-reminder user turn that
    # contains "Working directory: <abs path>".
    msg_cids=$(printf '%s' "$rc_json" | jq -r '.messages[0:3][]."/" // empty')
    while read -r mid; do
      [[ -z "$mid" ]] && continue
      local mtmp
      mtmp=$(mktemp -t retcon-msg)
      blob_bytes "$mid" > "$mtmp" 2>/dev/null || true
      # Match either literal "Working directory: <path>" (un-escaped) or the
      # JSON-escaped form "Working directory: <path>\\n".
      found=$(grep -oE 'Working directory: [^[:space:]\\"]+' "$mtmp" \
        | head -1 | sed 's/Working directory: //' || true)
      if [[ -z "$found" ]]; then
        # Subagent fallback: claude-code Task agents inline the parent's
        # CLAUDE.md as a "Contents of /<abs path>/CLAUDE.md (project
        # instructions, ...)" preamble. Pull the directory out of that.
        found=$(grep -oE 'Contents of /[^[:space:]"\\]+/CLAUDE\.md[^[:space:]"\\]*' "$mtmp" \
          | head -1 | sed -E 's|^Contents of ||;s|/CLAUDE\.md.*||' || true)
      fi
      rm -f "$mtmp"
      if [[ -n "$found" ]]; then project_path="$found"; break 2; fi
    done <<< "$msg_cids"
  done <<< "$scan_assets"

  {
    printf '# Retcon session dump\n\n'
    printf -- '- **session_id**: `%s`\n' "$s_id"
    printf -- '- **task_id**:    `%s`\n' "$s_task"
    printf -- '- **project**:    %s\n' "${project_path:-(unknown)}"
    printf -- '- **harness**:    %s\n' "${s_harness:-?}"
    printf -- '- **actor**:      %s\n' "${s_actor:-?}"
    printf -- '- **created_at**: %s  (`%s`)\n' "$(fmt_ts_ms "$s_created")" "$s_created"
    printf -- '- **first turn**: %s  (`%s`)\n' "$(fmt_ts_ms "$first_at")" "$first_at"
    printf -- '- **last turn**:  %s  (`%s`)\n' "$(fmt_ts_ms "$last_at")" "$last_at"
    printf -- '- **turn count**: %s\n' "$n_rev"
    printf -- '- **classifications**: %s\n' "${cls_list:-?}"
    printf -- '- **models**:     %s\n' "${models:-?}"
  } >&3

  # Per-turn entries, in chronological order. We use created_at; sealed_at
  # could be NULL for in_flight, but those are excluded by the join.
  local revs_tmp
  revs_tmp=$(mktemp -t retcon-revs)
  sql "
    SELECT r.id
      FROM revisions r
      JOIN tasks t ON t.id = r.task_id
     WHERE t.session_id='$sid'
     ORDER BY r.created_at ASC;
  " > "$revs_tmp"

  local i=0
  # We aggregate stats while we render. Bash 3.2 has no associative arrays,
  # so we collect tool names into a flat newline-separated file and tally
  # via sort | uniq -c at the end.
  local total_in=0 total_out=0 longest_ms=0 longest_id=""
  local tools_tmp; tools_tmp=$(mktemp -t retcon-tools)
  while IFS= read -r rid; do
    [[ -z "$rid" ]] && continue
    i=$((i+1))
    # Render to fd 3 (the output file or stdout).
    local rendered
    rendered=$(render_revision "$rid" "$i")
    printf '%s\n' "$rendered" >&3

    # Pull stats out of the rendered block (cheaper than re-querying).
    local in_tok out_tok
    in_tok=$(printf '%s\n' "$rendered" | grep -m1 -E '^- \*\*input_tokens\*\*' | awk '{print $NF}' || echo 0)
    out_tok=$(printf '%s\n' "$rendered" | grep -m1 -E '^- \*\*output_tokens\*\*' | awk '{print $NF}' || echo 0)
    [[ "$in_tok"  =~ ^[0-9]+$ ]] || in_tok=0
    [[ "$out_tok" =~ ^[0-9]+$ ]] || out_tok=0
    total_in=$((total_in + in_tok))
    total_out=$((total_out + out_tok))

    # Track the longest turn (recompute from sealed - created).
    local row dur_ms
    row=$(sql -separator $'\t' "SELECT created_at, COALESCE(sealed_at,0) FROM revisions WHERE id='$rid';")
    IFS=$'\t' read -r c_at s_at <<< "$row"
    if [[ -n "$s_at" && "$s_at" != "0" ]]; then
      dur_ms=$(awk -v a="$s_at" -v b="$c_at" 'BEGIN{printf "%d", a-b}')
      if (( dur_ms > longest_ms )); then
        longest_ms=$dur_ms
        longest_id="$rid"
      fi
    fi

    # Tool counts: pull from the rendered "tool calls" sub-bullets.
    printf '%s\n' "$rendered" \
      | awk -F'\\*\\*' '/^  - \*\*/ {gsub(":.*","",$2); print $2}' \
      >> "$tools_tmp" || true
  done < "$revs_tmp"
  rm -f "$revs_tmp"

  # Summary
  local wall=0
  if [[ "$last_at" != "0" && "$first_at" != "0" ]]; then
    wall=$(awk -v a="$last_at" -v b="$first_at" 'BEGIN{printf "%d", a-b}')
  fi
  {
    printf '\n---\n\n## Summary\n\n'
    printf -- '- **wall clock (first→last seal)**: %s  (`%s` ms)\n' "$(fmt_dur_ms "$wall")" "$wall"
    printf -- '- **total input_tokens**: %s\n' "$total_in"
    printf -- '- **total output_tokens**: %s\n' "$total_out"
    printf -- '- **longest turn**: '
    if [[ -n "$longest_id" ]]; then
      printf '`%s`  (%s)\n' "$longest_id" "$(fmt_dur_ms "$longest_ms")"
    else
      printf '(none with sealed_at)\n'
    fi
    printf -- '- **tools used**:\n'
    if [[ ! -s "$tools_tmp" ]]; then
      printf -- '  - (none)\n'
    else
      sort "$tools_tmp" | uniq -c | sort -rn | awk '{
        n=$1; $1=""; sub(/^ /,"")
        printf "  - `%s`: %d\n", $0, n
      }'
    fi
  } >&3
  rm -f "$tools_tmp"

  if [[ -n "$outfile" ]]; then
    exec 3>&-
    printf 'wrote %s\n' "$outfile" >&2
  fi
}

# ---- arg parsing -----------------------------------------------------------

usage() {
  cat <<EOF
usage: $(basename "$0") [--list | <session-id> | --self] [--out FILE]

  --list           list available sessions with first/last turn timestamps
  --self           auto-detect the current orchestrator session by cwd
  <session-id>     dump the named session (UUID)
  --out FILE       write to FILE instead of stdout
EOF
}

[[ $# -ge 1 ]] || { usage; exit 2; }

mode=""
session=""
outfile=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)  mode="list"; shift ;;
    --self)  mode="self"; shift ;;
    --out)   outfile="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [[ -z "$session" ]]; then session="$1"; mode="dump"; shift
      else die "unexpected arg: $1"; fi
      ;;
  esac
done

case "$mode" in
  list) cmd_list ;;
  self)
    sid=$(detect_self) || die "could not auto-detect session by cwd"
    echo "auto-detected session: $sid" >&2
    cmd_dump "$sid" "$outfile"
    ;;
  dump) cmd_dump "$session" "$outfile" ;;
  *) usage; exit 2 ;;
esac
