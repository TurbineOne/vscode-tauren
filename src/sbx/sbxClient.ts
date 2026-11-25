import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { CancellationTokenSource, Notifications, Requests, ReviewRequests, type ChangeReviewDecision, type MessageConnection } from '@tauren/shared/sbx/protocol';
import type { AgentClient } from '../agent/clientTypes';
import type { PiClientOptions, PiEvent, PiImageContent, PiOAuthLoginCallbacks, PiPromptStreamingBehavior } from '../pi/types';
import type { PiSettingId, SettingValue } from '../settings/settingsRegistry';
import type { ComposerCompletionApplication, ComposerCompletionRequest } from '@tauren/shared/completion/types';
import { SbxExtensionUiBridge } from '../extensionUi/sbxExtensionUi';
import { createCancellingExtensionUi } from '../extensionUi/types';
import { SandboxLifecycle, type SandboxLifecycleOptions, type SandboxSession } from './lifecycle';
import { bounded } from './process';
import * as validate from './clientValidation';

import { SBX_CREDENTIAL_DOCUMENTATION } from './credentials';
export { SBX_CREDENTIAL_DOCUMENTATION } from './credentials';
export interface SbxClientOptions extends PiClientOptions {
  lifecycle: SandboxLifecycleOptions;
  /** Host displays SBX guidance instead of opening a Pi credential-entry flow.
   * No secret, OAuth callback or token is passed to this callback or to the wire.
   */
  showCredentialDocumentation: (url: string) => PromiseLike<void> | void;
  requestTimeoutMs?: number;
}

/** Pi-compatible AgentClient backed by one concrete sandbox SSH session. Wire
 * events are already enriched by the real SDK server; do not map them a second
 * time. Runtime/session/history remain authoritative in Pi, not host caches.
 */
export class SbxClient implements AgentClient {
  // These listeners receive validated Pi events.
  private readonly events = new Set<(event: PiEvent) => void>();
  // These listeners receive connection and adapter errors.
  private readonly errors = new Set<(message: string) => void>();
  // This holds the active server connection and its cleanup methods.
  private session?: SandboxSession;
  // Concurrent requests await this shared startup promise.
  private opening?: Promise<SandboxSession>;
  // This connects the current server's extension UI to Tauren's UI hosts.
  private bridge?: SbxExtensionUiBridge;
  // These registrations are removed when the connection is released.
  private subscriptions: Array<{ dispose(): void }> = [];
  // This cancels startup and the initial state request during cleanup.
  private controller?: AbortController;
  // Once this is true, the client cannot open another connection.
  private disposed = false;
  // After an unexpected disconnect, this blocks requests until explicit reconnection.
  private disconnected = false;
  // This identifies the current connection attempt so callbacks from older attempts can be ignored.
  private generation = 0;
  // This records the last accepted event number so duplicates and out-of-order events are rejected.
  private sequence = -1;
  // This remembers Pi's persisted session path for reconnection.
  private sessionFile?: string;
  // This caches the server's latest completion capabilities.
  private completionCapabilities = { triggerCharacters: [] as string[], generation: 0 };
  // Cleanup uses these tokens to cancel outstanding requests.
  private readonly pending = new Set<CancellationTokenSource>();
  // Active host-side diff review controllers cancelled on abort or disconnect.
  private readonly pendingReviews = new Set<AbortController>();
  // Latest live toggle pushed by the host, overriding initial `isEnabled()` if set.
  private reviewEnabledOverride?: boolean;

