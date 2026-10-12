/**
 * 升糖重定位批验收：面板 + 预览**端到端**（跨插件的服务槽接线）。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故可以直接 import
 * 两个插件包来验证接线——生产代码里它们只能通过服务槽相见。
 *
 * 验的是升糖重定位后最容易坏、也最该被钉死的东西：
 *
 * ```
 * ui-sugar-lift  --(服务槽 sugar.lift)-->  kojo-sugar 的 liftSuggest（纯函数，round-trip 自证）
 *      |
 *      |  💡 CodeAction / 面板「预览」按钮
 *      v
 *   bus.emit('editor.liftPreview.show', { filePath, fromLine, toLine, sugarText })
 *      |
 *      v
 *   宿主（EditorPane）就地折叠原文 + 打字机透镜（纯前端，零写盘）
 * ```
 *
 * 三件事必须同时成立：
 * 1. **面板插件只 require 识别服务 + 只读 io**——它**不** require `sugar.liftApply`
 *    （升糖只用于看，写回路径已从本插件摘除）；
 * 2. **预览 = 发宿主意图事件**，payload 合契约，且**全程不写盘**（files 逐字节不变）；
 * 3. **`ui.editor.liftPreview` / `ui.editor.codeAction` 两槽贡献都注册了**。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EditorCodeAction,
  EditorLiftPreviewContribution,
  FileIO,
  FileStat,
  KernelEventMap,
  Logger,
  Plugin,
  SugarLiftService,
  UIPanelContribution,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createUiSugarLiftPlugin } from '../src/index';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = (s: string) => new TextEncoder().encode(s);

/** 伪内核 io（内存 FS；只读读路径 + 写盘断言用） */
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
    stat: async (p): Promise<FileStat | null> => (files[p] ? { size: files[p]!.length, mtimeMs: 1, isDirectory: false } : null),
    setWritableRoots: () => {},
    setAppWritableRoots: () => {},
    isWritable: () => true,
    backup: async (p) => (files[p] ? `backup:///${p.replace(/\//g, '_')}.bak` : null),
    exportDirectory: async () => {
      throw new Error('exportDirectory is not supported by this fake');
    },
  };
  return io;
}

/**
 * 最小内核替身：只实现本批需要的最小面。
 *
 * 为什么不拉真内核：两者都要真 io + 真实事件总线，但**本测试的意图是"接线正确"**
 * 而不是"内核正确"——内核自有其测试。这里把服务槽/事件总线的契约**降到最小**
 * 反而让"面板依赖了哪些东西"变得无法含糊（`inject` 只给清单里那几项，多要一个就抛）。
 */
