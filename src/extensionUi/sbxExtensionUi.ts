import {
  CancellationTokenSource, ErrorCodes, ResponseError, UiRequests, Notifications,
  type MessageConnection, type CancellationToken, type Disposable, type NotificationType,
  type RequestType, type RenderResult, type RenderParams
} from '@tauren/shared/sbx/protocol';
import { renderContentProvider, type ExtensionRenderContent, type ExtensionCellDimensions } from '@tauren/shared/rendering/renderContent';
import type { ExtensionUi } from './types';

type Tui = { terminal: { columns: number; rows: number; widthPx: number; heightPx: number }; requestRender(): void };
function invalid(): never { throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid sandbox extension UI parameters'); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function strings(value: unknown): string[] { if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) invalid(); return value; }
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value); }
function positive(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid(); return value; }
function renderResult(value: unknown): ExtensionRenderContent {
  const p = record(value, ['lines', 'blocks', 'cursor']);
  const lines = strings(p.lines);
  if (p.cursor !== undefined) {
    const cursor = record(p.cursor, ['row', 'column']);
    for (const n of [cursor.row, cursor.column]) if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) invalid();
  }
  if (p.blocks === undefined) return { lines, blocks: lines.length ? [{ type: 'text', lines }] : [] };
  if (!Array.isArray(p.blocks)) invalid();
  const blocks = p.blocks.map(value => {
    const block = record(value, ['type', 'lines', 'data', 'mimeType', 'columns', 'rows', 'widthPx', 'heightPx', 'cellWidthPx', 'cellHeightPx', 'alt', 'indentColumns']);
    if (block.type === 'text') { record(block, ['type', 'lines']); return { type: 'text' as const, lines: strings(block.lines) }; }
    if (block.type !== 'image') invalid();
    record(block, ['type', 'data', 'mimeType', 'columns', 'rows', 'widthPx', 'heightPx', 'cellWidthPx', 'cellHeightPx', 'alt', 'indentColumns']);
    text(block.data);
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(text(block.mimeType).toLowerCase())) invalid();
    positive(block.columns); positive(block.rows);
    for (const key of ['widthPx', 'heightPx', 'cellWidthPx', 'cellHeightPx']) if (block[key] !== undefined) positive(block[key]);
    if (block.alt !== undefined) text(block.alt);
    if (block.indentColumns !== undefined && (typeof block.indentColumns !== 'number' || !Number.isInteger(block.indentColumns) || block.indentColumns < 0)) invalid();
    return block as ExtensionRenderContent['blocks'][number];
  });
  return { lines, blocks };
}

/** SDK components stay beside Pi. This local component only caches validated
 * render DTOs; synchronous host rendering never returns a Promise. The shared
 * extraction hook preserves image blocks through the existing UI hosts.
 */
class RemoteSurface {
  private cached: ExtensionRenderContent = { lines: [], blocks: [] };
  private layout?: RenderParams;
  private dirty = true;
  private rendering = false;
  private closed = false;
  private focus = false;
  readonly wantsKeyRelease = true;
  constructor(readonly id: string, private readonly tui: Tui, private readonly bridge: SbxExtensionUiBridge, private readonly custom: boolean) {}
  get focused(): boolean { return this.focus; }
  set focused(value: boolean) {
    this.focus = value;
    if (!this.closed) void this.bridge.request(UiRequests.setSurfaceState, { surfaceId: this.id, attached: this.custom ? value : true, focused: value });
  }
  render(width: number): string[] { return this[renderContentProvider](width).lines; }
  [renderContentProvider](width: number, cells?: ExtensionCellDimensions): ExtensionRenderContent {
    if (this.closed) return { lines: [], blocks: [] };
    const t = this.tui.terminal;
    const layout = { surfaceId: this.id, width, height: t.rows, cellWidth: cells?.widthPx ?? t.widthPx, cellHeight: cells?.heightPx ?? t.heightPx };
    if (JSON.stringify(layout) !== JSON.stringify(this.layout)) { this.layout = layout; this.dirty = true; }
    this.fetch();
    return this.cached;
  }
  invalidate(): void { if (!this.closed) { this.dirty = true; this.tui.requestRender(); this.fetch(); } }
  handleInput(input: string): void { if (!this.closed) void this.bridge.request(UiRequests.surfaceInput, { surfaceId: this.id, input }); }
  private fetch(): void {
    if (this.closed || this.rendering || !this.dirty || !this.layout) return;
    this.dirty = false; this.rendering = true;
    const layout = this.layout;
    void this.bridge.request(UiRequests.render, layout).then((value: RenderResult | undefined) => {
      if (this.closed || value === undefined) return;
      try {
        const content = renderResult(value);
        if (layout === this.layout) { this.cached = content; this.tui.requestRender(); }
      } catch { this.bridge.report('Invalid sandbox extension UI render response'); }
    }).finally(() => { this.rendering = false; if (this.dirty) this.fetch(); });
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge.forget(this);
    void this.bridge.request(UiRequests.dispose, { surfaceId: this.id });
  }
}

