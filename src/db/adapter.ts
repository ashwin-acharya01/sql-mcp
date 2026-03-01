import { type QueryResult, type TableSummary, type TableDescription } from '../types';

export interface DatabaseAdapter {
    executeQuery(sql: string): Promise<QueryResult>;
    listTables(): Promise<TableSummary[]>;
    describeTable(tableName: string): Promise<TableDescription>;
    closePool(): Promise<void>;
}
