import { Pool } from 'pg';
import { type DatabaseConfig, type QueryResult, type TableSummary, type TableDescription, type QueryImpact, type CascadeInfo } from '../types';
import { type DatabaseAdapter } from './adapter';
import { parseQuery, buildCountQuery, buildWarnings } from './queryParser';

const ROW_CAP = 1000;
const SAMPLE_ROW_COUNT = 3;

export class PgsqlAdapter implements DatabaseAdapter {
    private pool: Pool | null = null;
    private config: DatabaseConfig;

    constructor(config: DatabaseConfig) {
        this.config = config;
    }

    private getPool(): Pool {
        if (this.pool) return this.pool;

        this.pool = new Pool({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            password: this.config.password,
            database: this.config.database,
            max: 10,
            idleTimeoutMillis: 30000,
        });

        this.pool.on('error', (err) => {
            console.error('PostgreSQL connection error:', err);
        });

        return this.pool;
    }

    async executeQuery(query: string): Promise<QueryResult> {
        const pool = this.getPool();
        const result = await pool.query(query);
        const rows = result.rows as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : result.fields.map(f => f.name);
        const truncated = rows.length >= ROW_CAP;
        const cappedRows = truncated ? rows.slice(0, ROW_CAP) : rows;

        const res: QueryResult = {
            column: columns,
            rows: cappedRows,
            rowCount: cappedRows.length,
            ...(truncated && { truncated: true }),
        };
        if (result.rowCount !== null && result.rowCount !== undefined) {
            res.rowsAffected = [result.rowCount];
        }
        return res;
    }

    async listTables(): Promise<TableSummary[]> {
        const result = await this.executeQuery(`
            SELECT
                n.nspname                                        AS schema_name,
                c.relname                                        AS table_name,
                c.reltuples::BIGINT                              AS row_count,
                pg_total_relation_size(c.oid) / 1024.0 / 1024.0 AS size_mb
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY n.nspname, c.relname
        `);

        return (result.rows ?? []).map(row => ({
            schema: String(row.schema_name),
            table: String(row.table_name),
            full_name: `${row.schema_name}.${row.table_name}`,
            row_count: row.row_count !== null ? Number(row.row_count) : null,
            size_mb: row.size_mb !== null ? Math.round(Number(row.size_mb) * 100) / 100 : null,
        }));
    }

