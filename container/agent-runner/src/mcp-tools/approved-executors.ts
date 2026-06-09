/**
 * #407 — register the approved-action executors in the MAIN runner process.
 *
 * CRITICAL PROCESS-BOUNDARY FACT: the MCP tools (core.ts, taskflow-api-mutate.ts) run in a SEPARATE
 * subprocess — the SDK spawns `bun run mcp-tools/index.ts` as a stdio MCP server (see
 * container/agent-runner/src/index.ts). Their `registerApprovedExecutor(...)` side effects therefore
 * populate the registry IN THAT SUBPROCESS, not in the poll-loop's process.
 *
 * But the approved-action REPLAY (runApprovedActions → executeApprovedAction in poll-loop.ts) runs in
 * the MAIN process. Without this module that process's executor registry is EMPTY, so every approved
 * action would hit "no executor" and silently do nothing. The mcp-tools BARREL (./index.ts) cannot be
 * imported here because it calls startMcpServer() at import — so we import exactly the two modules
 * that register executors, for their side effects only (registerTools is a harmless no-op map push in
 * a process that never starts a server).
 *
 * The tool handlers are process-agnostic: they operate on the shared file-backed taskflow.db /
 * outbound.db / inbound.db and env (NANOCLAW_TASKFLOW_BOARD_ID), so they execute identically in the
 * main process. The replay runs at the top of the poll loop, before any agent turn, so it never races
 * a concurrent tool call in the MCP subprocess.
 */
import './core.js'; // registers send_message / send_file executors (#410)
import './taskflow-api-mutate.js'; // registers api_admin / api_move / api_reassign / api_delete executors (#407)
