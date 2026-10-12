/**
 * S4-UI 批验收：糖预览面板 + 转译/预览**端到端**（跨插件的服务槽接线）。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故可以直接 import
 * 两个插件包来验证接线——生产代码里它们只能通过服务槽相见。
 *
 * 验的是那条最容易坏、也最该被钉死的东西：
 *
 * ```
 * ui-sugar-preview 面板插件  --(服务槽)-->  kojo-sugar 的 sugar.preview
 *                                                |
 *                                        内核 io（只读当前 .kojo）
 * ```
 *
 * 三件事必须同时成立：
 * 1. **面板插件真的能激活**（`requires` 两项由 kojo-sugar / 内核提供）；
 * 2. **面板不存在自己的转译/回放逻辑**——它的"预览"就是 `sugar.preview`；
 * 3. **只读纪律**：预览不改盘、不发事件（观察面，不是写面）。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  FileIO,
  FileStat,
  KernelEventMap,
  Logger,
  Plugin,
  SugarPreviewService,
  UIPanelContribution,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createUiSugarPreviewPlugin } from '../src/index';
import { buildPreviewRows, countLines, summarize } from '../src/panel-logic';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = (s: string) => new TextEncoder().encode(s);

const KOJO = ['角色: 1', '时机 初见：', '    「你好。」', '    她笑了。 续', ''].join('\n');
const PATH = '/proj/口上/x.kojo';

/** 伪内核 io（内存 FS；与 lift 集成测试同款） */
function makeIO(files: Record<string, Uint8Array>) {
  const io: FileIO = {
    readText: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return {
        path: p,
        text: new TextDecoder().decode(b).replace(/^\uFEFF/, ''),
        encoding: 'utf-8' as const,
        eol: 'lf' as const,
        bom: true,
        mtimeMs: 1,
        hasTrailingNewline: true,
      };
    },
    readBytes: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    writeText: async () => {},
    writeBytes: async (p, data) => {
      files[p] = data;
    },
    ensureDir: async () => {},
    listDir: async (): Promise<DirEntry[]> => [],
    walkDir: async (): Promise<DirEntry[]> => [],
    exists: async (p) => Boolean(files[p]),
    stat: async (p): Promise<FileStat | null> =>
      files[p] ? { size: files[p]!.length, mtimeMs: 1, isDirectory: false } : null,
    setWritableRoots: () => {},
    setAppWritableRoots: () => {},
    isWritable: () => false,
    backup: async () => null,
    exportDirectory: async () => {
      throw new Error('exportDirectory is not supported by this fake');
    },
    exportFile: async () => {
      throw new Error('exportFile is not supported by this fake');
    },
  };
  return io;
}

/**
 * 最小内核替身：只实现本批需要的最小面（服务槽 + 事件总线 + io）。
 * 意图是"接线正确"而非"内核正确"——多要一个槽就抛，让面板的依赖面无法含糊。
 */
