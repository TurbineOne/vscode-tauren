import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  createProtocolConnection, CancellationTokenSource, UiRequests, Notifications,
  ErrorCodes, type RenderParams, type RenderResult
} from '@tauren/shared/sbx/protocol';
import { renderComponentContent } from '@tauren/shared/rendering/renderContent';
import { SbxExtensionUiBridge } from '../../extensionUi/sbxExtensionUi';
import type { ExtensionUi, ExtensionWidgetContent } from '../../extensionUi/types';
import { createTuiFacade, type CustomUiComponent } from '../../extensionUi/customUiHost';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('UI test timed out')), 3000); })]); }
  finally { clearTimeout(timer); }
}
function fixture(overrides: Partial<ExtensionUi> = {}, requestTimeoutMs?: number) {
  const a = new PassThrough(), b = new PassThrough();
  const host = createProtocolConnection(a, b), server = createProtocolConnection(b, a);
  const errors: string[] = [];
  const ui: ExtensionUi = { notify() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined, ...overrides };
  const bridge = new SbxExtensionUiBridge(host, ui, message => errors.push(message), requestTimeoutMs);
  // A round trip is a FIFO barrier for preceding notifications.
  host.onRequest('fixture.barrier', () => null);
  const flush = () => server.sendRequest('fixture.barrier');
  host.listen(); server.listen();
  return { host, server, bridge, errors, flush, close() { bridge.dispose(); host.dispose(); server.dispose(); a.destroy(); b.destroy(); } };
}
const terminal = () => ({ columns: 80, rows: 4, widthPx: 9, heightPx: 18 });

