import type { createEditToolDefinition } from '@earendil-works/pi-coding-agent';

export type ChangeReviewToolName = 'edit' | 'write' | 'hashline_edit';

export type EditToolDefinitionFactory = typeof createEditToolDefinition;

export interface ChangeReviewPreviewOptions {
  createEditToolDefinition: EditToolDefinitionFactory;
}

export interface ChangeReviewPreview {
  toolName: ChangeReviewToolName;
  /** Display path normalized with forward slashes (workspace-relative when inside cwd). */
  path: string;
  absolutePath: string;
  beforeText: string;
  afterText: string;
  isNewFile: boolean;
}

export interface ChangeReviewRequest extends ChangeReviewPreview {
  toolCallId: string;
}

export type ChangeReviewDecision =
  | { action: 'approve' }
  | { action: 'approve_session' }
  | { action: 'reject'; reason?: string }
  | { action: 'steer'; feedback: string }
  | { action: 'cancel'; reason?: string };

export interface ChangeReviewConfig {
  enabled: boolean;
}

export type ChangeReviewHandler = (
  request: ChangeReviewRequest,
  signal: AbortSignal
) => Promise<ChangeReviewDecision>;

export interface PerChangeReviewExtensionOptions {
  isEnabled: () => boolean;
  reviewChange: ChangeReviewHandler;
  createEditToolDefinition: EditToolDefinitionFactory;
  getAbortSignal?: () => AbortSignal | undefined;
  onSessionAutoApproveChange?: (autoApprove: boolean) => void;
}