    async describeTable(tableName: string): Promise<TableDescription> {
        const [schemaName, tblName] = tableName.includes('.')
            ? tableName.split('.', 2)
            : ['public', tableName];

        const columnsResult = await this.executeQuery(`
            SELECT
                a.attname                                    AS column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                NOT a.attnotnull                             AS is_nullable,
                pg_get_expr(d.adbin, d.adrelid)             AS column_default,
                CASE WHEN pk.attname IS NOT NULL THEN true ELSE false END AS is_primary_key,
                a.attidentity != ''                         AS is_identity,
                a.attnum                                    AS ordinal_position
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attrdef d
                ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            LEFT JOIN (
                SELECT pa.attname
                FROM pg_index i
                JOIN pg_attribute pa ON pa.attrelid = i.indrelid AND pa.attnum = ANY(i.indkey)
                WHERE i.indrelid = (
                    SELECT oid FROM pg_class
                    WHERE relname = '${tblName}'
                      AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schemaName}')
                )
                AND i.indisprimary
            ) pk ON pk.attname = a.attname
            WHERE c.relname = '${tblName}'
              AND n.nspname = '${schemaName}'
              AND a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY a.attnum
        `);

        const columns = (columnsResult.rows ?? []).map(row => ({
            name: String(row.column_name),
            type: String(row.data_type),
            nullable: Boolean(row.is_nullable),
            default: row.column_default !== null ? String(row.column_default) : null,
            primary_key: Boolean(row.is_primary_key),
            identity: Boolean(row.is_identity),
        }));

        const fkResult = await this.executeQuery(`
            SELECT
                con.conname                              AS constraint_name,
                att.attname                              AS column_name,
                fn.nspname                               AS ref_schema,
                fc.relname                               AS ref_table,
                fatt.attname                             AS ref_column,
                CASE con.confdeltype
                    WHEN 'a' THEN 'NO ACTION'
                    WHEN 'r' THEN 'RESTRICT'
                    WHEN 'c' THEN 'CASCADE'
                    WHEN 'n' THEN 'SET NULL'
                    WHEN 'd' THEN 'SET DEFAULT'
                END AS on_delete,
                CASE con.confupdtype
                    WHEN 'a' THEN 'NO ACTION'
                    WHEN 'r' THEN 'RESTRICT'
                    WHEN 'c' THEN 'CASCADE'
                    WHEN 'n' THEN 'SET NULL'
                    WHEN 'd' THEN 'SET DEFAULT'
                END AS on_update
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute att
                ON att.attrelid = c.oid AND att.attnum = con.conkey[1]
            JOIN pg_class fc ON fc.oid = con.confrelid
            JOIN pg_namespace fn ON fn.oid = fc.relnamespace
            JOIN pg_attribute fatt
                ON fatt.attrelid = fc.oid AND fatt.attnum = con.confkey[1]
            WHERE con.contype = 'f'
              AND c.relname = '${tblName}'
              AND n.nspname = '${schemaName}'
        `);

        const foreignKeys = (fkResult.rows ?? []).map(row => ({
            constraint: String(row.constraint_name),
            column: String(row.column_name),
            references: {
                table: `${row.ref_schema}.${row.ref_table}`,
                column: String(row.ref_column),
            },
            on_delete: String(row.on_delete),
            on_update: String(row.on_update),
        }));

        const idxResult = await this.executeQuery(`
            SELECT
                i.relname                               AS index_name,
                am.amname                               AS index_type,
                ix.indisunique                          AS is_unique,
                ix.indisprimary                         AS is_primary_key,
                STRING_AGG(a.attname, ', ' ORDER BY array_position(ix.indkey, a.attnum)) AS columns
            FROM pg_index ix
            JOIN pg_class c ON c.oid = ix.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_am am ON am.oid = i.relam
            JOIN pg_attribute a
                ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
            WHERE c.relname = '${tblName}'
              AND n.nspname = '${schemaName}'
            GROUP BY i.relname, am.amname, ix.indisunique, ix.indisprimary
        `);

        const indexes = (idxResult.rows ?? []).map(row => ({
            name: String(row.index_name),
            type: String(row.index_type).toUpperCase(),
            unique: Boolean(row.is_unique),
            primary_key: Boolean(row.is_primary_key),
            columns: String(row.columns).split(', '),
        }));

        const countResult = await this.executeQuery(`
            SELECT reltuples::BIGINT AS row_count
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = '${tblName}'
              AND n.nspname = '${schemaName}'
        `);
        const rowCount = countResult.rows?.[0]?.row_count !== undefined
            ? Number(countResult.rows[0].row_count)
            : null;

        const sampleResult = await this.executeQuery(
            `SELECT * FROM "${schemaName}"."${tblName}" LIMIT ${SAMPLE_ROW_COUNT}`
        );

        return {
            table: `${schemaName}.${tblName}`,
            statistics: { row_count: rowCount },
            columns,
            foreign_keys: foreignKeys,
            indexes,
            sample_rows: sampleResult.rows ?? [],
        };
    }

