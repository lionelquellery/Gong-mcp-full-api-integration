# gong-mcp

[MCP](https://modelcontextprotocol.io) server that exposes the [Gong](https://www.gong.io) public REST API as tools for Claude (Desktop, Code, web) and any other MCP-compatible client.

Lets an LLM list calls, fetch transcripts, query user/team statistics, and update CRM objects through natural-language requests.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Getting Gong credentials](#getting-gong-credentials)
- [Installation](#installation)
  - [Option A — Docker (recommended)](#option-a--docker-recommended)
  - [Option B — Local Node.js](#option-b--local-nodejs)
- [Configuration](#configuration)
- [Connecting to Claude](#connecting-to-claude)
  - [Claude Code (CLI)](#claude-code-cli)
  - [Claude Desktop](#claude-desktop)
  - [Other MCP clients](#other-mcp-clients)
- [Tools](#tools)
- [Usage examples](#usage-examples)
- [Security](#security)
- [Development](#development)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Features

- **8 MCP tools** covering the main Gong use cases:
  - List and fetch calls (metadata + participants)
  - Retrieve normalized transcripts (structured segments + concatenated text)
  - List users, fetch per-user interaction stats
  - Aggregate activity/interaction statistics (talk ratio, patience, etc.)
  - Update CRM objects through Gong's CRM integration
  - Generic `gong_raw_request` escape hatch for any endpoint not explicitly modeled
- **Basic Auth** (access key + secret) loaded from environment variables — never logged
- **Classified error handling**: `auth` / `forbidden` / `rate_limited` / `client` / `server` / `network`
- **Rate-limit aware**: honors `Retry-After`, bounded exponential backoff (max 2 retries)
- **Explicit pagination**: `nextCursor` returned, no auto-crawl
- **Optional PII redaction**: `REDACT_PII=true` strips emails and phone numbers from transcript text
- **Multi-stage Docker image**, non-root user, ~260 MB

---

## Requirements

- A Gong account on a plan that includes public API access (see [Gong docs](https://help.gong.io/docs/receive-access-to-the-api))
- A Gong **access key** + **access secret** (see next section)
- One of:
  - **Docker** ≥ 20 (recommended)
  - **Node.js** ≥ 20 (for local install without Docker)
- An MCP client: [Claude Code](https://docs.claude.com/en/docs/claude-code), [Claude Desktop](https://claude.ai/download), Cursor, etc.

---

## Getting Gong credentials

1. Log into Gong as a technical administrator.
2. Open **Company Settings → Ecosystem → API** (exact path depends on your plan — see the [official page](https://help.gong.io/docs/receive-access-to-the-api)).
3. Click **Create** to generate an *access key* + *access key secret* pair.
4. Copy both values immediately — the secret is only shown once.
5. Note your tenant's **API base URL**:
   - Default: `https://api.gong.io/v2`
   - For region-dedicated tenants: `https://us-XXXXX.api.gong.io/v2` or `https://eu-XXXXX.api.gong.io/v2`

> ⚠️ **Access keys are not tied to a single user.** If the admin who created one leaves the company, the key remains valid. Clicking *Regenerate* immediately invalidates the previous pair.

---

## Installation

### Option A — Docker (recommended)

```bash
# 1. Clone the repository
git clone https://github.com/lionelquellery/Gong-mcp-full-api-integration.git
cd Gong-mcp-full-api-integration

# 2. Create your .env file from the template
cp .env.example .env

# 3. Edit .env with your credentials (see Configuration section)
$EDITOR .env

# 4. Build the image
docker build -t gong-mcp:latest .

# 5. Smoke-check that the image starts (Ctrl+C to quit)
docker run --rm -i --env-file .env gong-mcp:latest
# You should see on stderr: [info] gong-mcp ready { ... }
```

### Option B — Local Node.js

```bash
# 1. Clone and enter the directory
git clone https://github.com/lionelquellery/Gong-mcp-full-api-integration.git
cd Gong-mcp-full-api-integration

# 2. Install dependencies
npm install

# 3. Configure credentials
cp .env.example .env
$EDITOR .env

# 4. Build TypeScript
npm run build

# 5. Smoke-check the startup (Ctrl+C to quit)
npm run start:local
# Should print: [info] gong-mcp ready { ... }
```

---

## Configuration

All configuration happens through environment variables (via `.env` locally, or via your MCP client's configuration).

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `GONG_ACCESS_KEY` | ✅ | — | Gong access key (Basic Auth username) |
| `GONG_ACCESS_SECRET` | ✅ | — | Gong access key secret (Basic Auth password) |
| `GONG_API_BASE_URL` | ❌ | `https://api.gong.io/v2` | API base URL. For tenant-specific hosts: `https://us-XXXXX.api.gong.io/v2` |
| `REDACT_PII` | ❌ | `false` | If `true`, scrubs emails / phone numbers / personal URLs from transcripts *and* from tool output (participant emails, `userEmailAddress`, etc.) |
| `LOG_LEVEL` | ❌ | `info` | `debug` \| `info` \| `warn` \| `error` (logs go to stderr only) |
| `GONG_ALLOW_RAW_REQUEST` | ❌ | `false` | If `true`, registers the generic `gong_raw_request` tool. Off by default so a poisoned transcript cannot coax the LLM into calling arbitrary Gong endpoints. |
| `GONG_RAW_REQUEST_ALLOWED_PREFIXES` | ❌ | `/calls,/users,/stats,/crm,/library,/workspaces,/settings` | Comma-separated path prefixes the raw tool is allowed to hit (when enabled). |
| `GONG_INCLUDE_ERROR_BODY` | ❌ | `false` | If `true`, includes Gong's full error response body in tool error payloads. Off by default — error bodies can echo submitted fields or adjacent data. |
| `GONG_MAX_RESPONSE_BYTES` | ❌ | `8388608` (8 MB) | Hard cap on Gong response body size before the client aborts. |
| `GONG_MAX_TOOL_OUTPUT_BYTES` | ❌ | `1048576` (1 MB) | Hard cap on the serialized tool result returned to the MCP client. |

A ready-to-fill template is provided in [`.env.example`](./.env.example).

---

## Connecting to Claude

### Claude Code (CLI)

**With Docker:**
```bash
claude mcp add gong --scope user -- \
  docker run --rm -i --env-file /absolute/path/to/gong-mcp/.env gong-mcp:latest
```

**Without Docker (direct Node):**
```bash
claude mcp add gong --scope user \
  --env GONG_ACCESS_KEY=xxx \
  --env GONG_ACCESS_SECRET=xxx \
  -- node /absolute/path/to/gong-mcp/dist/index.js
```

Verify it's registered:
```bash
claude mcp list
```

Restart your Claude Code session — the `gong_*` tools will be available.

### Claude Desktop

1. Open the config file (create it if missing):
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add or extend the `mcpServers` section:

```json
{
  "mcpServers": {
    "gong": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/absolute/path/to/gong-mcp/.env",
        "gong-mcp:latest"
      ]
    }
  }
}
```

3. **Quit Claude Desktop completely** (`⌘Q` on Mac — not just closing the window) and relaunch.
4. In a new conversation, confirm the `gong` server appears in the list of connected MCPs (🔌 icon at the bottom of the UI).

### Other MCP clients

Any client that supports MCP over stdio can launch the server. The command is:

```bash
docker run --rm -i --env-file /absolute/path/to/.env gong-mcp:latest
```

or, in Node mode:

```bash
node /absolute/path/to/dist/index.js
# with GONG_* environment variables set in the process environment
```

---

## Tools

| Tool | Gong endpoint | Description |
| --- | --- | --- |
| `gong_list_calls` | `GET /v2/calls` | List calls over a date range (cursor pagination) |
| `gong_get_call` | `POST /v2/calls/extensive` | Metadata + participants of a single call (trackers/topics optional) |
| `gong_get_call_transcript` | `POST /v2/calls/transcript` | Normalized transcript for a call + concatenated text |
| `gong_list_users` | `GET /v2/users` | List Gong users |
| `gong_get_user_stats` | `POST /v2/stats/interaction` | Interaction stats for a single user (talk ratio, patience, etc.) |
| `gong_list_activity_stats` | `POST /v2/stats/interaction` \| `activity/*` | Aggregate activity stats over a date range |
| `gong_update_crm_object` | `PUT /v2/crm/entities` | Update a CRM object through Gong's CRM integration |
| `gong_raw_request` | *any* | Generic passthrough for any endpoint not explicitly modeled |

All list tools expose `nextCursor` for pagination — the caller (LLM) passes the cursor back explicitly to fetch the next page; there's no auto-crawl.

All tools accept a `raw: true` flag that includes Gong's untouched response body alongside the normalized summary.

---

## Usage examples

Once the server is connected to Claude, requests happen in natural language:

> *"List the Gong calls from last week"* → `gong_list_calls`
>
> *"Give me the transcript for call 6649506166173199116"* → `gong_get_call_transcript`
>
> *"What are john.doe@example.com's stats for the last 14 days?"* → `gong_list_users` then `gong_get_user_stats`
>
> *"Summarize the last 3 calls with Acme Corp"* → `gong_list_calls` + `gong_get_call_transcript` in a loop

Claude picks the tools and chains calls automatically.

An end-to-end smoke test is provided in [`scripts/smoke.sh`](./scripts/smoke.sh) — useful to verify your credentials work and every tool returns data:

```bash
./scripts/smoke.sh
```

---

## Security

- **Credentials are never logged.** The `Authorization` header is built once at startup and redacted in any debug output.
- **`.env` is in `.gitignore`** — never commit your real keys. The `.env.example` template is commit-safe (placeholders only).
- **Key rotation**: if a key has leaked (logs, chat transcripts, accidental sharing…), **regenerate it immediately** from the Gong admin console. Regenerating invalidates the previous pair.
- **`gong_raw_request` is gated off by default.** Set `GONG_ALLOW_RAW_REQUEST=true` at server start to enable it. Even when enabled, it only accepts relative paths matching `GONG_RAW_REQUEST_ALLOWED_PREFIXES`, rejects absolute URLs, rejects path traversal (`..`), refuses to override `Authorization` / `Cookie` / `Content-Type` / `Host`, and strips response headers from the payload returned to the LLM.
- **Error payloads are minimized.** Tool errors return the summarized Gong message only. Set `GONG_INCLUDE_ERROR_BODY=true` to restore the full error body (useful for debugging, not for production).
- **Input smuggling**: `extraParams` / `extraFilter` / additional headers cannot override typed fields (`fromDate`, `toDate`, `userIds`, `workspaceId`, `Authorization`, etc.).
- **PII**: transcripts and tool output may contain emails, phone numbers, and personal meeting URLs in clear text. Enable `REDACT_PII=true` to scrub them. Redaction applies to the summarized output *and* to the `raw: true` payloads (recursive walk on known PII keys).
- **Response-size caps**: the client aborts any Gong response over `GONG_MAX_RESPONSE_BYTES`, and any tool output over `GONG_MAX_TOOL_OUTPUT_BYTES` is truncated with a marker — prevents memory and context-window blowups.
- **Prompt injection awareness**: transcripts, call titles, and participant names come from external parties on a recorded call. Do not assume them trustworthy. The `gong_update_crm_object` tool mutates CRM data — consider running a read-only deployment (simply do not wire up that tool's permissions) if the LLM calling it cannot be isolated from poisoned input.
- **Multi-tenant**: this server is not designed to be shared across users with different credentials. One server process = one key pair.

---

## Development

```bash
# Typecheck
npm run typecheck

# Dev mode (manual reload, no watch)
npm run dev:local

# Build
npm run build

# End-to-end smoke test against a live tenant (requires valid .env + Docker)
./scripts/smoke.sh
```

Project structure:

```
src/
  index.ts         # MCP entry point (stdio transport)
  config.ts        # Environment variable loading
  client.ts        # Gong HTTP client (auth, errors, retries)
  logger.ts        # Stderr logger + header redaction
  redact.ts        # PII redaction
  tools/
    types.ts       # Shared types for tool handlers
    calls.ts       # gong_list_calls, gong_get_call, gong_get_call_transcript
    users.ts       # gong_list_users, gong_get_user_stats
    stats.ts       # gong_list_activity_stats
    crm.ts         # gong_update_crm_object
    raw.ts         # gong_raw_request
    index.ts       # Central registry
```

PRs welcome — please add a case to `scripts/smoke.sh` or a unit test when adding or modifying a tool.

---

## Known limitations

- **`gong_list_users` ignores `limit`**: Gong returns a fixed page size (~100) for this endpoint regardless of the value you pass. Cursor pagination still works.
- **`gong_get_user_stats` only covers users with activity in the window**: Gong only returns stats for users who had at least one call. Inactive users or users without activity return nothing.
- **`gong_update_crm_object`** has only been exercised against the batch endpoint `/v2/crm/entities`. Depending on your tenant and CRM integration (Salesforce, HubSpot…), additional fields (`integrationId`) may be required — use `gong_raw_request` to prototype.
- **Transcript speaker labels** are Gong's internal `speakerId`s, not real names. To resolve them, cross-reference with the `parties[]` returned by `gong_get_call`.
- **No auto-pagination**: intentional (keeps the LLM in control), but may require multiple turns for large volumes.

---

## License

MIT — see [LICENSE](./LICENSE).

This project is not affiliated with Gong.io. "Gong" is a registered trademark of Gong.io Ltd.
