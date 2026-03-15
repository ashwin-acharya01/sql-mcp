import { GuardMode } from "../types";

const PENDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GUARDED = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "EXEC",
    "EXECUTE",
    "MERGE",
    "CREATE",
    "GRANT",
    "REVOKE",
    "DENY"
];

const parseGuardedOperations = (): string[] => {
    const ops = process.env.GUARDED_OPERATIONS?.trim().toUpperCase();
    if (!ops || ops === 'NONE') return [];
    if (ops === 'ALL') return [...DEFAULT_GUARDED];
    return ops.split(',').map(op => op.trim()).filter(Boolean);
}

const guardedList = parseGuardedOperations();
const guardedRegex = guardedList.length > 0 ? new RegExp(`^\\s*(${guardedList.join("|")})\\b`, "i") : null;

const parseGuardMode = (): GuardMode => {
    const mode = process.env.GUARD_MODE?.trim().toLowerCase();
    if (mode == 'block') return 'block';
    return 'confirm';
}

export const getGuardMode = (): GuardMode => {
    return parseGuardMode();
}

const pendingQueries = new Map<string, { sql: string, createdAt: number }>();

const purgeExpiredQueries = () => {
    const now = Date.now();
    for (const [token, entry] of pendingQueries.entries()) {
        if (now - entry.createdAt > PENDING_TTL_MS) {
            pendingQueries.delete(token);
        }
    }
}

export const isGuardedQuery = (sql: string) : boolean => {
    if (!guardedRegex) return false;
    if (!sql.trim()) return false;
    return sql.split(';').some(stmt => guardedRegex!.test(stmt));
}

export const hasPendingQuery = () : boolean => {
    purgeExpiredQueries();
    return pendingQueries.size > 0;
}

export const getPendingQueryInfo = () : { token: string, preview: string } | null => {
    purgeExpiredQueries();
    for (const [token, entry] of pendingQueries.entries()) {
        return { token, preview: entry.sql.length > 100 ? entry.sql.substring(0, 100) + "..." : entry.sql };
    }

    return null;
}

export const holdPendingQuery = (sql: string) : string => {
    purgeExpiredQueries();
    const token = crypto.randomUUID();
    pendingQueries.set(token, { sql, createdAt: Date.now() });
    return token;
}

export const retrieveQuery = (token: string) : string | null => {
    purgeExpiredQueries();
    const entry = pendingQueries.get(token);
    if(!entry) {
        return null;
    }
    if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
        pendingQueries.delete(token);
        return null;
    }
    pendingQueries.delete(token);
    return entry.sql;
}

export function getGuardedOperations(): string[] {
    return [...guardedList];
}



