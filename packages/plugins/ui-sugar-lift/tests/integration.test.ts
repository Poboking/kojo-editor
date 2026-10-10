/**
 * S5-UI 批验收：面板 + 应用**端到端**（跨插件的服务槽接线）。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故可以直接 import
 * 两个插件包来验证接线——生产代码里它们只能通过服务槽相见。
 *
 * 验的是那条最容易坏、也最该被钉死的东西：
 *
 * ```
 * ui-sugar-lift 面板插件  --(服务槽)-->  kojo-sugar 的 sugar.lift / sugar.liftApply
 *                                              |
 *                                       内核 io（第一道闸）+ 备份 + 回读
 *                                              |
 *                                        file.changed 事件
 * ```
 *
 * 三件事必须同时成立：
 * 1. **面板插件真的能激活**（`requires` 的三项都由 kojo-sugar/内核提供）；
 * 2. **面板不存在自己的写逻辑**——它的"应用"就是 `sugar.liftApply`，
 *    所以写盘闸门、备份、回读一个都不少；
 * 3. **应用成功后发 `file.changed`**，且**发口在装配层**（实现层零内核依赖）。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  FileIO,
  FileStat,
  KernelEventMap,
  Logger,
  Plugin,
  SugarLiftApplyService,
  SugarLiftService,
  UIPanelContribution,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createUiSugarLiftPlugin } from '../src/index';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = (s: string) => new TextEncoder().encode(s);

/** 伪内核 io（内存 FS + 双闸替身；与 lift-apply.test.ts 同款） */
function makeIO(files: Record<string, Uint8Array>, writable: (p: string) => boolean = () => true) {
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
      if (!writable(p)) {
        throw Object.assign(new Error(`Write not allowed outside declared writable roots: ${p}`), {
          name: 'WriteNotAllowedError',
        });
      }
      files[p] = data;
    },
    ensureDir: async () => {},
    listDir: async (): Promise<DirEntry[]> => [],
    walkDir: async (): Promise<DirEntry[]> => [],
    exists: async (p) => Boolean(files[p]),
    stat: async (p): Promise<FileStat | null> => (files[p] ? { size: files[p]!.length, mtimeMs: 1, isDirectory: false } : null),
    setWritableRoots: () => {},
    isWritable: writable,
    backup: async (p) => (files[p] ? `backup:///${p.replace(/\//g, '_')}.bak` : null),
  };
  return io;
}

/**
 * 最小内核替身：只实现本批需要的最小面。
 *
 * 为什么不拉真内核：两者都要真 io + 真实事件总线，但**本测试的意图是"接线正确"**
 * 而不是"内核正确"——内核自有其测试。这里把服务槽/事件总线的契约**降到最小**
 * 反而让"面板依赖了哪些东西"变得无法含糊（`inject` 只给清单里那几项，
 * 多要一个就抛）。
 */
