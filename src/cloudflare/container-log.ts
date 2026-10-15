/**
 * Cloudflare Container ライフサイクルログ用の純粋関数。
 * cloudflare:workers / @cloudflare/containers に依存しない（PRJ-3-1662）。
 */

// Library wording uses `...exit: N`. Historical Worker wording used
// `...exit due to a new version rollout: 0` (no colon after exit). Match the
// shared prefix so both are treated as rollouts.
const ROLLOUT_EXIT_MARKER = 'runtime signalled the container to exit';

export const isRolloutExit = (message: string): boolean =>
  message.toLowerCase().includes(ROLLOUT_EXIT_MARKER);

export const truncateForLog = (value: string, max = 200): string => {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
};

export type ContainerErrorLog = {
  event: 'container_error';
  errorName: string;
  message: string;
};

export const buildContainerErrorLog = (error: unknown): ContainerErrorLog => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    event: 'container_error',
    errorName,
    message: truncateForLog(rawMessage),
  };
};

/**
 * Abnormal stop for error-level logging.
 * `@cloudflare/containers@0.3.7` calls onStop for sleepAfter with
 * `{ exitCode: 0, reason: 'exit' }` (see dist/lib/container.js syncPendingStoppedEvents),
 * so idle stops stay on console.log.
 */
export const isAbnormalContainerStop = (
  exitCode: number,
  reason: string,
): boolean => exitCode !== 0 || reason !== 'exit';
