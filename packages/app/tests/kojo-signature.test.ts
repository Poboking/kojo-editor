/**
 * 签名帮助（B5，形参槽语义）单测：调用位点解析 + 查表组装 + Monaco 装配。
 *
 * 覆盖重点全在**边界**（这些形态在口上文本里都是真的会敲出来的）：空括号 `()`、
 * 尾随逗号、括号未闭合、字符串里的逗号、**全角逗号 `，`**、嵌套调用取最内层、
 * 注释行 / 字符串内 / 括号外一律不认。查表一侧钉住"不猜"：`slotsFor` 返回 `null`
 * 或抛错 ⇒ 整条不应答；槽语义一律来自传入的协议对象（宿主运行时现取，见 EditorPane）。
 *
 * 桩 monaco 同 `kojo-definition.test.ts` 口径：只记录注册与 dispose。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoCallProtocol, KojoCallSlot } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  SIGNATURE_LOOKBACK_LINES,
  SIGNATURE_TRIGGER_CHARACTERS,
  describeCallSignature,
  describeErbSignature,
  findCallSite,
  findCallSiteAt,
  installSignatureHelp,
  resolveSignature,
  resolveSignatureInText,
  slotParameterLabel,
  toMonacoSignatureHelp,
} from '../src/monaco/kojo-signature';

const SLOTS: readonly KojoCallSlot[] = [
  { index: 3, kind: 'int', label: '事件子参数' },
  { index: 4, kind: 'int', label: '日期偏移' },
  { index: 1, kind: 'str', label: '发言文本' },
];

const protocol = (slots: readonly KojoCallSlot[] | null, seen?: (name: string) => void): KojoCallProtocol => ({
  slotsFor: (functionName: string) => {
    seen?.(functionName);
    return functionName === 'F' ? slots : null;
  },
});

/* ============================== findCallSite · 调用位点（纯逻辑） ============================== */

describe('findCallSite · 实参切分与活跃索引', () => {
  it('基本形态：`F(A, B)` 光标落在第 1 / 第 2 个实参', () => {
    const line = 'X = F(A, B)';
    expect(findCallSite(line, 7)).toMatchObject({ callee: 'F', activeIndex: 0, args: { length: 2 }, closed: true });
    expect(findCallSite(line, 10)?.activeIndex).toBe(1);
  });

  it('空括号 `F()`：算**一个空实参槽**（作者正要填第 0 槽），不是"零个实参"', () => {
    const hit = findCallSite('F()', 3); // 光标在 `(` 之后（Monaco 列 1 基：列 3 = 第 3 格之前）
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 0, closed: true });
    expect(hit!.args).toEqual([{ start: 2, end: 2 }]);
  });

  it('尾随逗号 `F(A,)`：光标在逗号之后 ⇒ 活跃索引切到 1（不是退回第 0 槽）', () => {
    expect(findCallSite('F(A,)', 5)?.activeIndex).toBe(1);
    expect(findCallSite('F(A, )', 6)?.activeIndex).toBe(1);
  });

  it('括号未闭合 `F(A, B`：照常应答（作者正在写最后一个实参），closed=false', () => {
    const hit = findCallSite('F(A, B', 7);
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 1, closed: false });
    expect(hit!.args).toEqual([
      { start: 2, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it('字符串里的逗号**不是**分隔符：`F("A,B", )` 仍是两个实参、光标在第 2 槽', () => {
    const hit = findCallSite('F("A,B", C)', 9);
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 1, closed: true });
    expect(hit!.args.length).toBe(2);
  });

  it('全角逗号 `，` 也是分隔符（口上文本的真形态）：`CALL F(1，2)` 切两槽', () => {
    const hit = findCallSite('CALL F(1，2)', 10); // 光标紧接在 `，` 之后
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 1 });
    expect(hit!.args.length).toBe(2);
  });

  it('嵌套调用取**最内层**未闭合括号：`F(G(A, B), C)` 里光标在 G 的槽上就认 G', () => {
    expect(findCallSite('F(G(A, B), C)', 6)).toMatchObject({ callee: 'G', activeIndex: 0 });
    expect(findCallSite('F(G(A, B), C)', 8)).toMatchObject({ callee: 'G', activeIndex: 1 });
    expect(findCallSite('F(G(A, B), C)', 12)?.callee).toBe('F'); // 内层已闭合 ⇒ 取外层
  });

  it('方括号里的逗号不算本层分隔符：`F(A[1,2], B)` 仍是两槽', () => {
    const hit = findCallSite('F(A[1,2], B)', 11);
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 1 });
    expect(hit!.args.length).toBe(2);
  });

  it('光标在括号外 / 注释行 / 字符串内 / 左括号前没有名字 ⇒ null（不猜）', () => {
    expect(findCallSite('F(A, B)', 8)).toBeNull(); // 光标已越过闭合的 `)`
    expect(findCallSite('; F(A, B)', 7)).toBeNull(); // 注释行
    expect(findCallSite('F("AB", C)', 5)).toBeNull(); // 光标落在字符串里
    expect(findCallSite('(A, B)', 4)).toBeNull(); // 没有可认的被调者
    expect(findCallSite('F(A, B)', 0)).toBeNull(); // 非法列
  });

  it('被调者名剥掉 `@` 前缀；中文名 / 带 `:` 的名字整段取', () => {
    expect(findCallSite('@F(A, B)', 6)?.callee).toBe('F');
    expect(findCallSite('吾妻事件(1, 2)', 10)?.callee).toBe('吾妻事件');
    expect(findCallSite('ABC:1(1, 2)', 10)?.callee).toBe('ABC:1');
  });
});

