import getConfig from '../config';
import { type DatabaseAdapter } from './adapter';
import { MssqlAdapter } from './mssql-adapter';
import { PgsqlAdapter } from './pgsql-adapter';

let adapter: DatabaseAdapter | null = null;

export const getAdapter = (): DatabaseAdapter => {
    if (adapter) return adapter;

    const config = getConfig();

    if (config.type === 'mssql') {
        adapter = new MssqlAdapter(config);
    } else {
        adapter = new PgsqlAdapter(config);
    }

    return adapter;
};
