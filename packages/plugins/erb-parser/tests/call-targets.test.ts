/**
 * 未定义 CALL 目标波浪线（T3，2026-10-16 语言服务批）单测。
 *
 * 纯函数面（`scanUndefinedCallTargets` / `erbReferenceDecorations`）逐条钉正反两路；
 * 装配面用本文件自带的极小上下文体（不动 `plugin.test.ts` 的共享夹具，避免与
 * 并行批次撞同一文件）：贡献确实注册、索引缺席零误报（fail-open）、建好只报真缺口。
 */
import { describe, expect, it } from 'vitest';
import type { ErbParserService, FileIO, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import {
  UNDEFINED_CALL_CODE,
  UNDEFINED_TRY_CALL_CODE,
  erbReferenceDecorations,
  scanUndefinedCallTargets,
  tryCallTargetDecorations,
} from '../src/references';
import { makeComputeStub } from './support';

const dict = (names: readonly string[]) => {
  const set = new Set(names.map((n) => n.toUpperCase()));
  return (upper: string) => set.has(upper);
};

describe('scanUndefinedCallTargets · 正例（未收录的裸名字要报）', () => {
  it('CALL + 未收录名：行列钉死（1 基列指向名字首字符）', () => {
    expect(scanUndefinedCallTargets('CALL NOPE\n', dict([]))).toEqual([{ line: 1, column: 6, name: 'NOPE' }]);
  });

  it('非 TRY 直系族照报（`CALL_FAMILY` 里引擎没置 IS_TRY 的只有 CALL）', () => {
    expect(scanUndefinedCallTargets('CALL F\n', dict([]))).toEqual([{ line: 1, column: 6, name: 'F' }]);
  });

  it('TRY 系直系族目标缺失**不报**（引擎允许；Instraction.Child.cs 的 `!func.Function.IsTry()`）', () => {
    for (const kw of ['TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']) {
      expect(scanUndefinedCallTargets(`${kw} F\n`, dict([])), kw).toEqual([]);
    }
  });

  it('TRY 档信息层：`includeTry` 显式开才出条目，带 isTry 旗（默认档零膨胀）', () => {
    for (const kw of ['TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']) {
      expect(scanUndefinedCallTargets(`${kw} F\n`, dict([]), { includeTry: true }), kw).toEqual([
        { line: 1, column: kw.length + 2, name: 'F', isTry: true },
      ]);
    }
    // 非 TRY 那一档不受 includeTry 影响，也不带 isTry
    expect(scanUndefinedCallTargets('CALL F\n', dict([]), { includeTry: true })).toEqual([
      { line: 1, column: 6, name: 'F' },
    ]);
  });

  it('CALL_FAMILY 全表都进槽位判据（同一个名字槽尺子；TRY 档由上面两条分别钉）', () => {
    for (const kw of ['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']) {
      expect(scanUndefinedCallTargets(`${kw} F\n`, dict(['F']), { includeTry: true }), kw).toEqual([]);
      expect(scanUndefinedCallTargets(`${kw} F\n`, dict([]), { includeTry: true }), kw).toHaveLength(1);
    }
  });

  it('缩进不挪列；实参括号不破坏裸名（`CALL NOPE(1)` 照报）', () => {
    expect(scanUndefinedCallTargets('\t\tCALL NOPE(1)\n', dict([]))).toEqual([{ line: 1, column: 8, name: 'NOPE' }]);
  });

  it('小写 / CJK 名照报（记号原样、归一查表——真语料两成函数名含 CJK）', () => {
    expect(scanUndefinedCallTargets('call nope\n', dict([]))).toEqual([{ line: 1, column: 6, name: 'nope' }]);
    expect(scanUndefinedCallTargets('CALL 存在しない\n', dict([]))).toEqual([
      { line: 1, column: 6, name: '存在しない' },
    ]);
  });

  it('多行各自成条；已定义与未定义互不干扰', () => {
    const text = 'CALL NOPE\nCALL ALPHA\nCALL ALSO_NOPE\n';
    expect(scanUndefinedCallTargets(text, dict(['ALPHA']))).toEqual([
      { line: 1, column: 6, name: 'NOPE' },
      { line: 3, column: 6, name: 'ALSO_NOPE' },
    ]);
  });

  it('整串匹配：前缀/后缀粘连不是同一个名（NOPES ≠ NOPE）', () => {
    expect(scanUndefinedCallTargets('CALL NOPES\n', dict(['NOPE']))).toEqual([{ line: 1, column: 6, name: 'NOPES' }]);
  });
});

describe('scanUndefinedCallTargets · 反例（fail-open，一条都不许多报）', () => {
  it('已收录的名字不报', () => {
    expect(scanUndefinedCallTargets('CALL ALPHA\n', dict(['ALPHA']))).toEqual([]);
  });

  it('CALLFORM 全族不报（FORM 的名字参数是表达式世界）', () => {
    expect(scanUndefinedCallTargets('CALLFORM NOPE\nTRYCALLFORM NOPE\nTRYCGOTOFORM NOPE\n', dict([]))).toEqual([]);
  });

  it('动态拼接不报：`(`、`"`、`{`、`%` 出现在关键字与记号之间', () => {
    expect(
      scanUndefinedCallTargets('CALL (NOPE)\nCALL "NOPE"\nCALL {NOPE}\nCALL %NOPE\n', dict([])),
    ).toEqual([]);
  });

  it('成员访问占槽不报也不向后顺延：`CALL FLAG:NOPE` 零产出', () => {
    expect(scanUndefinedCallTargets('CALL FLAG:NOPE\n', dict([]))).toEqual([]);
  });

  /* D03 批②·子名与"尺子比引擎窄"两档 fail-open
   * 引擎读名字：ArgumentBuilder.cs 的 SP_CALL_ArgumentBuilder ⇒
   *   ReadString(st, StrEndWith.LeftParenthesis_Bracket_Comma_Semicolon) + Trim([' ', '\t'])
   *   随后 `if (cur == '[') subNames = …`；ErbLoader.cs:644 `//TODO:subNames 結局実装しないかも`，
   *   SubNames 全仓唯一实消费 = ErbLoader.cs:1534 的 TRYGOTOLIST 拒用检查。
   * ⇒ 名字只在 `(` / `[` / `,` / `;` / 行尾断开；我们的记号尺按字母数字下划线切，窄于引擎。 */
  it('子名形态不判：`CALL NOPE[SUB]` / `CALL NOPE[[莉莉白]]` 零产出（名字后的 […] 不是"名字不存在"的证据）', () => {
    expect(scanUndefinedCallTargets('CALL NOPE[SUB]\nCALL NOPE[[莉莉白]]\n', dict([]))).toEqual([]);
    // TRY 形信息层同样不判（同一道门，不是 TRY 档专属）
    expect(scanUndefinedCallTargets('TRYCALL NOPE[[莉莉白]]\n', dict([]), { includeTry: true })).toEqual([]);
  });

  it('记号尺比引擎窄时不判：全角 ％ / ＆ / － / 全角空白 续接的名字不作静态目标判定', () => {
    // 语料实例：`@MESSAGE_COM61背面立位＆時間停止＆抜かず` 在盘上真实存在，旧尺只拿到前半截
    expect(scanUndefinedCallTargets('CALL 背面立位＆時間停止＆抜かず\n', dict([]))).toEqual([]);
    expect(scanUndefinedCallTargets('CALL NOPE%NEXT\n', dict([]))).toEqual([]);
    expect(scanUndefinedCallTargets('CALL NOPE　ARG\n', dict([]))).toEqual([]);
    // 反证同尺度：引擎会在此断开的那几种（`(` / `,` / `;`）照报，判据没被放宽成"什么都不报"
    expect(scanUndefinedCallTargets('CALL NOPE(1)\n', dict([]))).toEqual([{ line: 1, column: 6, name: 'NOPE' }]);
    expect(scanUndefinedCallTargets('CALL NOPE, 1\n', dict([]))).toEqual([{ line: 1, column: 6, name: 'NOPE' }]);
  });

  it('字符串内容 / 行内注释尾巴 / [SKIPSTART] 区 / $ 标签行不报', () => {
    const text = 'PRINT "CALL NOPE"\nCALL ALPHA ; CALL NOPE\n[SKIPSTART]\nCALL NOPE\n[SKIPEND]\n$NOPE\n';
    expect(scanUndefinedCallTargets(text, dict(['ALPHA']))).toEqual([]);
  });

  it('空文本 ⇒ 空流水', () => {
    expect(scanUndefinedCallTargets('', dict([]))).toEqual([]);
  });
});

describe('erbReferenceDecorations · 装饰成形', () => {
  it('warning + 名字列区间 + 稳定诊断码', () => {
    expect(erbReferenceDecorations({ path: '/a.ERB', text: 'CALL NOPE\n' }, dict([]))).toEqual([
      {
        line: 1,
        severity: 'warning',
        message: expect.stringContaining('NOPE'),
        startColumn: 6,
        endColumn: 10,
        code: UNDEFINED_CALL_CODE,
        source: 'erb-reference',
      },
    ]);
  });

  it('非方言（`.kojo` 归糖线管）与空文本零装饰', () => {
    expect(erbReferenceDecorations({ path: '/a.kojo', text: 'CALL NOPE\n' }, dict([]))).toEqual([]);
    expect(erbReferenceDecorations({ path: '/a.ERB', text: '' }, dict([]))).toEqual([]);
  });

  it('TRY 系一整个 TRYCALL→CALL 的反证对：warning 面只留确凿缺陷（D03 批②）', () => {
    expect(erbReferenceDecorations({ path: '/a.ERB', text: 'CALL NOPE\n' }, dict([]))).toHaveLength(1);
    expect(erbReferenceDecorations({ path: '/a.ERB', text: 'TRYCALL NOPE\n' }, dict([]))).toEqual([]);
    expect(erbReferenceDecorations({ path: '/a.ERB', text: 'TRYCALLSET NOPE\n' }, dict([]))).toEqual([]); // 词表外的关键字：那行根本不调用任何东西
  });

  it('信息层另码另档：`tryCallTargetDecorations` 出 info + erb.call-try-missing（默认不接 UI）', () => {
    const decos = tryCallTargetDecorations({ path: '/a.ERB', text: 'TRYCALL NOPE\nCALL NOPE\n' }, dict([]));
    expect(decos).toEqual([
      {
        line: 1,
        severity: 'info',
        message: expect.stringContaining('NOPE'),
        startColumn: 9,
        endColumn: 13,
        code: UNDEFINED_TRY_CALL_CODE,
      },
    ]);
    expect(UNDEFINED_TRY_CALL_CODE).not.toBe(UNDEFINED_CALL_CODE);
    expect(tryCallTargetDecorations({ path: '/a.kojo', text: 'TRYCALL NOPE\n' }, dict([]))).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * 装配面：贡献注册 + 索引缺席零误报 + 建好只报真缺口
 * ------------------------------------------------------------------------- */

const A = '/t/A.ERB';
const B = '/t/B.ERB';
const FILES: Record<string, string> = {
  [A]: '@ALPHA(ARG)\n\tRETURN 1\n',
  [B]: '@CALLER\n\tCALL ALPHA(1)\n\tCALL NOPE\n',
};
const MTIME = 1000;

function fakeIO(): FileIO {
  return {
    async readText(path: string) {
      const text = FILES[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: MTIME };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = FILES[path];
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: MTIME };
      });
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: MTIME, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(FILES)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false, mtimeMs: MTIME, size: FILES[p]!.length }));
    },
  } as unknown as FileIO;
}

