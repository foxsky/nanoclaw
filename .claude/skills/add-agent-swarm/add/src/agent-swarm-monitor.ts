import {
  checkAgents,
  readTaskRegistry,
  AgentStatus,
  SwarmTask,
} from './agent-swarm.js';

export interface MonitorAction {
  taskId: string;
  action:
    | 'notify_ready'
    | 'notify_failed'
    | 'respawn'
    | 'trigger_review'
    | 'respawn_with_ci_fix'
    | 'respawn_with_review_fix';
  pr?: number | null;
  reason?: string;
}

export async function evaluateAgents(
  sshTarget: string,
): Promise<MonitorAction[]> {
  // This function is intentionally pure: it evaluates current state and
  // returns suggested actions. The caller is responsible for executing actions
  // and persisting lifecycle transitions via update_task_status.
  const registry = await readTaskRegistry(sshTarget);
  const statuses = await checkAgents(sshTarget);

  const statusMap = new Map<string, AgentStatus>();
  for (const s of statuses) {
    statusMap.set(s.id, s);
  }

  const actions: MonitorAction[] = [];

  for (const task of registry.tasks) {
    if (task.status === 'merged' || task.status === 'failed') continue;
    if (task.status === 'ready_for_review') continue;

    const status = statusMap.get(task.id);
    if (!status) continue;

    // Agent died without creating a PR
    if (!status.tmux_alive && !status.pr_number) {
      if (task.retries < task.maxRetries) {
        actions.push({
          taskId: task.id,
          action: 'respawn',
          reason: 'Agent exited without creating PR',
        });
      } else {
        actions.push({
          taskId: task.id,
          action: 'notify_failed',
          reason: `Agent failed after ${task.retries} retries`,
        });
      }
      continue;
    }

    // Agent died but PR exists — trigger review
    if (!status.tmux_alive && status.pr_number && task.status === 'running') {
      actions.push({
        taskId: task.id,
        action: 'trigger_review',
        pr: status.pr_number,
      });
      continue;
    }

    // Agent still running — let it work; don't evaluate PR status yet
    if (status.tmux_alive) continue;

    // PR exists — check CI and reviews (agent has exited)
    if (status.pr_number) {
      // CI failing — respawn with fix
      if (status.ci_status === 'failing') {
        if (task.retries < task.maxRetries) {
          actions.push({
            taskId: task.id,
            action: 'respawn_with_ci_fix',
            pr: status.pr_number,
            reason: 'CI failing',
          });
        } else {
          actions.push({
            taskId: task.id,
            action: 'notify_failed',
            pr: status.pr_number,
            reason: `CI failing after ${task.retries} retries`,
          });
        }
        continue;
      }

      // Critical review comments — respawn with review feedback
      if (status.critical_comments > 0) {
        if (task.retries < task.maxRetries) {
          actions.push({
            taskId: task.id,
            action: 'respawn_with_review_fix',
            pr: status.pr_number,
            reason: `${status.critical_comments} critical review comments`,
          });
        }
        continue;
      }

      // CI passing + no critical comments → ready for human review.
      // Accepts review_status 'pending' because Gemini Code Assist (GitHub App)
      // doesn't set reviewDecision, and we want to notify the human early so they
      // can look while automated reviews may still be running.
      if (
        status.ci_status === 'passing' &&
        (status.review_status === 'approved' || status.review_status === 'pending') &&
        status.critical_comments === 0
      ) {
        actions.push({
          taskId: task.id,
          action: 'notify_ready',
          pr: status.pr_number,
        });
        continue;
      }
    }
  }

  return actions;
}
