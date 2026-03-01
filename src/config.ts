import dotenv from 'dotenv';
import { type DatabaseConfig, type DbType } from './types';

dotenv.config();

const getConfig = (): DatabaseConfig => {
    const type = process.env.DB_TYPE?.toLowerCase() as DbType | undefined;
    const host = process.env.DB_HOST;
    const database = process.env.DB_NAME;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;

    const missing: string[] = [];
    if (!type) missing.push('DB_TYPE');
    if (!host) missing.push('DB_HOST');
    if (!database) missing.push('DB_NAME');
    if (!user) missing.push('DB_USER');
    if (!password) missing.push('DB_PASSWORD');

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (type !== 'mssql' && type !== 'pgsql') {
        throw new Error(`Invalid DB_TYPE '${type}'. Must be 'mssql' or 'pgsql'.`);
    }

    const portDefault = type === 'mssql' ? 1433 : 5432;
    const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : portDefault;
    const trustServerCertificate =
        process.env.DB_TRUST_SERVER_CERTIFICATE?.toLowerCase() === 'true' ||
        process.env.DB_TRUST_SERVER_CERTIFICATE === '1';

    return {
        type,
        host: host!,
        port,
        user: user!,
        password: password!,
        database: database!,
        trustServerCertificate,
    };
};

export default getConfig;
