import sql, { type ConnectionPool } from 'mssql';
import { type DatabaseConfig, type QueryResult, type TableSummary, type TableDescription } from '../types';
import { type DatabaseAdapter } from './adapter';

const ROW_CAP = 1000;
const SAMPLE_ROW_COUNT = 3;

export class MssqlAdapter implements DatabaseAdapter {
    private pool: ConnectionPool | null = null;
    private config: DatabaseConfig;

    constructor(config: DatabaseConfig) {
        this.config = config;
    }

    private async getPool(): Promise<ConnectionPool> {
        if (this.pool) return this.pool;

        const mssqlConfig: sql.config = {
            user: this.config.user,
            password: this.config.password,
            server: this.config.host,
            port: this.config.port,
            database: this.config.database,
            options: {
                encrypt: true,
                trustServerCertificate: this.config.trustServerCertificate ?? false,
            },
            pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        };

        const newPool = new sql.ConnectionPool(mssqlConfig);
        newPool.on('error', (err) => {
            console.error('MSSQL connection error:', err);
        });
        this.pool = await newPool.connect();
        return this.pool;
    }

    async executeQuery(query: string): Promise<QueryResult> {
        const pool = await this.getPool();
        const result = await pool.request().query(query);
        const recordSet = (result.recordset || []) as Record<string, unknown>[];
        const columns = recordSet.length > 0 ? Object.keys(recordSet[0]) : [];
        const truncated = recordSet.length >= ROW_CAP;
        const rows = truncated ? recordSet.slice(0, ROW_CAP) : recordSet;

        const res: QueryResult = {
            column: columns,
            rows,
            rowCount: rows.length,
            ...(truncated && { truncated: true }),
        };
        const rowsAffected = (result as { rowsAffected?: number[] }).rowsAffected;
        if (rowsAffected) res.rowsAffected = rowsAffected;
        return res;
    }

    async listTables(): Promise<TableSummary[]> {
        const result = await this.executeQuery(`
            SELECT
                s.name                           AS schema_name,
                t.name                           AS table_name,
                SUM(p.rows)                      AS row_count,
                SUM(a.total_pages) * 8 / 1024.0  AS size_mb
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.partitions p
                ON p.object_id = t.object_id
                AND p.index_id IN (0, 1)
            JOIN sys.allocation_units a ON a.container_id = p.partition_id
            GROUP BY s.name, t.name
            ORDER BY s.name, t.name
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
            : ['dbo', tableName];

        const columnsResult = await this.executeQuery(`
            SELECT
                c.COLUMN_NAME        AS column_name,
                c.DATA_TYPE          AS data_type,
                c.CHARACTER_MAXIMUM_LENGTH AS max_length,
                c.NUMERIC_PRECISION  AS numeric_precision,
                c.NUMERIC_SCALE      AS numeric_scale,
                c.IS_NULLABLE        AS is_nullable,
                c.COLUMN_DEFAULT     AS column_default,
                c.ORDINAL_POSITION   AS ordinal_position,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
                CASE WHEN id.object_id IS NOT NULL THEN 1 ELSE 0 END AS is_identity
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                    AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                    AND tc.TABLE_NAME = ku.TABLE_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                  AND tc.TABLE_SCHEMA = '${schemaName}'
                  AND tc.TABLE_NAME = '${tblName}'
            ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
            LEFT JOIN sys.identity_columns id
                ON id.object_id = OBJECT_ID('${schemaName}.${tblName}')
                AND id.name = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = '${schemaName}'
              AND c.TABLE_NAME = '${tblName}'
            ORDER BY c.ORDINAL_POSITION
        `);

        const columns = (columnsResult.rows ?? []).map(row => {
            let type = String(row.data_type);
            if (row.max_length !== null) type += `(${row.max_length})`;
            else if (row.numeric_precision !== null) type += `(${row.numeric_precision},${row.numeric_scale})`;
            return {
                name: String(row.column_name),
                type,
                nullable: row.is_nullable === 'YES',
                default: row.column_default !== null ? String(row.column_default) : null,
                primary_key: row.is_primary_key === 1,
                identity: row.is_identity === 1,
            };
        });

        const fkResult = await this.executeQuery(`
            SELECT
                fk.name                          AS constraint_name,
                col.name                         AS column_name,
                OBJECT_SCHEMA_NAME(ref.referenced_object_id) AS ref_schema,
                OBJECT_NAME(ref.referenced_object_id)        AS ref_table,
                rcol.name                        AS ref_column,
                fk.delete_referential_action_desc AS on_delete,
                fk.update_referential_action_desc AS on_update
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns ref ON fk.object_id = ref.constraint_object_id
            JOIN sys.columns col
                ON col.object_id = fk.parent_object_id
                AND col.column_id = ref.parent_column_id
            JOIN sys.columns rcol
                ON rcol.object_id = ref.referenced_object_id
                AND rcol.column_id = ref.referenced_column_id
            WHERE fk.parent_object_id = OBJECT_ID('${schemaName}.${tblName}')
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
                i.name                  AS index_name,
                i.type_desc             AS index_type,
                i.is_unique             AS is_unique,
                i.is_primary_key        AS is_primary_key,
                STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            WHERE i.object_id = OBJECT_ID('${schemaName}.${tblName}')
              AND i.name IS NOT NULL
              AND ic.is_included_column = 0
            GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
        `);

        const indexes = (idxResult.rows ?? []).map(row => ({
            name: String(row.index_name),
            type: String(row.index_type),
            unique: row.is_unique === true || row.is_unique === 1,
            primary_key: row.is_primary_key === true || row.is_primary_key === 1,
            columns: String(row.columns).split(', '),
        }));

        const countResult = await this.executeQuery(`
            SELECT SUM(p.rows) AS row_count
            FROM sys.partitions p
            JOIN sys.tables t ON t.object_id = p.object_id
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            WHERE p.index_id IN (0, 1)
              AND s.name = '${schemaName}'
              AND t.name = '${tblName}'
        `);
        const rowCount = countResult.rows?.[0]?.row_count !== undefined
            ? Number(countResult.rows[0].row_count)
            : null;

        const sampleResult = await this.executeQuery(
            `SELECT TOP ${SAMPLE_ROW_COUNT} * FROM [${schemaName}].[${tblName}]`
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

    async closePool(): Promise<void> {
        if (!this.pool) return;
        try {
            await this.pool.close();
            console.error('MSSQL connection pool closed.');
        } catch (err) {
            console.error('Error closing MSSQL pool:', err);
        } finally {
            this.pool = null;
        }
    }
}