  // These options supply connection settings and host callbacks for this client.
  constructor(private readonly options: SbxClientOptions) {
    this.sessionFile = options.sessionFile;
    if (options.requestTimeoutMs !== undefined && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) {
      throw new Error('Sandbox request timeout must be positive milliseconds');
    }
    if (options.cwd && options.cwd !== options.lifecycle.workspace) throw new Error('Sandbox client cwd must match its configured workspace');
    if (options.resumeLastSession) throw new Error('SBX resume requires an explicit persisted sessionFile');
  }
  onEvent(listener: (event: PiEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
  onError(listener: (message: string) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  isRunning(): boolean { return !this.disposed && !!(this.session || this.opening); }
  isDisconnected(): boolean { return this.disconnected && !this.disposed; }

  /** A failed/disconnected connection is not automatically replayed or reattached.
   * Explicit reconnect restores history via getMessages(), never cached transcript.
   */
  async reconnect(): Promise<void> {
    if (this.disposed) throw new Error('Sandbox client disposed');
    await this.release();
    this.disconnected = false;
    await this.ensureSession();
  }

  private ensureSession(): Promise<SandboxSession> {
    if (this.disposed) return Promise.reject(new Error('Sandbox client disposed'));
    if (this.disconnected) return Promise.reject(new Error('Sandbox disconnected; reconnect explicitly to restore persisted history'));
    if (this.opening) return this.opening;
    if (this.session) return Promise.resolve(this.session);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    let ready = false;
    const lifecycle = new SandboxLifecycle({ ...this.options.lifecycle,
      ...(this.options.changeReview ? { perChangeReviewEnabled: this.isReviewEnabled() } : {}),
      configureConnection: connection => {
        if (this.disposed || generation !== this.generation) throw new Error('Sandbox connection superseded');
        this.installConnection(connection, generation, () => ready);
        this.options.lifecycle.configureConnection?.(connection);
      }
    });
    const work = lifecycle.open(controller.signal, this.sessionFile).then(async session => {
      if (this.disposed || generation !== this.generation) { await session.dispose(); throw new Error('Sandbox connection superseded'); }
      this.session = session;
      if (this.options.changeReview && session.handshake.capabilities.includes(ReviewRequests.change.method)) {
        void session.connection.sendNotification(Notifications.setReviewConfig, { enabled: this.isReviewEnabled() })
          .catch(() => undefined);
      }
      // Resolve the actual persisted path immediately, so an interrupted first
      // turn can subsequently reconnect to this session instead of a new one.
      const state = validate.validateState(await bounded(session.connection.sendRequest(Requests.getState, null),
        this.options.requestTimeoutMs ?? 120_000, controller.signal, 'Sandbox initial state'));
      if (this.disposed || generation !== this.generation) throw new Error('Sandbox connection superseded');
      this.sessionFile = state.sessionFile ?? this.sessionFile;
      ready = true;
      return session;
    }).catch(async error => {
      if (generation === this.generation) {
        this.generation++;
        this.detachUi();
        const session = this.session; this.session = undefined;
        await session?.dispose();
      }
      throw error;
    }).finally(() => { if (this.opening === work) this.opening = undefined; });
    this.opening = work;
    return work;
  }

  /** Handlers exist before initialize, including extension UI during session_start. */
  private installConnection(connection: MessageConnection, generation: number, isReady: () => boolean): void {
    this.detachUi(); this.sequence = -1;
    const active = () => !this.disposed && generation === this.generation;
    this.bridge = new SbxExtensionUiBridge(connection,
      this.options.extensionUi ?? createCancellingExtensionUi(() => undefined), message => this.emitError(message));
    this.subscriptions.push(
      connection.onRequest(ReviewRequests.change, async (params, token): Promise<ChangeReviewDecision> => {
        const request = validate.validateChangeReviewRequest(params);
        if (!active()) return { action: 'cancel', reason: `Cancelled diff review for ${request.path}.` };
        if (!this.options.changeReview || !this.isReviewEnabled()) return { action: 'approve' };
        const reviewController = new AbortController();
        this.pendingReviews.add(reviewController);
        const cancelSubscription = token.onCancellationRequested(() => reviewController.abort());
        if (token.isCancellationRequested) reviewController.abort();
        try {
          return await this.options.changeReview.reviewChange(request, reviewController.signal);
        } finally {
          cancelSubscription.dispose();
          this.pendingReviews.delete(reviewController);
        }
      }),
      connection.onNotification(Notifications.event, value => {
        if (!active()) return;
        try {
          const envelope = validate.validateEventEnvelope(value, this.sequence);
          this.sequence = envelope.sequence;
          for (const listener of this.events) { try { listener(envelope.event); } catch { this.emitError('Sandbox event listener failed'); } }
        } catch { this.emitError('Invalid sandbox event notification'); connection.dispose(); }
      }),
      connection.onNotification(Notifications.diagnostic, value => {
        if (!active()) return;
        if (!value || typeof value.message !== 'string' || !['info', 'warning', 'error'].includes(value.level)) {
          this.emitError('Invalid sandbox diagnostic notification'); return;
        }
        if (value.level === 'error') this.emitError(value.message);
        else this.options.lifecycle.onDiagnostic?.(value.message);
      }),
      connection.onNotification(Notifications.completionCapabilities, value => {
        if (!active()) return;
        try { this.completionCapabilities = validate.validateCompletionCapabilities(value); }
        catch { this.emitError('Invalid sandbox completion capabilities'); }
      }),
      connection.onDispose(() => {
        if (!active() || !isReady()) return;
        this.session = undefined;
        this.detachUi();
        // Fence late callbacks and require explicit reconnect; never replay a
        // failed mutation or silently open a new session for a subsequent prompt.
        this.disconnected = true;
        this.generation++;
        this.emitError('Sandbox disconnected. Reconnect to restore persisted history; interrupted work was not replayed.');
      })
    );
  }

  private async request<T>(method: string, params: unknown, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Sandbox request cancelled');
    const session = await this.ensureSession();
    if (!session.handshake.capabilities.includes(method)) throw new Error(`Sandbox server does not support ${method}`);
    const cancellation = new CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    this.pending.add(cancellation);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await bounded(session.connection.sendRequest(method, params, cancellation.token),
        this.options.requestTimeoutMs ?? 120_000, signal, `Sandbox ${method}`);
      return decode(result);
    } catch (error) {
      cancellation.cancel();
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); this.pending.delete(cancellation); cancellation.dispose(); }
  }
  private async none(method: string, params: unknown = null): Promise<void> {
    await this.request(method, params, value => { if (value !== null) throw new Error('Invalid sandbox acknowledgment'); });
  }
  async prompt(message: string, streamingBehavior?: PiPromptStreamingBehavior, images?: PiImageContent[]): Promise<void> {
    await this.none(Requests.prompt.method, { message, ...(streamingBehavior ? { streamingBehavior } : {}), ...(images?.length ? { images } : {}) });
  }
  abort(): Promise<void> {
    this.cancelPendingReviews();
    return this.none(Requests.abort.method);
  }
  setPerChangeReviewEnabled(enabled: boolean): void {
    this.reviewEnabledOverride = enabled;
    if (this.disposed || this.disconnected || !this.session) return;
    if (!this.session.handshake.capabilities.includes(ReviewRequests.change.method)) return;
    void this.session.connection.sendNotification(Notifications.setReviewConfig, { enabled })
      .catch(() => this.emitError('Failed to update sandbox change review configuration'));
  }
  private isReviewEnabled(): boolean {
    return this.reviewEnabledOverride ?? this.options.changeReview?.isEnabled() ?? false;
  }
  private cancelPendingReviews(): void {
    for (const controller of [...this.pendingReviews]) controller.abort();
    this.pendingReviews.clear();
  }
  reload(): Promise<void> { return this.none(Requests.reload.method); }
  async getState() {
    const state = await this.request(Requests.getState.method, null, validate.validateState);
    this.sessionFile = state.sessionFile ?? this.sessionFile;
    return state;
  }
  getSessionStats() { return this.request(Requests.getSessionStats.method, null, validate.validateStats); }
  getAvailableModels() { return this.request(Requests.getAvailableModels.method, null, validate.validateModels); }
  getCommands() { return this.request(Requests.getCommands.method, null, validate.validateCommands); }
  getStartupResources() { return this.request(Requests.getStartupResources.method, null, validate.validateStartupResources); }
  getAuthProviders() { return this.request(Requests.getAuthProviders.method, null, validate.validateAuthProviders); }
  setModel(provider: string, modelId: string) { return this.request(Requests.setModel.method, { provider, modelId }, validate.validateModel); }
  setThinkingLevel(level: string) { return this.none(Requests.setThinkingLevel.method, { level }); }
  async updateRuntimeSetting(settingId: PiSettingId, value: SettingValue): Promise<{ applied: 'live' | 'reload'; message?: string }> {
    return this.request(Requests.updateSetting.method, { settingId, value }, result => {
      if (!result || typeof result !== 'object' || !('applied' in result) || (result.applied !== 'live' && result.applied !== 'reload')
        || ('message' in result && typeof result.message !== 'string')) throw new Error('Invalid sandbox setting response');
      return { applied: result.applied, ...('message' in result ? { message: result.message as string } : {}) };
    });
  }
  setSessionName(name: string) { return this.none(Requests.setSessionName.method, { name }); }
  compact(customInstructions?: string) { return this.request(Requests.compact.method, { customInstructions }, validate.validateCompact); }
  /** Export HTML is returned over RPC, then written on the host. Never assume a
   * remote export path exists locally (especially under clone-mode workspaces).
   */
  async exportHtml(outputPath?: string) {
    const result = await this.request(Requests.exportHtml.method, {}, validate.validateExport);
    const requested = outputPath?.trim();
    const target = requested
      ? path.resolve(this.options.lifecycle.workspace, requested === '~' ? homedir() : requested.startsWith('~/') ? path.join(homedir(), requested.slice(2)) : requested)
      : path.join(this.options.lifecycle.workspace, path.basename(result.path));
    await writeFile(target, result.html, 'utf8');
    return { path: target };
  }
  getLastAssistantText() { return this.request(Requests.getLastAssistantText.method, null, validate.validateLastAssistantText); }
  getMessages() { return this.request(Requests.getMessages.method, null, validate.validateMessages); }
  private async mutateSession(method: string, params: unknown) {
    const result = await this.request(method, params, validate.validateSessionResult);
    if (!result.cancelled) await this.getState();
    return result;
  }
  switchSession(sessionPath: string) { return this.mutateSession(Requests.switchSession.method, { sessionPath }); }
  importFromJsonl(inputPath: string, cwdOverride?: string) { return this.mutateSession(Requests.importJsonl.method, { inputPath, cwdOverride }); }
  getSessionTree() { return this.request(Requests.getTree.method, null, validate.validateTree); }
  setTreeEntryLabel(entryId: string, label: string | undefined) { return this.none(Requests.setTreeEntryLabel.method, { entryId, label: label ?? null }); }
  navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string }) {
    return this.mutateSession(Requests.navigateTree.method, { entryId, ...options });
  }
  getForkMessages() { return this.request(Requests.getForkMessages.method, null, validate.validateForkMessages); }
  fork(entryId: string) { return this.mutateSession(Requests.fork.method, { entryId }); }
  clone() { return this.mutateSession(Requests.clone.method, null); }
  getComposerCompletions(request: ComposerCompletionRequest, signal: AbortSignal) {
    return this.request(Requests.getCompletions.method, request, validate.validateCompletionResult, signal);
  }
  async getComposerCompletionCapabilities() {
    this.completionCapabilities = await this.request(Requests.getCompletionCapabilities.method, null, validate.validateCompletionCapabilities);
    return this.completionCapabilities;
  }
  applyComposerCompletion(application: ComposerCompletionApplication) {
    return this.request(Requests.applyCompletion.method, application, validate.validateCompletionApplied);
  }
  /** Never invoke wire auth methods or inspect/call OAuth callbacks. */
  private async credentialGuidance(providerId: string) {
    await this.openCredentialDocumentation();
    return { providerId, message: 'Configure credentials on the SBX host; Tauren does not write sandbox credentials.' };
  }
  async openCredentialDocumentation(): Promise<void> {
    await this.options.showCredentialDocumentation(SBX_CREDENTIAL_DOCUMENTATION);
  }
  loginWithApiKey(providerId: string, _apiKey: string) { return this.credentialGuidance(providerId); }
  loginWithOAuth(providerId: string, _callbacks: PiOAuthLoginCallbacks) { return this.credentialGuidance(providerId); }
  logoutAuthProvider(providerId: string) { return this.credentialGuidance(providerId); }

  private emitError(message: string): void { for (const listener of this.errors) { try { listener(message); } catch { /* Observers do not own transport lifetime. */ } } }
  private detachUi(): void {
    this.cancelPendingReviews();
    this.bridge?.dispose(); this.bridge = undefined;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
  private async release(): Promise<void> {
    this.generation++;
    this.controller?.abort(); this.controller = undefined;
    this.detachUi();
    for (const cancellation of this.pending) cancellation.cancel();
    const session = this.session; this.session = undefined;
    const opening = this.opening;
    await session?.dispose();
    try { await opening; } catch { /* Opening owns failed-handshake cleanup. */ }
  }
  /** Awaitable close supports retention policy; it does not remove the sandbox. */
  async closeSession(): Promise<void> {
    this.disposed = true;
    await this.release();
    this.events.clear(); this.errors.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.release().catch(() => this.emitError('Sandbox connection cleanup failed'));
    this.events.clear(); this.errors.clear();
  }
}
