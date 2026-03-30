import fs from 'fs';
import path from 'path';

import {
  CHIEF_HEARTBEAT_STALE_MS,
  CHIEF_MONITOR_POLL_MS,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ChiefMonitorDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface TaskInFlight {
  taskId: string;
  userRequest?: string;
  phaseStatus?: string;
  timeoutAt?: string;
}

interface TasksInFlight {
  activeTasks?: TaskInFlight[];
}

function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, group };
  }
  return null;
}

function getLastHeartbeatMs(folder: string): number | null {
  const file = path.join(GROUPS_DIR, folder, 'heartbeat.jsonl');
  if (!fs.existsSync(file)) return null;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function getTimedOutTasks(folder: string): TaskInFlight[] {
  const file = path.join(GROUPS_DIR, folder, 'tasks-in-flight.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data: TasksInFlight = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const now = Date.now();
    return (data.activeTasks ?? []).filter(
      (t) =>
        t.timeoutAt &&
        new Date(t.timeoutAt).getTime() < now &&
        t.phaseStatus === 'running',
    );
  } catch {
    return [];
  }
}

let monitorRunning = false;

export function startChiefMonitor(deps: ChiefMonitorDeps): void {
  if (monitorRunning) return;
  monitorRunning = true;

  const poll = async () => {
    try {
      const entry = findMainGroup(deps.registeredGroups());
      if (!entry) {
        setTimeout(poll, CHIEF_MONITOR_POLL_MS);
        return;
      }
      const { jid, group } = entry;

      // Heartbeat check
      const lastBeat = getLastHeartbeatMs(group.folder);
      if (lastBeat !== null) {
        const staleMs = Date.now() - lastBeat;
        if (staleMs > CHIEF_HEARTBEAT_STALE_MS) {
          logger.warn(
            { folder: group.folder, staleMs },
            'Chief heartbeat stale — sending recovery message',
          );
          await deps.sendMessage(
            jid,
            `[HOST MONITOR] Chief heartbeat is stale (${Math.round(staleMs / 60000)} min). ` +
              `Check tasks-in-flight.json for stuck phases and resume or escalate to user.`,
          );
        }
      }

      // Task timeout check
      const timedOut = getTimedOutTasks(group.folder);
      for (const task of timedOut) {
        logger.warn({ taskId: task.taskId }, 'Chief task phase timed out');
        await deps.sendMessage(
          jid,
          `[HOST MONITOR] Task phase timeout for "${task.taskId}" ` +
            `(${(task.userRequest ?? '').slice(0, 80)}). ` +
            `Restart the stuck phase or escalate to user.`,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Chief monitor error');
    }

    setTimeout(poll, CHIEF_MONITOR_POLL_MS);
  };

  poll();
  logger.info('Chief monitor started');
}
