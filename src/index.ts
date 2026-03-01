import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "./db/db";
import { registerDescribeTable } from "./tools/describeTable";
import { registerListTables } from "./tools/listTables";
import { registerRunQuery } from "./tools/runQuery";
import { registerConfirmQuery } from "./tools/confirmQuery";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
) as { name: string; version: string };

const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { capabilities: {} }
);

registerDescribeTable(server);
registerListTables(server);
registerRunQuery(server);
registerConfirmQuery(server);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    console.log(`${pkg.name} MCP Server is running...`);
})

const shutdown = async () => {
    try {
        await server.close();
        await closePool();
        console.log("Server shutdown complete.");
    } catch (err) {
        console.error("Error during shutdown:", err);
    }
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);