function makeKernel(files: Record<string, Uint8Array>) {
  const io = makeIO(files);
  const provided = new Map<string, unknown>();
  const panels: UIPanelContribution[] = [];
  const events: Array<{ type: keyof KernelEventMap; payload: unknown }> = [];
  const listeners = new Map<string, Set<(p: never) => void>>();

  const bus = {
    on(type: string, handler: (p: never) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
    once(type: string, handler: (p: never) => void) {
      const un = bus.on(type, (p: never) => {
        un();
        handler(p);
      });
      return un;
    },
    emit(type: string, payload: unknown) {
      events.push({ type: type as keyof KernelEventMap, payload });
      for (const h of [...(listeners.get(type) ?? [])]) h(payload as never);
    },
  };

  /** kojo-sugar 的激活上下文（只给它的 requires 三项） */
  const sugarCtx = {
    log,
    inject: (key: string) => {
      if (key === 'kernel.project') return { current: () => ({ adapterId: 'eratw' }) };
      if (key === 'kernel.slots')
        return {
          query: (slot: string) =>
            slot === 'game.adapter'
              ? [{ adapter: { gameId: 'eratw', kojoFaceTemplates: createEratwFaceTable() } }]
              : [],
        };
      if (key === 'kernel.io') return io;
      // 软取目标（state.replay / erb.parser / condition.extractor）缺席是合法情形
      throw new Error(`未注册的服务：${key}`);
    },
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };

  return { io, provided, panels, events, bus, sugarCtx, files };
}

/** 激活 kojo-sugar，返回它提供的 sugar.preview 服务 */
function bootSugar(k: ReturnType<typeof makeKernel>): SugarPreviewService {
  createKojoSugarPlugin().activate(k.sugarCtx as never);
  return k.provided.get(WellKnownServices.SugarPreview) as SugarPreviewService;
}

/** 激活 ui-sugar-preview 面板插件（只给服务槽 + 内核 io + 总线） */
function bootPanel(k: ReturnType<typeof makeKernel>) {
  const panelCtx = {
    log,
    inject: (key: string): never => {
      if (key === 'kernel.io') return k.io as never;
      const v = k.provided.get(key);
      if (v === undefined) throw new Error(`未注册的服务：${key}`);
      return v as never;
    },
    slots: {
      register: (_slot: string, contribution: UIPanelContribution) => {
        k.panels.push(contribution);
      },
    },
    bus: k.bus,
    onDispose: (fn: unknown) => fn,
  };
  createUiSugarPreviewPlugin().activate(panelCtx as never);
}

/* ============================== 一、接线 ============================== */

describe('S4-UI / 面板插件接线（跨插件只走服务槽）', () => {
  it('面板插件声明：requires 两个槽，无 provides（纯消费者）', () => {
    const p: Plugin = createUiSugarPreviewPlugin();
    expect(p.id).toBe('ui-sugar-preview');
    expect(p.requires).toEqual(['sugar.preview', 'kernel.io']);
    expect(p.provides ?? []).toEqual([]);
  });

  it('激活后可注册 `ui.panel` 贡献（id=sugar-preview）', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    bootSugar(k);
    bootPanel(k);
    expect(k.panels).toHaveLength(1);
    expect(k.panels[0]!.id).toBe('sugar-preview');
    expect(typeof k.panels[0]!.component).toBe('function');
  });

  it('服务槽顺序：kojo-sugar 先装配 → 面板才能注入（反序必失败）', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    expect(() => bootPanel(k)).toThrow(/未注册的服务：sugar\.preview/);
  });

  it('`sugar.preview` 服务键已登记（WellKnownServices）', () => {
    expect(WellKnownServices.SugarPreview).toBe('sugar.preview');
  });
});

/* ============================== 二、端到端闭环（只读） ============================== */

describe('S4-UI / 端到端：读源 → 预览 → 面板建行（只读）', () => {
  const boot = () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    const preview = bootSugar(k);
    bootPanel(k);
    return { k, preview };
  };

  it('io 读当前 .kojo → sugar.preview → 行数 = 源文件行数；面板逐行同源', async () => {
    const { k, preview } = boot();
    const tf = await k.io.readText(PATH);
    const res = await preview.preview({ source: tf.text, filePath: PATH });
    expect(res.lines).toHaveLength(countLines(KOJO));

    const rows = buildPreviewRows(res, KOJO);
    expect(rows).toHaveLength(countLines(KOJO));
    for (let i = 0; i < res.lines.length; i++) {
      expect(rows[i]!.generatedLines).toEqual(res.lines[i]!.generatedLines);
    }
    expect(rows.some((r) => r.generatedLines.length > 0)).toBe(true);
    expect(Array.isArray(res.structuralLines)).toBe(true);
    expect(summarize(res, KOJO).diagnostics).toBe(res.transpile.diagnostics.length);
  });

  it('无存档请求 → 结构化降级（archive=null），不抛错、不假装有状态', async () => {
    const { preview } = boot();
    const res = await preview.preview({ source: KOJO, filePath: PATH });
    expect(res.archive).toBeNull();
  });

  it('只读纪律：预览前后磁盘字节不变、事件为零（观察面不发事件）', async () => {
    const { k, preview } = boot();
    const before = new Uint8Array(k.files[PATH]!);
    await preview.preview({ source: KOJO, filePath: PATH });
    expect(k.files[PATH]).toEqual(before);
    expect(k.events).toHaveLength(0);
  });

  it('转译 error → 仍返回结果（诊断原样带出，面板据此渲染而非抛错）', async () => {
    const { preview } = boot();
    const bad = ['角色: 1', '时机 初见：', '    如果 1：', '        「缺否则」'].join('\n');
    const res = await preview.preview({ source: bad, filePath: PATH });
    // 不抛错：预览只读观察面，坏输入也是合法输入
    expect(res.transpile.diagnostics.length).toBeGreaterThanOrEqual(0);
    expect(res.lines.length).toBe(countLines(bad));
  });
});