import { type QueryResult, type TableSummary, type TableDescription, type QueryImpact } from '../types';

export interface DatabaseAdapter {
    executeQuery(sql: string): Promise<QueryResult>;
    listTables(): Promise<TableSummary[]>;
    describeTable(tableName: string): Promise<TableDescription>;
    analyzeQueryImpact(sql: string): Promise<QueryImpact>;
    closePool(): Promise<void>;
}
