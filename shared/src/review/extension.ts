import type { ExtensionAPI, ExtensionFactory, ToolCallEventResult } from '@earendil-works/pi-coding-agent';
import { computeChangeReviewPreview, isReviewableToolName } from './preview.js';
import type { ChangeReviewRequest, PerChangeReviewExtensionOptions } from './types.js';

/**
 * Create a transport-independent Pi inline extension that gates file-modifying
 * tool calls through a host-supplied ChangeReviewHandler before disk writes occur.
 */
export function createPerChangeReviewExtension(options: PerChangeReviewExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let sessionAutoApprove = false;

    const setSessionAutoApprove = (value: boolean) => {
      if (sessionAutoApprove === value) {
        return;
      }
      sessionAutoApprove = value;
      options.onSessionAutoApproveChange?.(value);
    };

    pi.on('session_start', () => {
      setSessionAutoApprove(false);
    });

    pi.on('tool_call', async (event, ctx): Promise<ToolCallEventResult | undefined> => {
      if (!isReviewableToolName(event.toolName)) {
        return undefined;
      }

      if (!options.isEnabled() || sessionAutoApprove) {
        return undefined;
      }

      const externalSignal = options.getAbortSignal?.();
      if (externalSignal?.aborted) {
        return {
          block: true,
          reason: `Cancelled diff review for ${getFallbackPath(event.input)}.`
        };
      }

      const preview = await computeChangeReviewPreview(event.toolName, event.input, ctx.cwd, {
        createEditToolDefinition: options.createEditToolDefinition
      });
      if (!preview) {
        return undefined;
      }

      const request: ChangeReviewRequest = {
        toolCallId: event.toolCallId,
        ...preview
      };

      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();

      if (externalSignal) {
        if (externalSignal.aborted) {
          return {
            block: true,
            reason: `Cancelled diff review for ${request.path}.`
          };
        }
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      try {
        const decision = await options.reviewChange(request, controller.signal);

        if (controller.signal.aborted || decision.action === 'cancel') {
          const reason = decision.action === 'cancel' && decision.reason?.trim()
            ? decision.reason.trim()
            : `Cancelled diff review for ${request.path}.`;
          return { block: true, reason };
        }

        if (decision.action === 'approve') {
          return undefined;
        }

        if (decision.action === 'approve_session') {
          setSessionAutoApprove(true);
          return undefined;
        }

        if (decision.action === 'reject') {
          const reason = decision.reason?.trim()
            || `Rejected by user after diff review for ${request.path}.`;
          return { block: true, reason };
        }

        const feedback = decision.feedback.trim();
        if (feedback) {
          sendSteerFeedback(pi, request, feedback);
        }

        return {
          block: true,
          reason: feedback
            ? `Rejected by user after diff review for ${request.path}. Feedback: ${feedback}`
            : `Rejected by user after diff review for ${request.path}.`
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            block: true,
            reason: `Cancelled diff review for ${request.path}.`
          };
        }

        const message = error instanceof Error ? error.message : String(error);
        return {
          block: true,
          reason: `Diff review failed for ${request.path}: ${message}`
        };
      } finally {
        externalSignal?.removeEventListener('abort', onExternalAbort);
      }
    });
  };
}

function sendSteerFeedback(pi: ExtensionAPI, request: ChangeReviewRequest, feedback: string): void {
  try {
    const result = pi.sendUserMessage(
      [
        `I rejected the proposed ${request.toolName} change to ${request.path}.`,
        `Please revise it like this:\n${feedback}`,
        'Do not retry the same file change unchanged.'
      ].join('\n\n'),
      { deliverAs: 'steer' }
    );
    void Promise.resolve(result).catch(() => {
      // Best-effort; the tool block reason still conveys the feedback to the model.
    });
  } catch {
    // Best-effort; the tool block reason still conveys the feedback to the model.
  }
}

function getFallbackPath(input: unknown): string {
  if (input && typeof input === 'object' && 'path' in input && typeof (input as { path?: unknown }).path === 'string') {
    return (input as { path: string }).path;
  }
  return 'file';
}
