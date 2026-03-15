import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAdapter } from "../db/index";

export function registerAnalyzeQueryImpact(server: McpServer) {
    server.tool(
        "analyze_query_impact",
        "Analyze the impact of a guarded SQL operation before executing it. Returns estimated rows affected, cascade effects on child tables, warnings, and recommendations. Use this before run_query to understand the consequences of a destructive operation.",
        {
            sql: z.string().min(1).describe("The SQL query to analyze"),
        },
        async ({ sql }) => {
            try {
                const impact = await getAdapter().analyzeQueryImpact(sql);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ success: true, ...impact }, null, 2)
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