/* ============================== 查表与组装（纯逻辑，零游戏知识） ============================== */

describe('slotParameterLabel / describeCallSignature', () => {
  it('数值槽 `ARG:n`、字符串槽 `ARGS:n`（契约自述的口径），label 原文照抄不解释', () => {
    expect(slotParameterLabel(SLOTS[0]!)).toBe('ARG:3 事件子参数');
    expect(slotParameterLabel(SLOTS[2]!)).toBe('ARGS:1 发言文本');
  });

  it('签名 label 逐字包含每个参数标签（Monaco 用正则在本串里找高亮区间，对不上就没高亮）', () => {
    const signature = describeCallSignature('F', SLOTS, 0);
    expect(signature.label).toBe('F(ARG:3 事件子参数, ARG:4 日期偏移, ARGS:1 发言文本)');
    for (const parameter of signature.parameters) expect(signature.label).toContain(parameter);
  });

  it('活跃索引夹到最后一个声明槽：实参多于协议槽数也不假造第 N 槽', () => {
    expect(describeCallSignature('F', SLOTS, 99).activeParameter).toBe(2);
    expect(describeCallSignature('F', SLOTS, -3).activeParameter).toBe(0);
    expect(describeCallSignature('F', [], 0)).toEqual({ label: 'F()', parameters: [], activeParameter: 0 });
  });
});

describe('resolveSignature · 数据只从协议表来', () => {
  it('表缺席（项目没开 / adapter 没这张表）⇒ null', () => {
    expect(resolveSignature('F(A, B)', 4, undefined)).toBeNull();
  });

  it('`slotsFor` 返回 null（协议不认识这个函数）⇒ null，不产出任何签名', () => {
    const seen = vi.fn();
    expect(resolveSignature('GETBIT(A, 3)', 11, protocol(SLOTS, seen))).toBeNull();
    expect(seen).toHaveBeenCalledWith('GETBIT');
  });

  it('`slotsFor` 抛错 ⇒ null（能力出错退化可见，不让提示崩）', () => {
    const throwing: KojoCallProtocol = {
      slotsFor: () => {
        throw new Error('boom');
      },
    };
    expect(resolveSignature('F(A, B)', 4, throwing)).toBeNull();
  });

  it('命中：被调者名交协议表查槽，活跃参数 = 光标所在实参', () => {
    const hit = resolveSignature('F(A, B, C)', 10, protocol(SLOTS));
    expect(hit).toEqual({
      callee: 'F',
      signature: {
        label: 'F(ARG:3 事件子参数, ARG:4 日期偏移, ARGS:1 发言文本)',
        parameters: ['ARG:3 事件子参数', 'ARG:4 日期偏移', 'ARGS:1 发言文本'],
        activeParameter: 2,
      },
    });
  });
});

