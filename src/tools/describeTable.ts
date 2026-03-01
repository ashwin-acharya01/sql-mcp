import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAdapter } from "../db/index";

export function registerDescribeTable(server: McpServer) {
    server.tool(
        "describe_table",
        "Get detailed schema information for a table: columns, types, nullability, defaults, primary keys, foreign keys, indexes, row count, and sample data.",
        {
            tableName: z.string().describe("The name of the table to describe (e.g. 'users' or 'dbo.users')"),
        },
        async ({ tableName }) => {
            try {
                const description = await getAdapter().describeTable(tableName);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ success: true, ...description }, null, 2)
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
