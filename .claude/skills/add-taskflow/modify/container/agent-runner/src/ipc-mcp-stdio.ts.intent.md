# ipc-mcp-stdio.ts Modifications

Add TaskFlow MCP tool registrations inside a conditional block:

1. Import `Database` from `better-sqlite3` and `TaskflowEngine` from `./taskflow-engine.js`
2. Add a conditional block: `if (process.env.NANOCLAW_IS_TASKFLOW_MANAGED === '1')`
3. Inside the block, create DB connection and engine instance
4. Register 9 MCP tools: taskflow_query, taskflow_create, taskflow_move, taskflow_reassign, taskflow_update, taskflow_dependency, taskflow_admin, taskflow_undo, taskflow_report
5. Each tool has a zod schema for input validation and calls the corresponding engine method
