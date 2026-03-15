export type DbType = 'mssql' | 'pgsql';

export interface DatabaseConfig {
    type: DbType;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    // MSSQL-specific
    trustServerCertificate?: boolean;
}

export interface QueryResult {
    column: string[];
    rows?: Record<string, unknown>[];
    rowCount?: number;
    truncated?: boolean;
    rowsAffected?: number[];
}

export interface ColumnInfo {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    primary_key: boolean;
    identity: boolean;
}

export interface ForeignKeyInfo {
    constraint: string;
    column: string;
    references: {
        table: string;
        column: string;
    };
    on_delete: string;
    on_update: string;
}

export interface IndexInfo {
    name: string;
    type: string;
    unique: boolean;
    primary_key: boolean;
    columns: string[];
}

export interface TableSummary {
    schema: string;
    table: string;
    full_name: string;
    row_count: number | null;
    size_mb: number | null;
}

export interface TableDescription {
    table: string;
    statistics: { row_count: number | null };
    columns: ColumnInfo[];
    foreign_keys: ForeignKeyInfo[];
    indexes: IndexInfo[];
    sample_rows: Record<string, unknown>[];
}

export type GuardMode = "confirm" | "block";

export type DmlOperation = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "DROP" | "OTHER";

export interface CascadeInfo {
    table: string;
    column: string;
    on_delete: string;
    estimated_rows: number | null;
}

export interface QueryImpact {
    operation: DmlOperation;
    table: string | null;
    estimated_rows_affected: number | null;
    cascades: CascadeInfo[];
    warnings: string[];
    recommendations: string[];
}