/* ============================== 跨行调用位点（R5 · findCallSiteAt / resolveSignatureInText） ============================== */

describe('findCallSiteAt · 跨行未闭合括号', () => {
  const linesOf = (text: string) => text.split('\n');
  // `CALL F(A,\n    B)`：光标在第二行 `B` 上（列 5）
  const MULTI = 'CALL F(A,\n    B)';

  it('调用跨两行：起点行收上来，callee / 槽位 / 闭合判定与单行一致', () => {
    // 第二行 `    B)`：光标列 5 = B 上 ⇒ 第 1 槽
    expect(findCallSiteAt(linesOf(MULTI), 1, 5)).toMatchObject({ callee: 'F', activeIndex: 1, closed: true });
    // 光标在第一行 `A` 上（列 8）照常（单行形态未破坏）
    expect(findCallSiteAt(linesOf(MULTI), 0, 8)).toMatchObject({ callee: 'F', activeIndex: 0 });
  });

  it('括号跨行未闭合：`CALL F(A,\n    B` 照常应答（作者正写最后实参），closed=false', () => {
    const hit = findCallSiteAt(linesOf('CALL F(A,\n    B'), 1, 7);
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 1, closed: false });
  });

  it('前一行是无关平衡行（delta=0）⇒ 一并拼入无害：光标行无调用 ⇒ null', () => {
    // `PRINTL "x"` 深度 0；下一行没有括号 ⇒ null
    expect(findCallSiteAt(linesOf('PRINTL "x"\n     '), 1, 3)).toBeNull();
  });

  it('前一行行内注释里的括号不参与深度（`;` 截断）：注释行不会把调用起点吞掉', () => {
    // 注释行 `; F(1, 2` 的括号若参与深度，会把光标行调用的起点关联错
    const hit = findCallSiteAt(linesOf('; F(1, 2\nCALL G(X)'), 1, 8);
    expect(hit).toMatchObject({ callee: 'G' });
  });

  it('前一行"关多"（闭合属于别的调用）⇒ 截断收点，光标行自身的调用照常应答', () => {
    // `X = F(1))` 多出一个 `)`（delta=-1）→ 向上收点截在它之后；光标行 `CALL G(A`
    // 是合法的未闭合调用（作者正写）⇒ 照常应答 G，不被上一行的残括号连坐
    expect(findCallSiteAt(linesOf('X = F(1))\nCALL G(A'), 1, 12)).toMatchObject({ callee: 'G', closed: false });
  });

  it('最内层括号语义跨行一致：跨行外层 + 行内内层，光标在内层认内层', () => {
    // `CALL F(\n    G(A, B), C)` 光标在 B 上（第 2 行列 9）⇒ 认 G
    const hit = findCallSiteAt(linesOf('CALL F(\n    G(A, B), C)'), 1, 9);
    expect(hit).toMatchObject({ callee: 'G', activeIndex: 1 });
    // 光标在 C 上（列 14）⇒ 认 F
    expect(findCallSiteAt(linesOf('CALL F(\n    G(A, B), C)'), 1, 14)?.callee).toBe('F');
  });

  it('字符串里的跨行内容不参与：上一行引号内逗号不是分隔符、括号不计数', () => {
    const hit = findCallSiteAt(linesOf('CALL F("A(B",\n    B)'), 1, 5);
    expect(hit).toMatchObject({ callee: 'F', activeIndex: 1 });
  });

  it('回看窗口封顶：调用起点在窗口之外 ⇒ null（每击键同步应答，回看必须 O(窗口)）', () => {
    const far = ['CALL F(', ...Array.from({ length: SIGNATURE_LOOKBACK_LINES }, () => '    A,'), '    B)'];
    expect(findCallSiteAt(far, far.length - 1, 6)).toBeNull();
    const near = ['CALL F(', ...Array.from({ length: SIGNATURE_LOOKBACK_LINES - 1 }, () => '    A,'), '    B)'];
    expect(findCallSiteAt(near, near.length - 1, 6)).toMatchObject({ callee: 'F' });
  });

  it('非法行号 / 空文本 ⇒ null（不抛）', () => {
    expect(findCallSiteAt([], 0, 1)).toBeNull();
    expect(findCallSiteAt(linesOf('A'), 5, 1)).toBeNull();
    expect(findCallSiteAt(linesOf('CALL F(A)'), -1, 5)).toBeNull();
  });
});