function makeKernel(files: Record<string, Uint8Array>) {
  const io = makeIO(files);
  const provided = new Map<string, unknown>();
  /** 槽注册表（按槽名分桶；面板插件经 `slots.register` 登记） */
  const slots = new Map<string, unknown[]>();
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

  /** kojo-sugar 只需要这几个槽（与它的 requires 一致） */
  const sugarCtx = {
    log,
    inject: (key: string) => {
      if (key === 'kernel.project') return { current: () => ({ adapterId: 'eratw' }) };
      // 分野模板表经 `game.adapter` 槽位注入（v0.3 S2 补齐）——测试用真实
      // eraTW 表，与生产装配同源；转译器不再内建任何模板。
      if (key === 'kernel.slots')
        return {
          query: (slot: string) =>
            slot === 'game.adapter'
              ? [{ adapter: { gameId: 'eratw', kojoFaceTemplates: createEratwFaceTable() } }]
              : [],
        };
      if (key === 'kernel.io') return io;
      // **结构扫描**（`erb.parser`）：整文件投影的**地基**——它决定控制流能否被
      // 识别成 `如果 …：`。缺席时投影会降级（控制流一律原样保留、段被切碎），
      // 故本测试提供真实扫描器（与生产装配同源），把"地基必需"这件事钉住。
      if (key === 'erb.parser') return { scanControlFlow: (t: string) => scanControlFlow(t) };
      // 软取目标（state.replay / condition.extractor）缺席是合法情形
      throw new Error(`未注册的服务：${key}`);
    },
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };

  const panelCtx = {
    log,
    inject: (key: string): never => {
      const v = provided.get(key);
      if (v === undefined && key !== 'kernel.io') throw new Error(`未注册的服务：${key}`);
      if (key === 'kernel.io') return io as never;
      return v as never;
    },
    slots: {
      register: (slot: string, contribution: unknown) => {
        const arr = slots.get(slot) ?? [];
        arr.push(contribution);
        slots.set(slot, arr);
      },
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };

  return { io, provided, slots, events, bus, sugarCtx, panelCtx, files };
}

const KOJO = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n\tPRINTFORMDL 乙。\n';
const ERB = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n\tPRINTFORMDL 乙。\n';
const PATH = '/proj/口上/x.kojo';

/** 激活 kojo-sugar（提供 sugar.lift），返回识别服务 */
function bootSugar(k: ReturnType<typeof makeKernel>): SugarLiftService {
  createKojoSugarPlugin().activate(k.sugarCtx as never);
  return k.provided.get(WellKnownServices.SugarLift) as SugarLiftService;
}

/** 激活 ui-sugar-lift（只给服务槽 + 内核 io + 总线） */
function bootPanel(k: ReturnType<typeof makeKernel>): void {
  createUiSugarLiftPlugin().activate(k.panelCtx as never);
}

const panelsOf = (k: ReturnType<typeof makeKernel>) => (k.slots.get('ui.panel') ?? []) as UIPanelContribution[];
const previewsOf = (k: ReturnType<typeof makeKernel>) =>
  (k.slots.get('ui.editor.liftPreview') ?? []) as EditorLiftPreviewContribution[];
const actionsOf = (k: ReturnType<typeof makeKernel>) =>
  (k.slots.get('ui.editor.codeAction') ?? []) as Array<{
    id: string;
    provideActions: (f: { path: string; text: string; project: null; line?: number }) => EditorCodeAction[];
  }>;

/* ============================== 一、接线 ============================== */

describe('升糖预览 / 面板插件接线（跨插件只走服务槽）', () => {
  it('面板插件声明：只 require 识别服务 + 只读 io，无 provides', () => {
    const p: Plugin = createUiSugarLiftPlugin();
    expect(p.id).toBe('ui-sugar-lift');
    expect(p.requires).toEqual(['sugar.lift', 'kernel.io']);
    // 升糖只用于看：本插件**不再** require sugar.liftApply（写回路径已摘除）
    expect(p.requires).not.toContain('sugar.liftApply');
    // 面板不提供任何服务（它是纯消费者）
    expect(p.provides ?? []).toEqual([]);
  });

  it('激活后注册三槽：ui.panel / ui.editor.liftPreview / ui.editor.codeAction', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    bootSugar(k);
    bootPanel(k);
    expect(panelsOf(k)).toHaveLength(1);
    expect(panelsOf(k)[0]!.id).toBe('sugar-lift');
    expect(typeof panelsOf(k)[0]!.component).toBe('function');
    expect(previewsOf(k)).toHaveLength(1);
    expect(typeof previewsOf(k)[0]!.provideLiftPreview).toBe('function');
    // 整文件投影供给与逐条候选**同一个贡献**的两个方法（口径不同、用途不同）
    expect(typeof previewsOf(k)[0]!.provideLiftProject).toBe('function');
    expect(actionsOf(k)).toHaveLength(1);
    expect(actionsOf(k)[0]!.id).toBe('sugar-lift.preview-action');
  });

  it('服务槽顺序：kojo-sugar 先装配 → 面板才能注入（反序必失败）', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    expect(() => bootPanel(k)).toThrow(/未注册的服务：sugar.lift/);
  });

  it('`sugar.liftApply` 服务键仍在（供未来「转 .kojo」用，只是本插件不再 require）', () => {
    expect(WellKnownServices.SugarLiftApply).toBe('sugar.liftApply');
    expect(WellKnownServices.SugarLift).toBe('sugar.lift');
  });
});

/* ============================== 二、预览闭环（不写盘） ============================== */