/** One connection's reverse UI bridge. No executable SDK values cross RPC and
 * no new webview protocol is introduced. dispose cancels dialogs, hides custom
 * UI and releases widget/footer proxies before unregistering wire handlers.
 */
export class SbxExtensionUiBridge {
  private readonly registrations: Disposable[] = [];
  private readonly pending = new Set<AbortController>();
  private readonly requests = new Set<() => void>();
  private readonly surfaces = new Map<string, RemoteSurface>();
  private readonly widgets = new Set<string>();
  private readonly statuses = new Set<string>();
  private footer = false;
  private terminalDispose?: () => void;
  private disposed = false;
  constructor(private readonly connection: MessageConnection, private readonly ui: ExtensionUi, private readonly onError: (message: string) => void,
    private readonly requestTimeoutMs = 30_000) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('Sandbox UI request timeout must be positive milliseconds');
    this.registrations.push(
      connection.onRequest(UiRequests.select, (value, token) => {
        const p = this.dialogParams(value, ['title', 'options', 'timeoutMs']); const options = strings(p.options);
        return this.dialog(token, p.timeoutMs, signal => ui.select(text(p.title), options, { signal, timeout: p.timeoutMs as number | undefined }), value => typeof value === 'string' && options.includes(value) ? value : null);
      }),
      connection.onRequest(UiRequests.confirm, (value, token) => {
        const p = this.dialogParams(value, ['title', 'message', 'timeoutMs']); const message = optionalText(p.message);
        return this.dialog(token, p.timeoutMs, signal => ui.confirm(text(p.title), message, { signal, timeout: p.timeoutMs as number | undefined }), value => typeof value === 'boolean' ? value : null);
      }),
      connection.onRequest(UiRequests.input, (value, token) => {
        const p = this.dialogParams(value, ['title', 'placeholder', 'timeoutMs']); const placeholder = optionalText(p.placeholder);
        return this.dialog(token, p.timeoutMs, signal => ui.input(text(p.title), placeholder, { signal, timeout: p.timeoutMs as number | undefined }), value => typeof value === 'string' ? value : null);
      }),
      connection.onRequest(UiRequests.editor, (value, token) => {
        const p = record(value, ['title', 'prefill']); const title = text(p.title), prefill = optionalText(p.prefill);
        return this.dialog(token, undefined, signal => ui.editor?.(title, prefill, { signal }), value => typeof value === 'string' ? value : null);
      }),
      connection.onRequest(UiRequests.custom, (value, token) => {
        const p = record(value, ['surfaceId', 'options']); const id = text(p.surfaceId), opts = record(p.options, ['overlay']);
        if (opts.overlay !== undefined) bool(opts.overlay);
        return this.dialog(token, undefined, signal => {
          if (!ui.custom) return undefined;
          return ui.custom((tui, _theme, _keys, done) => {
            const proxy = this.surface(id, tui as unknown as Tui, true);
            if (signal.aborted) { proxy.dispose(); done(undefined); }
            return proxy;
          }, { overlay: opts.overlay === true, onHandle: handle => {
            const cancel = () => handle.hide();
            if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
          } });
        }, () => null);
      }),
      connection.onClose(() => this.dispose()), connection.onDispose(() => this.dispose())
    );
    this.notification(Notifications.notify, value => { const p = record(value, ['message', 'notifyType']); ui.notify(text(p.message), text(p.notifyType)); });
    this.notification(Notifications.status, value => {
      const p = record(value, ['key', 'text']); const key = text(p.key), status = p.text === null ? undefined : text(p.text);
      if (status === undefined) this.statuses.delete(key); else this.statuses.add(key);
      ui.setStatus?.(key, status);
    });
    this.notification(Notifications.clearStatuses, value => { if (value !== null) invalid(); this.statuses.clear(); ui.clearStatuses?.(); });
    this.notification(Notifications.widget, value => {
      const p = record(value, ['key', 'placement', 'content']); const key = text(p.key);
      if (!key.trim() || !['aboveEditor', 'belowEditor'].includes(text(p.placement))) invalid();
      const options = { placement: p.placement as 'aboveEditor' | 'belowEditor' };
      if (p.content === null) { this.widgets.delete(key); ui.setWidget?.(key, undefined, options); }
      else if (Array.isArray(p.content)) { const lines = strings(p.content); this.widgets.add(key); ui.setWidget?.(key, lines, options); }
      else { const id = text(record(p.content, ['surfaceId']).surfaceId); this.widgets.add(key); ui.setWidget?.(key, tui => this.surface(id, tui as unknown as Tui, false), options); }
    });
    this.notification(Notifications.clearWidgets, value => { if (value !== null) invalid(); this.widgets.clear(); ui.clearWidgets?.(); });
    this.notification(Notifications.footer, value => {
      const p = record(value, ['surfaceId']); const id = p.surfaceId === null ? undefined : text(p.surfaceId);
      this.footer = id !== undefined;
      ui.setFooter?.(id === undefined ? undefined : tui => this.surface(id, tui as unknown as Tui, false));
    });
    this.notification(Notifications.invalidate, value => { const p = record(value, ['surfaceId']); this.surfaces.get(text(p.surfaceId))?.invalidate(); });
    this.notification(Notifications.setEditorText, value => { const p = record(value, ['text']); ui.setEditorText?.(text(p.text)); });
    this.notification(Notifications.pasteToEditor, value => { const p = record(value, ['text']); ui.pasteToEditor?.(text(p.text)); });
    this.notification(Notifications.setToolsExpanded, value => { const p = record(value, ['expanded']); ui.setToolsExpanded?.(bool(p.expanded)); this.sendExpanded(); });
    this.notification(Notifications.terminalInputSubscription, value => {
      const p = record(value, ['enabled']); const enabled = bool(p.enabled);
      this.terminalDispose?.(); this.terminalDispose = undefined;
      if (!enabled) return;
      // The synchronous SDK interceptor cannot return an RPC Promise. Hosts must
      // opt into ordered async interception before this capability is installed.
      if (!ui.onTerminalInputAsync) { this.report('Sandbox terminal input requires an asynchronous host interceptor'); return; }
      this.terminalDispose = ui.onTerminalInputAsync(async input => {
        this.sendExpanded();
        const value = await this.request(UiRequests.terminalInput, { input });
        if (value === undefined) return undefined;
        try {
          const p = record(value, ['consume', 'input']); const consume = bool(p.consume), data = optionalText(p.input);
          return consume ? { consume: true } : data === undefined ? undefined : { data };
        } catch { this.report('Invalid sandbox terminal input response'); return undefined; }
      });
    });
    this.sendExpanded();
  }
  report(message: string): void { try { this.onError(message); } catch { /* Diagnostics never interrupt cleanup. */ } }
  async request<P, R>(method: RequestType<P, R, void>, params: P): Promise<R | undefined> {
    if (this.disposed) return undefined;
    this.sendExpanded();
    const source = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const cancelled = new Promise<undefined>(resolve => {
      cancel = () => { source.cancel(); resolve(undefined); };
    });
    this.requests.add(cancel);
    timer = setTimeout(() => { this.report('Sandbox extension UI request timed out'); cancel(); }, Math.min(this.requestTimeoutMs, 2_147_483_647));
    try { return await Promise.race([this.connection.sendRequest(method, params, source.token), cancelled]); }
    catch { if (!this.disposed) this.report('Sandbox extension UI request failed'); return undefined; }
    finally { clearTimeout(timer); this.requests.delete(cancel); source.dispose(); }
  }
  forget(surface: RemoteSurface): void { if (this.surfaces.get(surface.id) === surface) this.surfaces.delete(surface.id); }
  private surface(id: string, tui: Tui, custom: boolean): RemoteSurface {
    const proxy = new RemoteSurface(id, tui, this, custom);
    if (this.disposed) { proxy.dispose(); return proxy; }
    this.surfaces.get(id)?.dispose(); this.surfaces.set(id, proxy); return proxy;
  }
  private notification<P>(method: NotificationType<P>, handler: (value: unknown) => void): void {
    this.registrations.push(this.connection.onNotification(method, value => {
      if (this.disposed) return;
      try { handler(value); } catch { this.report('Invalid sandbox extension UI notification'); }
    }));
  }
  private sendExpanded(): void {
    if (this.disposed || !this.ui.getToolsExpanded) return;
    try { void this.connection.sendNotification(Notifications.toolsExpanded, { expanded: this.ui.getToolsExpanded() }).catch(() => this.report('Sandbox tools expansion notification failed')); }
    catch { this.report('Sandbox tools expansion notification failed'); }
  }
  private dialogParams(value: unknown, keys: string[]): Record<string, unknown> {
    const p = record(value, keys); text(p.title);
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || !Number.isFinite(p.timeoutMs) || p.timeoutMs < 0)) invalid();
    return p;
  }
  private async dialog<T, R>(token: CancellationToken, timeout: unknown, invoke: (signal: AbortSignal) => T | PromiseLike<T>, decode: (value: T) => R): Promise<R | null> {
    if (this.disposed || token.isCancellationRequested) return null;
    const controller = new AbortController(); this.pending.add(controller);
    const subscription = token.onCancellationRequested(() => controller.abort());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const cancelled = new Promise<null>(resolve => { aborted = () => resolve(null); controller.signal.addEventListener('abort', aborted, { once: true }); });
      if (typeof timeout === 'number') timer = setTimeout(() => controller.abort(), Math.min(timeout, 2_147_483_647));
      if (token.isCancellationRequested || this.disposed) controller.abort();
      if (controller.signal.aborted) return null;
      return await Promise.race([Promise.resolve(invoke(controller.signal)).then(decode), cancelled]);
    } catch { this.report('Sandbox extension UI host interaction failed'); return null; }
    finally {
      clearTimeout(timer); subscription.dispose(); this.pending.delete(controller);
      if (aborted) controller.signal.removeEventListener('abort', aborted);
      // Close custom surfaces even when a host returns without disposing them.
      controller.abort();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    for (const pending of [...this.pending]) pending.abort();
    try { this.terminalDispose?.(); } catch { this.report('Sandbox terminal input cleanup failed'); }
    this.terminalDispose = undefined;
    for (const surface of [...this.surfaces.values()]) surface.dispose();
    for (const key of this.statuses) { try { this.ui.setStatus?.(key, undefined); } catch { this.report('Sandbox status cleanup failed'); } }
    this.statuses.clear();
    for (const key of this.widgets) { try { this.ui.setWidget?.(key, undefined); } catch { this.report('Sandbox widget cleanup failed'); } }
    this.widgets.clear();
    if (this.footer) { try { this.ui.setFooter?.(undefined); } catch { this.report('Sandbox footer cleanup failed'); } }
    this.footer = false;
    this.disposed = true;
    for (const cancel of [...this.requests]) cancel();
    for (const registration of this.registrations.splice(0)) registration.dispose();
  }
}