describe('resolveSignatureInText · 跨行查表组装', () => {
  it('跨行调用 + 协议命中：签名与单行一致（同一 describeCallSignature）', () => {
    const hit = resolveSignatureInText('CALL F(A,\n    B, C)', 2, 9, protocol(SLOTS));
    expect(hit).toEqual({
      callee: 'F',
      signature: {
        label: 'F(ARG:3 事件子参数, ARG:4 日期偏移, ARGS:1 发言文本)',
        parameters: ['ARG:3 事件子参数', 'ARG:4 日期偏移', 'ARGS:1 发言文本'],
        activeParameter: 2,
      },
    });
  });

  it('协议不认识 → ERB 形参回调：形参名原文组装签名（有数据就用数据）', () => {
    const hit = resolveSignatureInText('CALL MY_FUNC(X,\n    Y)', 2, 5, protocol(SLOTS), (name) =>
      name === 'MY_FUNC' ? [{ name: 'ARG' }, { name: 'ARGS:1' }] : null,
    );
    expect(hit).toEqual({
      callee: 'MY_FUNC',
      signature: { label: 'MY_FUNC(ARG, ARGS:1)', parameters: ['ARG', 'ARGS:1'], activeParameter: 1 },
    });
  });

  it('两表皆不认识 ⇒ null（**不造 ARG:n 兜底名**、不猜形参个数）', () => {
    // protocol 只认 `F`；`MYSTERY` 两表皆不认识
    expect(resolveSignatureInText('CALL MYSTERY(A,\n    B)', 2, 5, protocol(SLOTS), () => null)).toBeNull();
    expect(resolveSignatureInText('CALL MYSTERY(A,\n    B)', 2, 5, protocol(SLOTS))).toBeNull();
  });

  it('协议命中优先于 ERB 形参回调（先具体后泛化）', () => {
    const seen: string[] = [];
    const hit = resolveSignatureInText('CALL F(A, B)', 1, 10, protocol(SLOTS, (n) => seen.push(n)), () => [
      { name: '兜底' },
    ]);
    expect(hit!.signature.parameters[0]).toBe('ARG:3 事件子参数'); // 协议槽，不是 ERB 形参
  });

  it('ERB 形参回调抛错 ⇒ null（不让提示崩）', () => {
    expect(
      resolveSignatureInText('CALL F(A, B)', 1, 10, undefined, () => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });

  it('非法行 / 列 ⇒ null（不抛）', () => {
    expect(resolveSignatureInText('CALL F(A)', 0, 5, protocol(SLOTS))).toBeNull();
    expect(resolveSignatureInText('CALL F(A)', 1, 0, protocol(SLOTS))).toBeNull();
  });
});

describe('describeErbSignature · ERB 用户函数签名', () => {
  it('label 逐字包含每个形参名（Monaco 正则定位高亮的硬口径）；activeParameter 夹取', () => {
    const signature = describeErbSignature('MY_FUNC', [{ name: 'ARG' }, { name: 'ARGS:1' }], 99);
    expect(signature.label).toBe('MY_FUNC(ARG, ARGS:1)');
    for (const p of signature.parameters) expect(signature.label).toContain(p);
    expect(signature.activeParameter).toBe(1);
    expect(describeErbSignature('F', [], 0)).toEqual({ label: 'F()', parameters: [], activeParameter: 0 });
  });
});

/* ============================== Monaco 装配（桩 monaco） ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.SignatureHelpProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[]; disposed: string[] } {
  const registered: Registered[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerSignatureHelpProvider: (
        languageId: string,
        provider: Monaco.languages.SignatureHelpProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => disposed.push(languageId) };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, disposed };
}

const lineModel = (text: string) =>
  ({ getLineContent: () => text }) as unknown as Monaco.editor.ITextModel;
const at = (column: number) => ({ lineNumber: 3, column }) as Monaco.Position;

describe('installSignatureHelp · 装配', () => {
  it('ERB 与 `.kojo` 两个语言 id 各注册一枚 provider；dispose 全部回收', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installSignatureHelp(monaco, { resolve: () => null });
    expect(registered.map((r) => r.languageId).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    handle.dispose();
    expect(disposed.sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
  });

  it('触发字符：`(` 进入调用括号、`,` 与 `，` 换槽（全角逗号是口上的真形态）', () => {
    expect(SIGNATURE_TRIGGER_CHARACTERS).toEqual(['(', ',', '，']);
    const { monaco, registered } = stubMonaco();
    installSignatureHelp(monaco, { resolve: () => null });
    expect(registered[0]!.provider.signatureHelpTriggerCharacters).toEqual(['(', ',', '，']);
  });

  it('有签名：返回 `{ value, dispose }`（Monaco 会调 `dispose()`，缺了它就是运行时 TypeError）', () => {
    const { monaco, registered } = stubMonaco();
    installSignatureHelp(monaco, {
      resolve: (model, position) => resolveSignature(model.getLineContent(position.lineNumber), position.column, protocol(SLOTS)),
    });
    const result = registered[0]!.provider.provideSignatureHelp(
      lineModel('F(A, B)'),
      at(7),
      {} as Monaco.CancellationToken,
      {} as Monaco.languages.SignatureHelpContext,
    );
    expect(result).toBeTruthy();
    const help = result as Monaco.languages.SignatureHelpResult;
    expect(() => help.dispose()).not.toThrow();
    expect(help.value).toEqual({
      signatures: [
        {
          label: 'F(ARG:3 事件子参数, ARG:4 日期偏移, ARGS:1 发言文本)',
          parameters: [{ label: 'ARG:3 事件子参数' }, { label: 'ARG:4 日期偏移' }, { label: 'ARGS:1 发言文本' }],
        },
      ],
      activeSignature: 0,
      activeParameter: 1, // 光标停在第 2 个实参的末尾（`F(A, B|)`）
    });
  });

  it('不应答返回 undefined（**不返回空 help**：那会把这条能力占住又显示不出东西）', () => {
    const { monaco, registered } = stubMonaco();
    installSignatureHelp(monaco, { resolve: () => null });
    expect(
      registered[0]!.provider.provideSignatureHelp(
        lineModel('F(A, B)'),
        at(7),
        {} as Monaco.CancellationToken,
        {} as Monaco.languages.SignatureHelpContext,
      ),
    ).toBeUndefined();
  });

  it('宿主 resolve 抛错 → 不崩、不应答', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installSignatureHelp(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    expect(() =>
      registered[0]!.provider.provideSignatureHelp(
        lineModel('F(A, B)'),
        at(7),
        {} as Monaco.CancellationToken,
        {} as Monaco.languages.SignatureHelpContext,
      ),
    ).not.toThrow();
    warn.mockRestore();
  });

  it('协议翻译：一张签名、activeSignature 恒 0、参数只带 label', () => {
    const monacoHelp = toMonacoSignatureHelp({
      callee: 'F',
      signature: describeCallSignature('F', SLOTS, 1),
    });
    expect(monacoHelp.activeSignature).toBe(0);
    expect(monacoHelp.activeParameter).toBe(1);
    expect(monacoHelp.signatures).toHaveLength(1);
    expect(monacoHelp.signatures[0]!.parameters[1]).toEqual({ label: 'ARG:4 日期偏移' });
  });
});