describe('升糖预览 / 端到端：扫描 → 预览意图 → 零写盘', () => {
  const boot = () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    bootSugar(k);
    bootPanel(k);
    return k;
  };

  it('`ui.editor.liftPreview` 供给：把可升糖区间交给宿主注册折叠', () => {
    const k = boot();
    const items = previewsOf(k)[0]!.provideLiftPreview({ path: PATH, text: KOJO, project: null });
    // 两条 PRINTFORM{D}W/L → 两条预览项（行号 1 基）
    expect(items.map((i) => `${i.fromLine}-${i.toLine}`)).toEqual(['3-3', '4-4']);
    expect(items[0]!.sugarText).toBe('甲。');
    expect(items[1]!.sugarText).toBe('乙。 续');
  });

  it('💡 CodeAction：光标所在行命中 → `run()` 发 `editor.liftPreview.show`，payload 合契约', () => {
    const k = boot();
    const actions = actionsOf(k)[0]!.provideActions({ path: PATH, text: KOJO, project: null, line: 3 });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('refactor');
    actions[0]!.run({ project: null as never, activeFile: PATH, line: 3 } as never);
    const shown = k.events.filter((e) => e.type === 'editor.liftPreview.show');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.payload).toEqual({ filePath: PATH, fromLine: 3, toLine: 3, sugarText: '甲。' });
  });

  it('光标不在任何可升糖片段上 → 无动作（💡 不乱出现）', () => {
    const k = boot();
    const actions = actionsOf(k)[0]!.provideActions({ path: PATH, text: KOJO, project: null, line: 1 });
    expect(actions).toEqual([]);
  });

  it('预览**全程不写盘**：跑完供给与执行，源文件逐字节不变、无 file.changed', () => {
    const k = boot();
    const before = new Uint8Array(k.files[PATH]!);
    const items = previewsOf(k)[0]!.provideLiftPreview({ path: PATH, text: KOJO, project: null });
    expect(items.length).toBe(2);
    const actions = actionsOf(k)[0]!.provideActions({ path: PATH, text: KOJO, project: null, line: 4 });
    actions[0]!.run({ project: null as never, activeFile: PATH, line: 4 } as never);
    // 只有"预览意图"事件，没有 file.changed（那是写盘信号）
    expect(k.events.map((e) => e.type)).toEqual(['editor.liftPreview.show']);
    expect(k.files[PATH]).toEqual(before);
  });

  it('原生 ERB 也能预览（升糖识别对 .erb 与 .kojo 同源；宿主负责只读折叠显示）', () => {
    const erbPath = '/proj/口上/x.erb';
    const k = makeKernel({ [erbPath]: enc(ERB) });
    bootSugar(k);
    bootPanel(k);
    const items = previewsOf(k)[0]!.provideLiftPreview({ path: erbPath, text: ERB, project: null });
    expect(items.map((i) => i.fromLine)).toEqual([3, 4]);
  });
});

/* ============================== 三、整文件糖投影供给 ============================== */

/**
 * B 层口径的端到端：**打开别人写的 ERB → 一键显示为糖**。
 *
 * 这一组断言服务的是本功能的**唯一目的**——不熟悉 EraBasic 的读者也能把口上
 * 当剧本读懂——所以断言的正是"读起来是什么样"：
 *
 * 1. 台词/旁白去掉 `PRINTFORM*` 前缀，`L` 后缀变行尾 ` 续`；
 * 2. 控制流变 `如果 …：` / `否则：`，缩进即块（`ENDIF` 不再显示）；
 * 3. 注释原样透传（作者的 `;分节线` 是阅读线索，不能丢）；
 * 4. 原生代词记号反糖（`%CALLNAME:MASTER%` → `{你}`）；
 * 5. 糖覆盖不到的行（`@` / `#DIM` / 赋值）原样留原代码，并**切断段**。
 */
describe('整文件糖投影 / 端到端：别人的 ERB → 读起来像剧本（零写盘）', () => {
  const ERB_FULL = [
    '; 分节标记',
    'IF TALENT:TARGET:恋慕',
    '\tPRINTFORMW 「%CALLNAME:MASTER%，今天也来训练了？」',
    '\tPRINTFORMDW %CALLNAME:TARGET%点了点头。',
    'ELSE',
    '\tPRINTFORMDL 她别开了脸。',
    'ENDIF',
    '@FUNC',
    '#DIM X',
    'X = 1',
  ].join('\n');
  const ERB_PATH = '/proj/口上/y.erb';

  const bootErb = () => {
    const k = makeKernel({ [ERB_PATH]: enc(ERB_FULL) });
    bootSugar(k);
    bootPanel(k);
    return k;
  };

  it('一个连续段：控制流 + 台词 + 注释透传 + 反糖，`@`/`#DIM`/赋值切断', () => {
    const k = bootErb();
    const items = previewsOf(k)[0]!.provideLiftProject!({
      path: ERB_PATH,
      text: ERB_FULL,
      project: null,
    });
    expect(items).toHaveLength(1);
    expect(`${items[0]!.fromLine}-${items[0]!.toLine}`).toBe('1-7');
    expect(items[0]!.sugarText.split('\n')).toEqual([
      '; 分节标记',
      '如果 TALENT:TARGET:恋慕：',
      '\t「{你}，今天也来训练了？」',
      '\t{她}点了点头。',
      '否则：',
      '\t她别开了脸。 续',
    ]);
  });

  it('`.kojo` 不供给投影——它本身就是糖（契约：不适用该文件的贡献返回空）', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    bootSugar(k);
    bootPanel(k);
    expect(
      previewsOf(k)[0]!.provideLiftProject!({ path: PATH, text: KOJO, project: null }),
    ).toEqual([]);
  });

  it('投影**零写盘**：跑完源文件逐字节不变、不发 file.changed', () => {
    const k = bootErb();
    const before = new Uint8Array(k.files[ERB_PATH]!);
    const items = previewsOf(k)[0]!.provideLiftProject!({
      path: ERB_PATH,
      text: ERB_FULL,
      project: null,
    });
    expect(items.length).toBeGreaterThan(0);
    expect(k.events).toEqual([]);
    expect(k.files[ERB_PATH]).toEqual(before);
  });
});