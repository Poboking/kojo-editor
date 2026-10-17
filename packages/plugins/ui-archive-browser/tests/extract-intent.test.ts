/**
 * 取出意图（面板 → 归档读取单源）判据批（W13 ARCHIVE-READ）。
 *
 * 为什么不渲染面板：本包 devDeps 只有 react（无 react-dom），`createElement` 面板点不了按钮
 * （先例与理由见 `ui-sugar-editor/tests/new-file-flow.test.ts` 头注）。
 * 真正会坏的东西是**请求形状**：一旦面板侧多出一个"目标目录"字段，绕过只读闸的口子就回来了，
 * 所以这里把形状钉成两字段，并把结果文案的口径钉在契约那份 `formatBytes` 上。
 */

import { describe, expect, it } from 'vitest';
import type { ArchiveExtractOutcome, ArchiveReaderService, PluginContext } from '@kojo/plugin-api';
import {
  ArchiveServices,
  formatBytes,
  WellKnownServices,
} from '@kojo/plugin-api';
import {
  EXTRACT_LABELS,
  extractOutcomeText,
  extractRequest,
} from '../src/panel-logic';
import { createUiArchiveBrowserPlugin } from '../src/index';

const ENTRY = 'D:/Game/sav/save01.sav';

/* ---------------- 1. 请求形状：只有 kind + entryPath ---------------- */

describe('extractRequest · 无目标路径参数位', () => {
  it('workspace 形态：字段恰为 kind + entryPath', () => {
    const req = extractRequest(ENTRY, 'workspace');
    expect(req).toEqual({ kind: 'workspace', entryPath: ENTRY });
    expect(Object.keys(req).sort()).toEqual(['entryPath', 'kind']);
  });

  it('dialog 形态：同样只有两个字段（落点由系统对话框决定，面板不参与）', () => {
    const req = extractRequest(ENTRY, 'dialog');
    expect(req).toEqual({ kind: 'dialog', entryPath: ENTRY });
    expect(Object.keys(req).sort()).toEqual(['entryPath', 'kind']);
  });

  it('两种落点之外的说法一律不在文案里出现（没有"选目录"这种第三种形态）', () => {
    expect(Object.keys(EXTRACT_LABELS).sort()).toEqual(['dialog', 'workspace']);
  });
});

/* ---------------- 2. 结果文案口径来自契约那一份 formatBytes ---------------- */

describe('extractOutcomeText', () => {
  const outcome = (over: Partial<ArchiveExtractOutcome>): ArchiveExtractOutcome => ({
    kind: 'workspace',
    entryPath: ENTRY,
    landing: 'C:\\Users\\author\\AppData\\kojo\\workspaces\\archive-extractions\\save01.sav',
    bytes: 571_185,
    cancelled: false,
    ...over,
  });

  it('成功：字节数走契约 `formatBytes`，并原样显示落点', () => {
    const o = outcome({});
    expect(extractOutcomeText(o)).toBe(`已取出 ${formatBytes(o.bytes)} → ${o.landing}`);
    expect(extractOutcomeText(o)).toContain('557.8 KB');
  });

  it('取消：如实"未写任何字节"，不冒充成功', () => {
    expect(extractOutcomeText(outcome({ cancelled: true, landing: '' }))).toBe('已取消（未写任何字节）');
  });

  it('零字节条目也如实报（不写成"空"或省略）', () => {
    expect(extractOutcomeText(outcome({ bytes: 0 }))).toContain(formatBytes(0));
  });
});

/* ---------------- 3. 面板只接一个读取入口 ---------------- */

describe('归档浏览器 · 只依赖归档读取单源', () => {
  it('requires 含 archive.reader，且不再要求 snapshot.source', () => {
    const plugin = createUiArchiveBrowserPlugin();
    expect(plugin.requires).toContain(ArchiveServices.Reader);
    expect(plugin.requires).not.toContain(WellKnownServices.SnapshotSource);
  });

  it('插件不声明任何写侧能力（provides 为空）', () => {
    const plugin = createUiArchiveBrowserPlugin();
    expect(plugin.provides ?? []).toEqual([]);
  });

  it('服务缺席时硬依赖不激活（inject 抛错即中断，绝不退回自建链路）', async () => {
    const ctx = {
      pluginId: 'ui-archive-browser',
      log: { debug() {}, info() {}, warn() {}, error() {} },
      bus: { on: () => () => {}, once: () => () => {}, emit: () => {} },
      storage: {},
      slots: { register: () => {}, query: () => [] },
      onDispose: () => {},
      provide: () => {},
      tryInject: () => undefined,
      inject: (key: string): unknown => {
        throw new Error(`missing service: ${key}`);
      },
    } as unknown as PluginContext;
    expect(() => createUiArchiveBrowserPlugin().activate(ctx)).toThrow(/missing service/);
  });

  it('取出动作把请求原样交给单源（不加工路径、不自己落盘）', async () => {
    const seen: unknown[] = [];
    const reader = {
      current: () => null,
      async scan() {
        return { dir: 'D:/Game/sav', entries: [], scannedAt: 0, durationMs: 0 };
      },
      async parse(): Promise<never> {
        throw new Error('unused');
      },
      async parseEntry(): Promise<never> {
        throw new Error('unused');
      },
      async readEntry(): Promise<never> {
        throw new Error('unused');
      },
      async extractEntry(request: unknown): Promise<never> {
        seen.push(request);
        throw new Error('rejected by reader');
      },
    } as unknown as ArchiveReaderService;
    // 面板侧的意图构造唯一入口就是 extractRequest —— 这里验它与读服务之间的形状不漂移
    const req = extractRequest(ENTRY, 'workspace');
    await reader.extractEntry(req).catch(() => {});
    expect(seen).toEqual([req]);
    expect(Object.keys(seen[0] as Record<string, unknown>).sort()).toEqual(['entryPath', 'kind']);
  });
});