    async analyzeQueryImpact(sql: string): Promise<QueryImpact> {
        const parsed = parseQuery(sql, 'pgsql');
        const warnings = buildWarnings(parsed);
        const recommendations: string[] = [];
        const cascades: CascadeInfo[] = [];

        const countQuery = buildCountQuery(sql, 'pgsql');
        const schemaName = parsed.schema ?? countQuery?.primarySchema ?? 'public';
        const tblName = parsed.table ?? countQuery?.primaryTable ?? null;
        let estimatedRows: number | null = null;

        if (!tblName) {
            if (parsed.operation === 'DELETE' || parsed.operation === 'UPDATE') {
                recommendations.push('Could not parse table name — run a SELECT first to verify affected rows before executing.');
            }
            return { operation: parsed.operation, table: null, estimated_rows_affected: null, cascades, warnings, recommendations };
        }

        // Row estimation for DELETE / UPDATE
        if (countQuery && (parsed.operation === 'DELETE' || parsed.operation === 'UPDATE')) {
            try {
                const countResult = await this.executeQuery(countQuery.sql);
                estimatedRows = Number(countResult.rows?.[0]?.cnt ?? null);
            } catch { /* best-effort */ }

            if (estimatedRows === null) {
                recommendations.push(`Could not estimate affected rows — run ${countQuery.sql} to verify before executing.`);
            }
        }

        // Row estimation for TRUNCATE / DROP — use pg_class stats, no full scan
        if (parsed.operation === 'TRUNCATE' || parsed.operation === 'DROP') {
            try {
                const countResult = await this.executeQuery(`
                    SELECT reltuples::BIGINT AS cnt
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = '${tblName}'
                      AND n.nspname = '${schemaName}'
                `);
                estimatedRows = Number(countResult.rows?.[0]?.cnt ?? null);
            } catch { /* best-effort */ }
        }

        // CASCADE analysis — relevant for DELETE / TRUNCATE / DROP
        if (['DELETE', 'TRUNCATE', 'DROP'].includes(parsed.operation)) {
            try {
                const fkResult = await this.executeQuery(`
                    SELECT
                        fn.nspname   AS child_schema,
                        fc.relname   AS child_table,
                        att.attname  AS child_column,
                        CASE con.confdeltype
                            WHEN 'c' THEN 'CASCADE'
                            WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT'
                            WHEN 'r' THEN 'RESTRICT'
                            ELSE 'NO ACTION'
                        END AS on_delete
                    FROM pg_constraint con
                    JOIN pg_class rc ON rc.oid = con.confrelid
                    JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                    JOIN pg_class fc ON fc.oid = con.conrelid
                    JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                    JOIN pg_attribute att
                        ON att.attrelid = fc.oid AND att.attnum = con.conkey[1]
                    WHERE con.contype = 'f'
                      AND con.confdeltype = 'c'
                      AND rc.relname = '${tblName}'
                      AND rn.nspname = '${schemaName}'
                `);

                for (const row of fkResult.rows ?? []) {
                    let cascadeRows: number | null = null;
                    try {
                        if (parsed.operation === 'DELETE' && countQuery) {
                            const pkCol = await this.getPrimaryKeyColumn(schemaName, tblName);
                            const whereClause = countQuery.sql.match(/WHERE ([\s\S]+)$/i)?.[1];
                            const childCount = await this.executeQuery(`
                                SELECT COUNT(*) AS cnt
                                FROM "${row.child_schema}"."${row.child_table}" c
                                WHERE c."${row.child_column}" IN (
                                    SELECT "${pkCol}" FROM "${schemaName}"."${tblName}"
                                    ${whereClause ? `WHERE ${whereClause}` : ''}
                                )
                            `);
                            cascadeRows = Number(childCount.rows?.[0]?.cnt ?? null);
                        } else {
                            const childCount = await this.executeQuery(
                                `SELECT COUNT(*) AS cnt FROM "${row.child_schema}"."${row.child_table}"`
                            );
                            cascadeRows = Number(childCount.rows?.[0]?.cnt ?? null);
                        }
                    } catch { /* best-effort */ }

                    cascades.push({
                        table: `${row.child_schema}.${row.child_table}`,
                        column: String(row.child_column),
                        on_delete: String(row.on_delete),
                        estimated_rows: cascadeRows,
                    });
                }

                if (cascades.length > 0) {
                    warnings.push(`This operation will cascade to ${cascades.length} child table(s): ${cascades.map(c => c.table).join(', ')}.`);
                }
            } catch { /* best-effort */ }
        }

        // Recommendations
        if (estimatedRows !== null && estimatedRows > 1000) {
            recommendations.push(`Large operation (${estimatedRows.toLocaleString()} rows). Consider batching with LIMIT to reduce lock duration.`);
        }
        if (parsed.operation === 'DROP') {
            recommendations.push(`Back up data before dropping: CREATE TABLE "${schemaName}"."${tblName}_backup" AS SELECT * FROM "${schemaName}"."${tblName}".`);
        }
        if (parsed.operation === 'TRUNCATE') {
            recommendations.push('Consider DELETE with a WHERE clause if you only want to remove specific rows.');
        }

        return {
            operation: parsed.operation,
            table: `${schemaName}.${tblName}`,
            estimated_rows_affected: estimatedRows,
            cascades,
            warnings,
            recommendations,
        };
    }

    private async getPrimaryKeyColumn(schema: string, table: string): Promise<string> {
        const result = await this.executeQuery(`
            SELECT a.attname AS column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = (
                SELECT oid FROM pg_class
                WHERE relname = '${table}'
                  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')
            )
            AND i.indisprimary
            LIMIT 1
        `);
        return String(result.rows?.[0]?.column_name ?? 'id');
    }

    async closePool(): Promise<void> {
        if (!this.pool) return;
        try {
            await this.pool.end();
            console.error('PostgreSQL connection pool closed.');
        } catch (err) {
            console.error('Error closing PostgreSQL pool:', err);
        } finally {
            this.pool = null;
        }
    }
}