suite('SBX extension UI bridge', () => {
  test('reverse dialogs preserve values and reject malformed payloads before invoking UI', async () => {
    const calls: unknown[] = [];
    const f = fixture({
      select: (title, options) => { calls.push([title, options]); return options[1]; },
      confirm: (_title, message) => message === 'confirm',
      input: (_title, placeholder) => placeholder,
      editor: (_title, prefill) => prefill
    });
    try {
      assert.equal(await f.server.sendRequest(UiRequests.select, { title: 'Pick', options: ['a', 'b'] }), 'b');
      assert.equal(await f.server.sendRequest(UiRequests.confirm, { title: 'Question', message: 'confirm' }), true);
      assert.equal(await f.server.sendRequest(UiRequests.input, { title: 'Text', placeholder: '  value  ' }), '  value  ');
      assert.equal(await f.server.sendRequest(UiRequests.editor, { title: 'Edit', prefill: 'x\ny' }), 'x\ny');
      await assert.rejects(f.server.sendRequest('ui.select', { title: 'Bad', options: [1] }), (error: { code: number }) => error.code === ErrorCodes.InvalidParams);
      await assert.rejects(f.server.sendRequest('ui.input', { title: 'Bad', timeoutMs: -1 }));
      await assert.rejects(f.server.sendRequest('ui.confirm', { title: 'Bad', extra: true }));
      assert.equal(calls.length, 1);
    } finally { f.close(); }
  });

  for (const method of ['select', 'confirm', 'input', 'editor'] as const) {
    test(`${method} RPC cancellation aborts host interaction and settles without waiting for host`, async () => {
      const entered = deferred<AbortSignal>();
      const pending = () => new Promise<never>(() => {});
      const f = fixture({ [method]: (_title: string, _arg: unknown, opts?: { signal?: AbortSignal }) => {
        entered.resolve(opts!.signal!); return pending();
      } });
      const source = new CancellationTokenSource();
      try {
        const params = method === 'select' ? { title: 'Pending', options: ['a'] } : { title: 'Pending' };
        const work = f.server.sendRequest(`ui.${method}`, params, source.token);
        const signal = await bounded(entered.promise);
        const aborted = deferred<void>(); signal.addEventListener('abort', () => aborted.resolve());
        source.cancel();
        await bounded(aborted.promise);
        assert.equal(await bounded(work), null);
      } finally { source.dispose(); f.close(); }
    });
  }

  test('timeout and disconnect abort pending host dialogs', async () => {
    const entered = deferred<AbortSignal>();
    const f = fixture({ input: (_title, _placeholder, opts) => { entered.resolve(opts!.signal!); return new Promise(() => {}); } });
    try {
      const work = f.server.sendRequest(UiRequests.input, { title: 'Pending', timeoutMs: 10 });
      const signal = await bounded(entered.promise);
      assert.equal(await bounded(work), null); assert.equal(signal.aborted, true);
      const again = deferred<AbortSignal>();
      // A fresh fixture below verifies lifecycle abort separately from timeout.
      const other = fixture({ input: (_title, _placeholder, opts) => { again.resolve(opts!.signal!); return new Promise(() => {}); } });
      try {
        const pending = other.server.sendRequest(UiRequests.input, { title: 'Pending' });
        const next = await bounded(again.promise);
        other.host.dispose();
        assert.equal(next.aborted, true);
        // The peer remains open in this in-memory fixture; close it explicitly.
        other.server.dispose(); await assert.rejects(pending);
      } finally { other.close(); }
    } finally { f.close(); }
  });

  test('forwards notifications, validates them, and uses ordered async terminal input', async () => {
    const calls: unknown[] = [];
    let interceptor: Parameters<NonNullable<ExtensionUi['onTerminalInputAsync']>>[0] | undefined;
    let unsubscribed = 0;
    const f = fixture({
      notify: (...args) => calls.push(['notify', ...args]),
      setStatus: (...args) => calls.push(['status', ...args]),
      clearStatuses: () => calls.push(['clearStatuses']),
      setEditorText: text => calls.push(['editor', text]), pasteToEditor: text => calls.push(['paste', text]),
      setToolsExpanded: expanded => calls.push(['expanded', expanded]), getToolsExpanded: () => true,
      onTerminalInputAsync: handler => { interceptor = handler; return () => { unsubscribed++; }; }
    });
    f.server.onRequest(UiRequests.terminalInput, ({ input }) => input === 'consume' ? { consume: true } : { consume: false, input: input.toUpperCase() });
    try {
      await f.server.sendNotification(Notifications.notify, { message: 'Hello', notifyType: 'info' });
      await f.server.sendNotification(Notifications.status, { key: 'k', text: null });
      await f.server.sendNotification(Notifications.clearStatuses, null);
      await f.server.sendNotification(Notifications.setEditorText, { text: 'new' });
      await f.server.sendNotification(Notifications.pasteToEditor, { text: 'more' });
      await f.server.sendNotification(Notifications.setToolsExpanded, { expanded: true });
      await f.server.sendNotification(Notifications.terminalInputSubscription, { enabled: true });
      await f.flush();
      assert.deepEqual(calls, [['notify', 'Hello', 'info'], ['status', 'k', undefined], ['clearStatuses'], ['editor', 'new'], ['paste', 'more'], ['expanded', true]]);
      assert.deepEqual(await interceptor!('abc'), { data: 'ABC' });
      assert.deepEqual(await interceptor!('consume'), { consume: true });
      await f.server.sendNotification('ui.setEditorText', { text: 1 });
      await f.server.sendNotification('ui.status', { key: 'k', text: 'x', extra: true });
      await f.flush(); assert.equal(f.errors.length, 2);
      await f.server.sendNotification(Notifications.terminalInputSubscription, { enabled: false });
      await f.flush(); assert.equal(unsubscribed, 1);
    } finally { f.close(); }
  });

  test('bounds stuck terminal RPC and cancels pending requests on disposal', async () => {
    let interceptor!: Parameters<NonNullable<ExtensionUi['onTerminalInputAsync']>>[0];
    const f = fixture({ onTerminalInputAsync: handler => { interceptor = handler; return () => {}; } }, 20);
    const entered = deferred<void>(), cancelled = deferred<void>();
    f.server.onRequest(UiRequests.terminalInput, (_params, token) => {
      token.onCancellationRequested(() => cancelled.resolve()); entered.resolve(); return new Promise(() => {});
    });
    try {
      await f.server.sendNotification(Notifications.terminalInputSubscription, { enabled: true }); await f.flush();
      const work = interceptor('stuck'); await bounded(entered.promise);
      assert.equal(await bounded(work), undefined); await bounded(cancelled.promise);
      assert.match(f.errors[0], /timed out/);
      const next = deferred<void>(), nextCancelled = deferred<void>();
      f.server.onRequest(UiRequests.terminalInput, (_params, token) => {
        next.resolve(); token.onCancellationRequested(() => nextCancelled.resolve()); return new Promise(() => {});
      });
      const pending = interceptor('dispose'); await bounded(next.promise); f.bridge.dispose();
      assert.equal(await bounded(pending), undefined); await bounded(nextCancelled.promise);
      assert.equal(f.errors.length, 1);
    } finally { f.close(); }
  });

  test('ignores stale UI notifications after bridge disposal', async () => {
    let calls = 0;
    const f = fixture({ notify: () => { calls++; }, setEditorText: () => { calls++; }, setWidget: () => { calls++; } });
    try {
      f.bridge.dispose();
      await f.server.sendNotification(Notifications.notify, { message: 'late', notifyType: 'info' });
      await f.server.sendNotification(Notifications.setEditorText, { text: 'late' });
      await f.server.sendNotification(Notifications.widget, { key: 'late', placement: 'aboveEditor', content: ['late'] });
      await f.flush(); assert.equal(calls, 0);
    } finally { f.close(); }
  });

  test('never installs a Promise-returning synchronous terminal interceptor', async () => {
    let installed = false;
    const f = fixture({ onTerminalInput: () => { installed = true; return () => {}; } });
    try {
      await f.server.sendNotification(Notifications.terminalInputSubscription, { enabled: true }); await f.flush();
      assert.equal(installed, false); assert.match(f.errors[0], /asynchronous/);
    } finally { f.close(); }
  });

  test('widget/footer proxies cache sync rendering, preserve images, invalidate and dispose', async () => {
    let widget: CustomUiComponent | undefined, footer: CustomUiComponent | undefined;
    const redraw = deferred<void>(); let renders = 0;
    const disposed: string[] = [], layouts: RenderParams[] = [];
    const f = fixture({
      setWidget: (_key, content: ExtensionWidgetContent | undefined) => {
        widget?.dispose?.(); widget = undefined;
        if (typeof content === 'function') widget = content(createTuiFacade(terminal(), () => redraw.resolve()) as never, {} as never);
      },
      setFooter: factory => {
        footer?.dispose?.(); footer = undefined;
        if (factory) footer = factory(createTuiFacade(terminal(), () => {}) as never, {} as never, {} as never) as CustomUiComponent;
      }
    });
    f.server.onRequest(UiRequests.setSurfaceState, () => null);
    f.server.onRequest(UiRequests.dispose, ({ surfaceId }) => { disposed.push(surfaceId); return null; });
    f.server.onRequest(UiRequests.render, (params): RenderResult => {
      layouts.push(params); renders++;
      return { lines: ['caption', ''], blocks: [{ type: 'text', lines: ['caption'] }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', columns: 2, rows: 1 }] };
    });
    try {
      await f.server.sendNotification(Notifications.widget, { key: 'w', placement: 'belowEditor', content: { surfaceId: 'widget' } });
      await f.server.sendNotification(Notifications.footer, { surfaceId: 'footer' }); await f.flush();
      assert.deepEqual(widget!.render(70), []);
      await bounded(redraw.promise); await f.flush();
      const result = renderComponentContent(widget, 70, { widthPx: 9, heightPx: 18 });
      assert.equal(result.blocks[1].type, 'image'); assert.deepEqual(result.lines, ['caption', '']);
      assert.equal(renders, 1); assert.equal(layouts[0].width, 70); assert.equal(layouts[0].height, 4);
      await f.server.sendNotification(Notifications.invalidate, { surfaceId: 'widget' }); await f.flush();
      // A subsequent RPC roundtrip waits for the invalidation's render response.
      await f.flush(); assert.equal(renders, 2);
      f.bridge.dispose(); f.bridge.dispose(); await f.flush();
      assert.deepEqual(disposed.sort(), ['footer', 'widget']);
      assert.equal(widget, undefined); assert.equal(footer, undefined);
    } finally { f.close(); }
  });

  test('custom proxy forwards focus/input and cancellation hides existing host surface', async () => {
    const mounted = deferred<CustomUiComponent>(); const hidden = deferred<void>();
    let input = '', state: unknown;
    const f = fixture({ custom: async (factory, options) => {
      const done = deferred<unknown>();
      const component = await factory(createTuiFacade(terminal(), () => {}) as never, {} as never, {} as never, value => done.resolve(value));
      options?.onHandle?.({ hide() { (component as CustomUiComponent).dispose?.(); hidden.resolve(); done.resolve(undefined); } } as never);
      mounted.resolve(component as CustomUiComponent);
      return await done.promise as never;
    } });
    f.server.onRequest(UiRequests.setSurfaceState, p => { state = p; return null; });
    f.server.onRequest(UiRequests.surfaceInput, p => { input = p.input; return null; });
    f.server.onRequest(UiRequests.dispose, () => null);
    const source = new CancellationTokenSource();
    try {
      const work = f.server.sendRequest(UiRequests.custom, { surfaceId: 'custom', options: { overlay: true } }, source.token);
      const component = await bounded(mounted.promise);
      component.focused = true; component.handleInput?.('\r'); await f.flush();
      assert.deepEqual(state, { surfaceId: 'custom', attached: true, focused: true }); assert.equal(input, '\r');
      source.cancel(); await bounded(hidden.promise); assert.equal(await bounded(work), null);
    } finally { source.dispose(); f.close(); }
  });

  test('coalesces invalidations during render and fences late results after disposal', async () => {
    let component!: CustomUiComponent; let requests = 0, redraws = 0;
    const first = deferred<RenderResult>(), second = deferred<RenderResult>();
    const enteredFirst = deferred<void>(), enteredSecond = deferred<void>();
    const f = fixture({ setWidget: (_key, content) => {
      if (typeof content === 'function') component = content(createTuiFacade(terminal(), () => { redraws++; }) as never, {} as never);
    } });
    f.server.onRequest(UiRequests.render, () => {
      requests++;
      if (requests === 1) { enteredFirst.resolve(); return first.promise; }
      enteredSecond.resolve(); return second.promise;
    });
    f.server.onRequest(UiRequests.dispose, () => null);
    try {
      await f.server.sendNotification(Notifications.widget, { key: 'w', placement: 'aboveEditor', content: { surfaceId: 'w' } }); await f.flush();
      component.render(80); await bounded(enteredFirst.promise);
      await f.server.sendNotification(Notifications.invalidate, { surfaceId: 'w' });
      await f.server.sendNotification(Notifications.invalidate, { surfaceId: 'w' }); await f.flush();
      component.render(100); assert.equal(requests, 1);
      first.resolve({ lines: ['stale layout'] }); await bounded(enteredSecond.promise);
      assert.deepEqual(component.render(100), []);
      component.dispose?.(); const before = redraws;
      second.resolve({ lines: ['late'] }); await f.flush(); await f.flush();
      assert.equal(redraws, before); assert.deepEqual(component.render(100), []); assert.equal(requests, 2);
    } finally { f.close(); }
  });

  test('bad remote render results are reported without becoming cached HTML/image data', async () => {
    let component!: CustomUiComponent;
    const rendered = deferred<void>();
    const f = fixture({ setWidget: (_key, content) => { if (typeof content === 'function') component = content(createTuiFacade(terminal(), () => {}) as never, {} as never); } });
    f.server.onRequest(UiRequests.render, () => { rendered.resolve(); return { lines: ['bad'], blocks: [{ type: 'image', data: '<script>', mimeType: 'text/html', columns: 1, rows: 1 }] } as never; });
    f.server.onRequest(UiRequests.dispose, () => null);
    try {
      await f.server.sendNotification(Notifications.widget, { key: 'w', placement: 'aboveEditor', content: { surfaceId: 'w' } }); await f.flush();
      component.render(80); await bounded(rendered.promise); await f.flush(); await f.flush();
      assert.deepEqual(component.render(80), []); assert.match(f.errors[0], /render response/);
    } finally { f.close(); }
  });
});
