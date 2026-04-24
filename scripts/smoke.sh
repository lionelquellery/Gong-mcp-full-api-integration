#!/usr/bin/env bash
# End-to-end smoke test against a live Gong tenant via the dockerized MCP server.
# Usage: ./scripts/smoke.sh
# Requires: docker, jq, .env in repo root.

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-gong-mcp:dev}"
FROM="${FROM:-$(date -u -v-14d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '14 days ago' +%Y-%m-%dT00:00:00Z)}"
# Gong's /stats endpoints reject any timestamp in the current day, so bound at end-of-yesterday.
TO="${TO:-$(date -u -v-1d +%Y-%m-%dT23:59:59Z 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%dT23:59:59Z)}"

hr() { printf '\n==== %s ====\n' "$*"; }

# Send one or more MCP requests and return the JSON-RPC responses only.
# Usage: mcp_call <extra-json-lines>
mcp_call() {
  local calls="$1"
  {
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$calls"
    sleep 4
  } | docker run --rm -i --env-file .env -e GONG_ALLOW_RAW_REQUEST=true "$IMAGE" 2>/dev/null
}

# Extract the structuredContent of the tools/call response with id=$2 from a stream of JSON-RPC lines.
extract() {
  local id="$1"
  jq -c "select(.id==$id) | .result.structuredContent"
}

echo "Window: $FROM  →  $TO"

hr "0. security invariant: gong_raw_request is NOT registered by default"
DEFAULT_TOOLS=$(
  {
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"s","version":"0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
      '{"jsonrpc":"2.0","id":10,"method":"tools/list","params":{}}'
    sleep 2
  } | docker run --rm -i --env-file .env "$IMAGE" 2>/dev/null | jq -r 'select(.id==10) | .result.tools[].name'
)
echo "$DEFAULT_TOOLS"
if echo "$DEFAULT_TOOLS" | grep -q '^gong_raw_request$'; then
  echo "❌ security regression: gong_raw_request should be hidden unless GONG_ALLOW_RAW_REQUEST=true"
  exit 1
else
  echo "✅ raw request tool correctly hidden in default config"
fi

hr "1. gong_list_users (limit=1)"
RESP=$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gong_list_users","arguments":{"limit":1}}}')
USERS_JSON=$(echo "$RESP" | extract 2)
echo "$USERS_JSON" | jq '{count, totalRecords, nextCursor: (.nextCursor != null), first: .users[0]}'
FIRST_USER_ID=$(echo "$USERS_JSON" | jq -r '[.users[] | select(.active==true)][0].id // .users[0].id // empty')
echo "→ first active user id: $FIRST_USER_ID"

hr "2. gong_list_calls (last 14 days)"
RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"gong_list_calls\",\"arguments\":{\"fromDateTime\":\"$FROM\",\"toDateTime\":\"$TO\"}}}")
CALLS_JSON=$(echo "$RESP" | extract 3)
echo "$CALLS_JSON" | jq '{count, totalRecords, nextCursor: (.nextCursor != null), first: .calls[0]}'
FIRST_CALL_ID=$(echo "$CALLS_JSON" | jq -r '.calls[0].id // empty')
echo "→ first call id: $FIRST_CALL_ID"

if [[ -n "$FIRST_CALL_ID" ]]; then
  hr "3. gong_get_call ($FIRST_CALL_ID)"
  RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"gong_get_call\",\"arguments\":{\"callId\":\"$FIRST_CALL_ID\"}}}")
  echo "$RESP" | extract 4 | jq '{id: .call.id, title: .call.title, started: .call.started, durationSeconds: .call.durationSeconds, partyCount: (.call.parties // [] | length)}'

  hr "4. gong_get_call_transcript ($FIRST_CALL_ID)"
  RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"gong_get_call_transcript\",\"arguments\":{\"callId\":\"$FIRST_CALL_ID\",\"includeCombinedText\":false}}}")
  echo "$RESP" | extract 5 | jq '{segmentCount, firstSegment: .segments[0], lastSegment: .segments[-1]}'
else
  echo "→ no calls in window; skipping get_call / get_call_transcript"
fi

hr "5. gong_list_activity_stats (endpoint=interaction)"
RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"gong_list_activity_stats\",\"arguments\":{\"fromDate\":\"$FROM\",\"toDate\":\"$TO\",\"endpoint\":\"interaction\"}}}")
echo "$RESP" | extract 6 | jq '{endpoint, summary, topLevelKeys: (.stats | keys? // [])}'

hr "6. gong_get_user_stats — auto-pick a user with activity"
# First, call stats/interaction to find users who actually had calls in the window.
RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":71,\"method\":\"tools/call\",\"params\":{\"name\":\"gong_list_activity_stats\",\"arguments\":{\"fromDate\":\"$FROM\",\"toDate\":\"$TO\",\"endpoint\":\"interaction\",\"raw\":true}}}")
ACTIVE_USER_ID=$(echo "$RESP" | extract 71 | jq -r '.raw.peopleInteractionStats[0].userId // empty')
echo "→ picked user with activity: $ACTIVE_USER_ID"
if [[ -n "$ACTIVE_USER_ID" ]]; then
  RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"gong_get_user_stats\",\"arguments\":{\"userId\":\"$ACTIVE_USER_ID\",\"fromDate\":\"$FROM\",\"toDate\":\"$TO\"}}}")
  echo "$RESP" | extract 7 | jq '{userId, userFound, summary, hasStats: (.stats != null)}'
fi

hr "7. gong_raw_request GET /users?limit=1"
RESP=$(mcp_call '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"gong_raw_request","arguments":{"method":"GET","path":"/users","query":{"limit":1}}}}')
echo "$RESP" | extract 8 | jq '{status, ok, userCount: (.body.users | length), totalRecords: .body.records.totalRecords}'

hr "8. gong_update_crm_object"
echo "(skipped — mutating; not part of a read-only smoke test)"

hr "DONE"
