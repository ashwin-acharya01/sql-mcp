import pkg from 'node-sql-parser';
import { type DmlOperation, type DbType } from '../types';

const { Parser } = pkg;
const parser = new Parser();

export interface ParsedQuery {
    operation: DmlOperation;
    // Primary table being modified — used for cascade lookup and display
    table: string | null;
    schema: string | null;
    hasWhereClause: boolean;
}

export interface CountQuery {
    // Executable SELECT COUNT(*) AS cnt that mirrors the DML's full FROM + WHERE context
    sql: string;
    // Primary table (for cascade analysis)
    primaryTable: string;
    primarySchema: string | null;
}

type AstEntry = {
    table: string;
    as: string | null;
    db: string | null;
    join?: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on?: any;
};

const DIALECT: Record<DbType, string> = {
    mssql: 'TransactSQL',
    pgsql: 'PostgresQL',
};

function quote(name: string, dbType: DbType): string {
    return dbType === 'mssql' ? `[${name}]` : `"${name}"`;
}

function formatTableRef(entry: AstEntry, dbType: DbType): string {
    const schema = entry.db ? `${quote(entry.db, dbType)}.` : '';
    const table = quote(entry.table, dbType);
    const alias = entry.as ? ` ${entry.as}` : '';
    return `${schema}${table}${alias}`;
}

function extractWhereText(sql: string): string | null {
    const match = sql.match(/\bWHERE\b([\s\S]+?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i);
    return match ? match[1].trim() : null;
}

export function parseQuery(sql: string, dbType: DbType): ParsedQuery {
    const upper = sql.trim().toUpperCase();
    let operation: DmlOperation = 'OTHER';
    if (upper.startsWith('DELETE'))        operation = 'DELETE';
    else if (upper.startsWith('UPDATE'))   operation = 'UPDATE';
    else if (upper.startsWith('INSERT'))   operation = 'INSERT';
    else if (upper.startsWith('TRUNCATE')) operation = 'TRUNCATE';
    else if (upper.startsWith('DROP'))     operation = 'DROP';

    const base: ParsedQuery = { operation, table: null, schema: null, hasWhereClause: false };

    if (operation === 'OTHER' || operation === 'INSERT') return base;

    try {
        const ast = parser.astify(sql, { database: DIALECT[dbType] });
        const stmt = (Array.isArray(ast) ? ast[0] : ast) as unknown as Record<string, unknown>;

        // TRUNCATE / DROP — table info is in stmt.name[]
        if (operation === 'TRUNCATE' || operation === 'DROP') {
            const names = stmt.name as AstEntry[] | undefined;
            return {
                ...base,
                table: names?.[0]?.table ?? null,
                schema: names?.[0]?.db ?? null,
            };
        }

        // DELETE — primary table is always from[0] (real table name, correct schema)
        if (operation === 'DELETE') {
            const from = (stmt.from as AstEntry[] | null | undefined) ?? [];
            return {
                ...base,
                table: from[0]?.table ?? null,
                schema: from[0]?.db ?? null,
                hasWhereClause: !!stmt.where,
            };
        }

        // UPDATE — primary table depends on style
        if (operation === 'UPDATE') {
            const tables = (stmt.table as AstEntry[] | null | undefined) ?? [];
            const fromClause = (stmt.from as AstEntry[] | null | undefined) ?? [];

            // CTE: stmt.with is present and table[0] refers to the CTE name, not a real table
            if (stmt.with) {
                return { ...base, hasWhereClause: !!stmt.where };
            }

            // MSSQL JOIN style: table[0].table is an alias, from[0] has the real table
            const mssqlJoinStyle = fromClause.length > 0
                && tables[0] != null
                && fromClause[0].as === tables[0].table;

            const primaryEntry = mssqlJoinStyle ? fromClause[0] : tables[0];
            return {
                ...base,
                table: primaryEntry?.table ?? null,
                schema: primaryEntry?.db ?? null,
                hasWhereClause: !!stmt.where,
            };
        }

    } catch { /* parser failed — adapters handle null table gracefully */ }

    return base;
}

// Reconstructs the ON condition text for a JOIN entry by re-sqlifying a minimal SELECT AST.
// node-sql-parser's sqlify accepts a full AST — we embed the ON expr as a WHERE clause
// on a dummy SELECT and strip the surrounding SQL to get just the condition text.
function sqlifyExpr(on: unknown): string {
    try {
        const dummy = { type: 'select', columns: [{ expr: { type: 'number', value: 1 }, as: null }], from: null, where: on } as unknown as pkg.AST;
        return parser.sqlify(dummy).replace(/^SELECT\s+1\s+WHERE\s+/i, '').trim();
    } catch { return ''; }
}

// Builds "FROM table [JOIN table ON ...]" preserving explicit JOIN...ON for MSSQL-style
// entries (which carry join/on AST fields). PG FROM-style entries have no join field —
// their condition lives in WHERE — so they are comma-appended to the first table.
function buildFromClause(entries: AstEntry[], dbType: DbType): string {
    if (entries.length === 0) return '';

    const parts: string[] = [`FROM ${formatTableRef(entries[0], dbType)}`];

    for (let i = 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.join) {
            const onSql = entry.on ? sqlifyExpr(entry.on) : '';
            const onClause = onSql ? ` ON ${onSql}` : '';
            parts.push(`${entry.join} ${formatTableRef(entry, dbType)}${onClause}`);
        } else {
            // PG FROM style — condition is in WHERE, comma-append is correct
            parts[0] += `, ${formatTableRef(entry, dbType)}`;
        }
    }

    return parts.join(' ');
}

