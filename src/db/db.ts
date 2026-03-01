// Thin delegation layer — keeps tool imports stable while the real
// implementation lives in the adapter selected by src/db/index.ts.
import { getAdapter } from './index';
import { type QueryResult } from '../types';

export const executeQuery = (sql: string): Promise<QueryResult> =>
    getAdapter().executeQuery(sql);

export const closePool = (): Promise<void> =>
    getAdapter().closePool();
