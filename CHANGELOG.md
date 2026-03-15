# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.2] - 2026-03-15

### Added

- **`analyze_query_impact` tool** — analyzes a destructive SQL query before execution: estimates affected row count, detects CASCADE relationships to child tables, and returns warnings and recommendations. Supports `DELETE`, `UPDATE`, `TRUNCATE`, and `DROP` for both MSSQL and PostgreSQL.
- **Impact analysis in `run_query`** — in `confirm` mode, the impact analysis is automatically included in the hold response alongside the confirmation token.

### Fixed

- **Stacked query guard bypass** — queries like `SELECT 1; DROP TABLE foo` were not caught by the guard because only the first statement was checked. All statements in a semicolon-separated batch are now evaluated.
- **Cross join inflation in row estimation** — `UPDATE`/`DELETE` queries using explicit `JOIN ... ON` syntax (MSSQL style) produced wildly incorrect row estimates due to an implicit cross join in the generated `SELECT COUNT(*)`. The count query now preserves explicit `JOIN ... ON` syntax reconstructed from the AST.

---

## [0.1.0] - 2026-03-01

Initial release.

### Added

- **MCP server** with stdio transport, compatible with Claude Code, Cursor, Windsurf, and any MCP-compliant client
- **Microsoft SQL Server adapter** — connection pooling, query execution, schema introspection
- **PostgreSQL adapter** — connection pooling, query execution, schema introspection
- **`list_tables` tool** — lists all user tables with schema, row count, and size
- **`describe_table` tool** — returns full schema detail: columns, types, nullability, defaults, primary keys, identity columns, foreign keys, indexes, row count, and sample rows
- **`run_query` tool** — executes SQL with guard checks; safe queries run immediately, guarded operations are blocked or held for confirmation
- **`confirm_query` tool** — executes a held guarded query by UUID token (5-minute TTL)
- **Guard system** with two modes:
  - `confirm` (default) — guarded queries are held and require explicit confirmation via token
  - `block` — guarded queries are rejected outright
- **Configurable guarded operations** via `GUARDED_OPERATIONS` env var (default: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `EXEC`, `EXECUTE`, `MERGE`, `CREATE`, `GRANT`, `REVOKE`, `DENY`)
- **1000-row cap** on query results with `truncated` flag when results are cut off
- **Graceful shutdown** — closes DB connection pool on `SIGINT`/`SIGTERM`
