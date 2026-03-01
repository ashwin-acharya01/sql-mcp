# sql-mcp

An MCP (Model Context Protocol) server for SQL databases with built-in guardrails against destructive operations.

AI coding agents can execute SQL queries autonomously — which means they can also accidentally run `DELETE`, `DROP`, or `UPDATE` on the wrong rows. `sql-mcp` sits between the agent and your database, intercepting guarded operations and requiring explicit confirmation before they execute.

**Supported databases**: Microsoft SQL Server, PostgreSQL

---

## Installation

```bash
# Run directly without installing
npx sql-mcp

# Or install globally
npm install -g sql-mcp
sql-mcp
```

---

## Configuration

`sql-mcp` is configured entirely via environment variables — either in your shell or in your MCP client's config.

### Required

| Variable | Description |
|---|---|
| `DB_TYPE` | Database type: `mssql` or `pgsql` |
| `DB_HOST` | Database server hostname |
| `DB_NAME` | Database name |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |

### Optional

| Variable | Default | Description |
|---|---|---|
| `DB_PORT` | `5432` (pgsql) / `1433` (mssql) | Database port |
| `GUARD_MODE` | `confirm` | `confirm` — hold guarded queries for approval. `block` — reject them outright |
| `GUARDED_OPERATIONS` | See below | Comma-separated SQL keywords to guard. `NONE` disables guarding. `ALL` uses the full default list |
| `DB_TRUST_SERVER_CERTIFICATE` | `false` | MSSQL only. Set to `true` for local/dev instances with self-signed certificates |

**Default guarded operations**: `INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, EXEC, EXECUTE, MERGE, CREATE, GRANT, REVOKE, DENY`

---

## MCP Client Setup

### Claude Code / Cursor / Windsurf

Add to your MCP settings (e.g. `~/.claude/settings.json` or your client's equivalent):

**PostgreSQL:**
```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["sql-mcp"],
      "env": {
        "DB_TYPE": "pgsql",
        "DB_HOST": "localhost",
        "DB_NAME": "mydb",
        "DB_USER": "postgres",
        "DB_PASSWORD": "secret"
      }
    }
  }
}
```

**SQL Server:**
```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["sql-mcp"],
      "env": {
        "DB_TYPE": "mssql",
        "DB_HOST": "localhost",
        "DB_NAME": "mydb",
        "DB_USER": "sa",
        "DB_PASSWORD": "secret",
        "DB_TRUST_SERVER_CERTIFICATE": "true"
      }
    }
  }
}
```

---

## Guard Modes

### `confirm` (default)

When a guarded operation is detected, `sql-mcp` holds the query and returns a token. The agent must call `confirm_query` with that token to execute it. This gives you a chance to review and approve before anything runs.

```
Agent: run_query("DELETE FROM users WHERE inactive = true")
  ← { needs_confirmation: true, token: "uuid", query: "...", expires_in_minutes: 5 }

[You review and approve]

Agent: confirm_query("uuid")
  ← { success: true, rowsAffected: [47] }
```

Tokens expire after **5 minutes**. If a token expires, re-run the original query to get a new one.

> **Note for "run everything" / auto-approve agent modes**: If your MCP client is configured to execute tool calls automatically without pausing for human review (e.g. Cursor's "run everything" mode), the agent may call `confirm_query` immediately after `run_query` without any human checkpoint. In this case, `confirm` mode offers no real protection — use `block` mode instead.

### `block`

All guarded operations are rejected immediately with no option to confirm. Use this for production environments or any setup where the agent runs autonomously without human review.

---

## Tools

### `list_tables`

Lists all user tables in the connected database.

**Returns**: schema name, table name, row count, size (MB) for each table.

```json
{
  "success": true,
  "table_count": 12,
  "tables": [
    { "schema": "public", "table": "users", "full_name": "public.users", "row_count": 15234, "size_mb": 45.2 }
  ]
}
```

---

### `describe_table`

Returns detailed schema information for a table.

**Parameters**:
- `tableName` — table name, optionally schema-prefixed (e.g. `"users"` or `"dbo.users"`)

**Returns**: columns (with types, nullability, defaults, PK/identity flags), foreign keys, indexes, row count, and sample rows.

```json
{
  "success": true,
  "table": "public.users",
  "statistics": { "row_count": 15234 },
  "columns": [
    { "name": "id", "type": "integer", "nullable": false, "default": null, "primary_key": true, "identity": true },
    { "name": "email", "type": "character varying(255)", "nullable": false, "default": null, "primary_key": false, "identity": false }
  ],
  "foreign_keys": [ ... ],
  "indexes": [ ... ],
  "sample_rows": [ ... ]
}
```

---

### `run_query`

Executes a SQL query.

**Parameters**:
- `sql` — the SQL query to run

Safe (non-guarded) queries execute immediately and return results. Guarded queries are handled according to the configured `GUARD_MODE`.

Results are capped at **1000 rows**. If a result set is truncated, the response includes `"truncated": true`.

---

### `confirm_query`

Executes a previously held guarded query.

**Parameters**:
- `token` — the UUID token returned by `run_query`

Only works if the token exists and has not expired (5-minute TTL).

---

## Requirements

- Node.js ≥ 18
- Network access to your database

---

## License

MIT
