import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangeReviewRequest } from '@tauren/shared/review/types';
import type { ChangeReviewHost, OpenedChangeReviewDiff } from './changeReviewController';
import { changeReviewScheme, getChangeReviewIdFromUri } from './changeReviewUri';

export { changeReviewScheme, getChangeReviewIdFromUri };

/**
 * Serves virtual before-and-after documents for per-change diff review under
 * the `tauren-review:` URI scheme and opens or closes native VS Code diff tabs.
 */
export class ChangeReviewViewer implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  public constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(changeReviewScheme, this);
  }

  public dispose(): void {
    this.registration.dispose();
    this.documents.clear();
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }

  public async openDiff(reviewId: string, request: ChangeReviewRequest): Promise<OpenedChangeReviewDiff> {
    const normalizedPath = normalizeReviewPath(request.path || request.absolutePath);
    const beforeUri = vscode.Uri.from({
      scheme: changeReviewScheme,
      authority: 'before',
      path: `/${reviewId}/${normalizedPath}`
    });
    const afterUri = vscode.Uri.from({
      scheme: changeReviewScheme,
      authority: 'after',
      path: `/${reviewId}/${normalizedPath}`
    });

    this.documents.set(beforeUri.toString(), request.beforeText);
    this.documents.set(afterUri.toString(), request.afterText);

    const actionLabel = request.isNewFile ? 'new file' : request.toolName;
    const title = `Tauren Review (${actionLabel}): ${request.path}`;

    try {
      await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, {
        preview: false
      });
    } catch (error) {
      this.deleteReviewContent(beforeUri, afterUri);
      throw error;
    }

    return { beforeUri, afterUri };
  }

  public async closeDiff(beforeUri: vscode.Uri, afterUri: vscode.Uri): Promise<void> {
    const beforeKey = beforeUri.toString();
    const afterKey = afterUri.toString();
    const matchingTabs: vscode.Tab[] = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          if (tab.input.original.toString() === beforeKey && tab.input.modified.toString() === afterKey) {
            matchingTabs.push(tab);
          }
        }
      }
    }

    if (matchingTabs.length > 0) {
      await vscode.window.tabGroups.close(matchingTabs, true);
    }

    this.deleteReviewContent(beforeUri, afterUri);
  }

  public deleteReviewContent(beforeUri: vscode.Uri, afterUri: vscode.Uri): void {
    this.documents.delete(beforeUri.toString());
    this.documents.delete(afterUri.toString());
  }
}

export function createVscodeChangeReviewHost(
  viewer: ChangeReviewViewer = new ChangeReviewViewer(),
  onBackgroundReview?: (sessionId: string, request: ChangeReviewRequest) => void
): ChangeReviewHost {
  return {
    openDiff: (reviewId, request) => viewer.openDiff(reviewId, request),
    closeDiff: (beforeUri, afterUri) => viewer.closeDiff(beforeUri as vscode.Uri, afterUri as vscode.Uri),
    deleteReviewContent: (beforeUri, afterUri) => viewer.deleteReviewContent(beforeUri as vscode.Uri, afterUri as vscode.Uri),
    onDidCloseDiffTab: (listener) =>
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const tab of event.closed) {
          if (tab.input instanceof vscode.TabInputTextDiff) {
            const reviewId = getChangeReviewIdFromUri(tab.input.modified)
              ?? getChangeReviewIdFromUri(tab.input.original);
            if (reviewId) {
              listener(reviewId);
            }
          }
        }
      }),
    promptSteerFeedback: async (request) =>
      vscode.window.showInputBox({
        title: `Steer change to ${request.path}`,
        prompt: 'Describe how Tauren should revise this change',
        placeHolder: 'Enter instructions for the model',
        ignoreFocusOut: true
      }),
    getActiveReviewId: () => {
      const activeInput = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
      if (activeInput instanceof vscode.TabInputTextDiff) {
        return getChangeReviewIdFromUri(activeInput.modified)
          ?? getChangeReviewIdFromUri(activeInput.original);
      }
      return undefined;
    },
    notifyBackgroundReview: onBackgroundReview,
    dispose: () => viewer.dispose()
  };
}

function normalizeReviewPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized || path.basename(filePath) || 'file.txt';
}
