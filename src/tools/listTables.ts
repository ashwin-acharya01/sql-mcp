import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAdapter } from "../db/index";

export function registerListTables(server: McpServer) {
    server.tool(
        "list_tables",
        "List all user tables in the connected database with their schema, row count, and size.",
        {},
        async () => {
            try {
                const tables = await getAdapter().listTables();
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: true,
                            table_count: tables.length,
                            tables,
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
