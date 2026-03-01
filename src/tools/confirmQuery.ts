import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeQuery } from "../db/db";
import { retrieveQuery } from "../guards/queryGuard";

export function registerConfirmQuery(server: McpServer) {
    server.tool(
        "confirm_query",
        "Execute a previously held guarded query using its confirmation token. Tokens are returned by run_query when a guarded operation requires confirmation. Tokens expire after 5 minutes.",
        {
            token: z.string().uuid().describe("The confirmation token returned by run_query"),
        },
        async ({ token }) => {
            const sql = retrieveQuery(token);

            if (!sql) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            error: "Token not found or expired. Re-run the original query to get a new token.",
                        }, null, 2)
                    }],
                    isError: true,
                };
            }

            try {
                const result = await executeQuery(sql);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: true,
                            confirmed_query: sql,
                            ...result,
                        }, null, 2)
                    }]
                };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            error: message,
                            confirmed_query: sql,
                        }, null, 2)
                    }],
                    isError: true,
                };
            }
        }
    );
}