function makeKernel(files: Record<string, Uint8Array>, writable: (p: string) => boolean = () => true) {
  const io = makeIO(files, writable);
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

/** 激活 kojo-sugar，返回它提供的服务表 */
function bootSugar(k: ReturnType<typeof makeKernel>) {
  createKojoSugarPlugin().activate(k.sugarCtx as never);
  return {
    lift: k.provided.get(WellKnownServices.SugarLift) as SugarLiftService,
    apply: k.provided.get(WellKnownServices.SugarLiftApply) as SugarLiftApplyService,
  };
}

/** 激活 ui-sugar-lift 面板插件（只给服务槽 + 内核 io + 总线） */
function bootPanel(k: ReturnType<typeof makeKernel>) {
  const panelCtx = {
    log,
    inject: (key: string): never => {
      const v = k.provided.get(key);
      if (v === undefined && key !== 'kernel.io') throw new Error(`未注册的服务：${key}`);
      if (key === 'kernel.io') return k.io as never;
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
  createUiSugarLiftPlugin().activate(panelCtx as never);
}

const KOJO = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n\tPRINTFORMDL 乙。\n';
const PATH = '/proj/口上/x.kojo';

/* ============================== 一、接线 ============================== */

describe('S5-UI / 面板插件接线（跨插件只走服务槽）', () => {
  it('面板插件声明：requires 三个槽，无 provides，无 io 写入自建', () => {
    const p: Plugin = createUiSugarLiftPlugin();
    expect(p.id).toBe('ui-sugar-lift');
    expect(p.requires).toEqual(['sugar.lift', 'sugar.liftApply', 'kernel.io']);
    // 面板不提供任何服务（它是纯消费者）
    expect(p.provides ?? []).toEqual([]);
  });

  it('激活后可注册 `ui.panel` 贡献（id=sugar-lift）', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    bootSugar(k);
    bootPanel(k);
    expect(k.panels).toHaveLength(1);
    expect(k.panels[0]!.id).toBe('sugar-lift');
    expect(typeof k.panels[0]!.component).toBe('function');
  });

  it('服务槽顺序：kojo-sugar 先装配 → 面板才能注入（反序必失败）', () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    expect(() => bootPanel(k)).toThrow(/未注册的服务：sugar.lift/);
  });

  it('`sugar.liftApply` 服务键已登记（WellKnownServices additive）', () => {
    expect(WellKnownServices.SugarLiftApply).toBe('sugar.liftApply');
    expect(WellKnownServices.SugarLift).toBe('sugar.lift'); // 旧键未变
  });
});

/* ============================== 二、端到端闭环 ============================== */

describe('S5-UI / 端到端：扫描 → 应用 → 落盘 → 事件', () => {
  const boot = () => {
    const k = makeKernel({ [PATH]: enc(KOJO) });
    const svcs = bootSugar(k);
    bootPanel(k);
    return { k, ...svcs };
  };

  it('扫描 → 应用 → 源文件被糖化；事件只发一次且 payload 合契约', async () => {
    const { k, lift, apply } = boot();
    const r = lift.liftSuggest({ source: KOJO, filePath: PATH });
    expect(r.candidates.map((c) => c.kind)).toEqual(['print-message', 'print-message']);

    const res = await apply.applyToFile(PATH, { source: KOJO, candidates: r.candidates });
    expect(res.appliedCount).toBe(2);
    expect(res.backupPath).not.toBeNull();

    // 落盘内容（去 BOM 解码）——两条 PRINTFORM{D}W/L 都变成了糖文本行
    const text = new TextDecoder().decode(k.files[PATH]!).replace(/^\uFEFF/, '');
    expect(text).toBe('角色: 1\n时机 指令 1：\n\t甲。\n\t乙。 续\n');

    // 事件：一次 change，path 是归一化后的目标
    const changed = k.events.filter((e) => e.type === 'file.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toEqual({ kind: 'change', path: PATH });
  });

  it('回读闭环：落盘后再扫描**读到的是糖**（应用真的生效，而非只改了内存）', async () => {
    const { k, lift, apply } = boot();
    const r = lift.liftSuggest({ source: KOJO });
    await apply.applyToFile(PATH, { source: KOJO, candidates: r.candidates });
    const after = new TextDecoder().decode(k.files[PATH]!).replace(/^\uFEFF/, '');
    const r2 = lift.liftSuggest({ source: after });
    // 糖源码里没有 `PRINTFORM*`，故升糖候选为 0（已糖化的内容不再报"可升糖"）
    expect(r2.candidates).toHaveLength(0);
  });

  it('越权：面板走同一服务 → 同一个第一道闸（原样抛 WriteNotAllowedError，不发事件）', async () => {
    const k = makeKernel({ [PATH]: enc(KOJO) }, () => false);
    const svcs = bootSugar(k);
    bootPanel(k);
    const r = svcs.lift.liftSuggest({ source: KOJO });
    await expect(svcs.apply.applyToFile(PATH, { source: KOJO, candidates: r.candidates })).rejects.toMatchObject({
      name: 'WriteNotAllowedError',
    });
    expect(k.events.filter((e) => e.type === 'file.changed')).toHaveLength(0);
  });

  it('只读预览：`apply` 纯函数不落盘、不发事件（面板的 diff 预览走的就是它）', () => {
    const { k, lift, apply } = boot();
    const before = new Uint8Array(k.files[PATH]!);
    const r = lift.liftSuggest({ source: KOJO });
    const preview = apply.apply({ source: KOJO, candidates: r.candidates });
    expect(preview.appliedCount).toBe(2);
    expect(preview.hunks).toHaveLength(2);
    expect(preview.text).toContain('\t甲。');
    expect(k.files[PATH]).toEqual(before);
    expect(k.events).toHaveLength(0);
  });

  it('`作者色` 候选：应用时**自动写文件头**（自证前提被满足）', async () => {
    const src = '角色: 1\n时机 指令 1：\n\tPRINTFORML 她红着脸，小声嘟囔着。\n';
    const k = makeKernel({ [PATH]: enc(src) });
    const svcs = bootSugar(k);
    const r = svcs.lift.liftSuggest({ source: src });
    expect(r.candidates[0]!.narrationColor).toBe('作者色');
    const res = await svcs.apply.applyToFile(PATH, { source: src, candidates: r.candidates });
    expect(res.preview.frontMatterChanged).toBe(true);
    const text = new TextDecoder().decode(k.files[PATH]!).replace(/^\uFEFF/, '');
    expect(text).toBe('角色: 1\n旁白色: 作者色\n时机 指令 1：\n\t她红着脸，小声嘟囔着。 续\n');
  });
});

/* ============================== 三、事件纪律 ============================== */

describe('S5-UI / 事件纪律', () => {
  it('`file.changed` 的发口在装配层：直接调 `applyLiftToFile` 不发事件', async () => {
    const file = '/x.kojo';
    const files: Record<string, Uint8Array> = { [file]: enc(KOJO) };
    const io = makeIO(files);
    const { applyLiftToFile } = await import('@kojo/plugin-kojo-sugar');
    const { createSugarTranspileService } = await import('@kojo/plugin-kojo-sugar');
    const { createEratwFaceTable } = await import('@kojo/plugin-eratw-adapter');
    const svc = createSugarTranspileService({ faceTable: createEratwFaceTable() });
    const lift = (await import('@kojo/plugin-kojo-sugar')).liftSuggest;
    const r = lift({ transpile: (s, o) => svc.transpile(s, o) }, { source: KOJO });
    const res = await applyLiftToFile({ io, log }, file, { source: KOJO, candidates: r.candidates });
    expect(res.appliedCount).toBe(2);
    // 实现层不碰总线 → 无事件（事件是装配层 `onApplied` 的职责）
    expect(files[file]).not.toEqual(enc(KOJO));
  });
});
