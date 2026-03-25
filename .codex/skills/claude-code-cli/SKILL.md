---
name: claude-code-cli
description: Use when you need Codex to invoke the local Claude Code CLI for headless code analysis, refactoring, editing, or to continue or resume an existing Claude Code session from the terminal.
---

# Claude Code CLI

Use this skill when the user explicitly wants Claude Code involved, or when a second agent pass through the local `claude` CLI will materially help with analysis or implementation.

## Preflight

Before invoking Claude Code, verify the local CLI is usable:

```bash
command -v claude
claude --version
claude auth status --text
```

If `claude` is missing, not authenticated, or the user wants a different account or workspace, stop and say so.

Run Claude from the target repository root when possible. If Claude needs access outside the current directory, add explicit paths with `--add-dir`.

## Choose The Right Mode

Use headless mode for automation:

- Read-only analysis:
  ```bash
  claude -p --permission-mode plan --output-format text "Analyze the scheduler flow in src/ and list the top 3 risks."
  ```
- Edit-capable refactor or code generation:
  ```bash
  claude -p --permission-mode acceptEdits --output-format text "Refactor src/foo.ts to remove duplicated retry logic and keep tests passing."
  ```
- Continue the most recent Claude session in the current directory:
  ```bash
  claude -c -p "Continue from the prior session and finish the remaining test fixes."
  ```
- Resume a specific Claude session:
  ```bash
  claude -r SESSION_ID -p "Pick up where you left off and summarize the next code changes."
  ```
- Branch from prior context without mutating the original session:
  ```bash
  claude -r SESSION_ID --fork-session -p "Explore an alternative refactor that minimizes file churn."
  ```

Use interactive `claude` without `-p` only when the user explicitly wants a live Claude TUI session. For Codex-driven automation, prefer `-p`.

## Prompting Rules

Give Claude a bounded task:

- State whether the task is analysis-only or may edit files.
- Name the exact files, modules, or directories to inspect.
- State constraints: no unrelated edits, preserve behavior, keep style consistent, run or skip tests, output format required.
- Ask for concrete deliverables such as findings, patch plan, or implemented changes.

Good prompt pattern:

```text
You are working in <repo-root>.
Task: analyze or edit [scope].
Constraints: [allowed files/tools], [testing expectations], [no unrelated changes].
Deliverable: [summary, findings, patch, or verification notes].
```

## Safety And Tooling Guidance

- Prefer `--permission-mode plan` for audits, reviews, architecture comparisons, and debugging.
- Prefer `--permission-mode acceptEdits` only when the user wants Claude to write code.
- Avoid `bypassPermissions` or `--dangerously-skip-permissions` unless the user explicitly requests it and the environment is already isolated.
- Use `--allowed-tools` or `--disallowed-tools` when narrowing Claude's tool surface is useful.
- Use `--output-format json` only when you intend to inspect or parse the returned structure. Do not assume field names; inspect the actual output from the installed Claude Code version first.
- If the caller needs hard wall-clock bounds, apply them outside Claude Code with the surrounding harness or shell rather than assuming the CLI will stop itself at a specific turn count.

## Observed JSON Output

In this environment on Claude Code `2.1.81`, successful `claude -p --output-format json` runs included these top-level keys:

- `type`
- `subtype`
- `is_error`
- `result`
- `session_id`
- `total_cost_usd`
- `usage`
- `modelUsage`

Treat that as an observed example, not a permanent contract. If your automation depends on specific fields, run one small command first and inspect the real output from the installed CLI.

## Environment Note

Claude Code headless runs may stall in restricted sandboxes because the CLI still needs to reach Anthropic's remote service. If a headless run starts but does not complete in a sandboxed environment, rerun it with the minimum permissions needed to let `claude` access the network.

## Resume Workflow

When the user asks to "continue Claude", "resume the earlier Claude run", or "hand this back to Claude":

1. If the prior session was in the same repository and "latest" is acceptable, try `claude -c -p`.
2. If a specific session ID is known, use `claude -r SESSION_ID -p`.
3. If you need the old context but want a separate branch of reasoning, add `--fork-session`.
4. Restate the new task in the follow-up prompt instead of assuming Claude will infer it from the old thread.

If the workflow depends on resuming a specific session later, capture the session identifier at the time you launch Claude:

- Prefer a structured run:
  ```bash
  claude -p --output-format json --permission-mode plan "Analyze src/session-commands.ts and summarize the risks."
  ```
- Inspect the returned JSON from the installed Claude version and record the session identifier before relying on it in automation.
- Persist that identifier alongside the task you are doing, for example in your own notes, task tracker, or a local workflow file owned by the surrounding project.
- On the next run, pass the stored identifier back with `claude -r SESSION_ID -p "..."`.

Do not claim a fixed JSON schema in this skill. The installed CLI version may evolve; inspect one real response first if you need to automate parsing.

## Typical Uses

- Independent code review from Claude before Codex edits locally.
- Large-scope refactor proposals with a second model's plan.
- Delegating a bounded code edit, then reviewing or integrating the result in Codex.
- Reusing prior Claude session context for longer-running investigations.
