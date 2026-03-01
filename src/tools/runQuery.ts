import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeQuery } from "../db/db";
import {
    isGuardedQuery,
    holdPendingQuery,
    getGuardMode,
    getGuardedOperations,
} from "../guards/queryGuard";

export function registerRunQuery(server: McpServer) {
    server.tool(
        "run_query",
        "Execute a SQL query against the connected database. Read-only queries run immediately. Guarded operations (INSERT, UPDATE, DELETE, DROP, etc.) are either blocked or held for confirmation depending on the server's guard mode.",
        {
            sql: z.string().min(1).describe("The SQL query to execute"),
        },
        async ({ sql }) => {
            const trimmed = sql.trim();

            if (isGuardedQuery(trimmed)) {
                const mode = getGuardMode();

                if (mode === "block") {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: false,
                                blocked: true,
                                reason: "This query contains a guarded operation and has been blocked.",
                                guarded_operations: getGuardedOperations(),
                                query: trimmed,
                            }, null, 2)
                        }],
                        isError: true,
                    };
                }

                // confirm mode — hold the query and return a token
                const token = holdPendingQuery(trimmed);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            needs_confirmation: true,
                            token,
                            query: trimmed,
                            message: "This query contains a guarded operation. Call confirm_query with the token to execute it.",
                            expires_in_minutes: 5,
                        }, null, 2)
                    }]
                };
            }

            // Safe query — execute immediately
            try {
                const result = await executeQuery(trimmed);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: true,
                            ...result,
                        }, null, 2)
                    }]
                };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ success: false, error: message }, null, 2)
                    }],
                    isError: true,
                };
            }
        }
    );
}