// Builds a SELECT COUNT(*) AS cnt query that mirrors the full FROM + WHERE context of a
// DELETE or UPDATE. Returns null if the query cannot be parsed or has no identifiable table.
// Not applicable to TRUNCATE/DROP — those use catalog queries in the adapters directly.
export function buildCountQuery(sql: string, dbType: DbType): CountQuery | null {
    try {
        const ast = parser.astify(sql, { database: DIALECT[dbType] });
        const stmt = (Array.isArray(ast) ? ast[0] : ast) as unknown as Record<string, unknown>;
        const op = (stmt.type as string).toUpperCase();

        if (op !== 'DELETE' && op !== 'UPDATE') return null;

        const whereText = stmt.where ? extractWhereText(sql) : null;
        const where = whereText ? ` WHERE ${whereText}` : '';

        if (op === 'DELETE') {
            const from = (stmt.from as AstEntry[] | null | undefined) ?? [];
            if (!from[0]) return null;

            return {
                sql: `SELECT COUNT(*) AS cnt ${buildFromClause(from, dbType)}${where}`,
                primaryTable: from[0].table,
                primarySchema: from[0].db ?? null,
            };
        }

        // UPDATE
        const tables = (stmt.table as AstEntry[] | null | undefined) ?? [];
        const fromClause = (stmt.from as AstEntry[] | null | undefined) ?? [];

        // CTE-based UPDATE — table[0] is the CTE name, not a real table; skip estimation
        if (stmt.with) return null;

        if (!tables[0]) return null;

        const mssqlJoinStyle = fromClause.length > 0
            && fromClause[0].as === tables[0].table;

        let fromEntries: AstEntry[];
        let primaryEntry: AstEntry;

        if (mssqlJoinStyle) {
            // MSSQL JOIN style: from[] has real primary + all joins
            fromEntries = fromClause;
            primaryEntry = fromClause[0];
        } else if (fromClause.length > 0) {
            // PG FROM style: table[] has primary, from[] has join sources
            fromEntries = [...tables, ...fromClause];
            primaryEntry = tables[0];
        } else {
            // Simple single-table UPDATE
            fromEntries = tables;
            primaryEntry = tables[0];
        }

        return {
            sql: `SELECT COUNT(*) AS cnt ${buildFromClause(fromEntries, dbType)}${where}`,
            primaryTable: primaryEntry.table,
            primarySchema: primaryEntry.db ?? null,
        };

    } catch { return null; }
}

export function buildWarnings(parsed: ParsedQuery): string[] {
    const warnings: string[] = [];

    if ((parsed.operation === 'DELETE' || parsed.operation === 'UPDATE') && !parsed.hasWhereClause) {
        warnings.push(`No WHERE clause — this ${parsed.operation} will affect ALL rows in the table.`);
    }
    if (parsed.operation === 'TRUNCATE') {
        warnings.push('TRUNCATE removes all rows and cannot be filtered with a WHERE clause.');
    }
    if (parsed.operation === 'DROP') {
        warnings.push('DROP TABLE permanently removes the table and all its data.');
    }

    return warnings;
}