function activate(): { services: Map<string, unknown>; decorators: Map<string, Record<string, unknown>> } {
  const services = new Map<string, unknown>();
  const decorators = new Map<string, Record<string, unknown>>();
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: {
      on: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      once: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      emit: noop,
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return fakeIO() as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    slots: {
      register: (kind: string, contribution: Record<string, unknown>) => {
        if (kind === 'ui.editor.decorator') decorators.set(contribution.id as string, contribution);
        return noop;
      },
      query: () => [],
    },
    onDispose: noop,
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return { services, decorators };
}

type DecoratorContribution = {
  id: string;
  title: string;
  offloadKind?: string;
  decorate(file: { path: string; text: string; project: null }): { line: number; severity: string }[];
};

describe('erb-parser · ui.editor.decorator 装配（erb-reference）', () => {
  it('注册为第二个装饰贡献；不声明 offloadKind（判据读项目态索引，同步主线程）', () => {
    const { decorators } = activate();
    const found = decorators.get('erb-reference') as unknown as DecoratorContribution | undefined;
    expect(found).toBeDefined();
    expect(found!.title.length).toBeGreaterThan(0);
    expect(found!.offloadKind).toBeUndefined();
  });

  it('索引未建 ⇒ 一条不报（fail-open 零误报，不是"全红"）', () => {
    const { decorators } = activate();
    const found = decorators.get('erb-reference') as unknown as DecoratorContribution;
    expect(found.decorate({ path: B, text: FILES[B]!, project: null })).toEqual([]);
  });

  it('索引建好 ⇒ 只报真缺口：B 里 NOPE 一条 warning、ALPHA 不报', async () => {
    const { services, decorators } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const found = decorators.get('erb-reference') as unknown as DecoratorContribution;
    const out = found.decorate({ path: B, text: FILES[B]!, project: null });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ line: 3, severity: 'warning', code: UNDEFINED_CALL_CODE });
    expect(found.decorate({ path: A, text: FILES[A]!, project: null })).toEqual([]);
  });
});
