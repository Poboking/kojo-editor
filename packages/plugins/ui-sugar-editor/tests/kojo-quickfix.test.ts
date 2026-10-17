/**
 * `.kojo` 快速修复（W3）的**纯逻辑**验收：规则收敛、身份键、自证、越界。
 *
 * 这里刻意**不启动转译器**：`decorate` 由测试自己给（一枚可编程的替身），为的是把
 * "本模块只做接线与自证、不自己判语法"这条纪律钉住——替身能编排出"改完红线没消失"
 * 这种真转译器很难按需造出来的局面。与真实 `sugar.transpile` 的端到端接线在
 * `quickfix-integration.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import type { LineDecoration } from '@kojo/plugin-api';
import {
  DEFAULT_VERIFY_BUDGET,
  QUICKFIX_SUGAR_CODES,
  buildSugarQuickFixes,
  decorationKey,
  functionDeclAnchor,
  type DocumentBlockLocation,
} from '../src/kojo-quickfix';

/* ------------------------------ 夹具 ------------------------------ */

const stray = (line: number, message = '文本里出现落单的半角 `%`。'): LineDecoration => ({
  line,
  severity: 'warning',
  message,
  startColumn: 1,
  code: 'stray-percent',
});

const typo = (line: number, written: string, near: string): LineDecoration => ({
  line,
  severity: 'error',
  message:
    `「${written}(…)」既不在系统函数表、也不在当前工程的基础库函数表里，而两张表里只有一个相近名「${near}」` +
    `（原生名 X）——这多半是把「${near}」拼错了。请改成「${near}(…)」。`,
  startColumn: 1,
  code: 'function-name-typo',
});

/**
 * 替身"转译器"：只对夹具里那两种文本产诊断（规则 = 本测试自己定义的一份判据）。
 *
 * - 一行里恰好一个半角 `%` ⇒ `stray-percent`；
 * - 一行里出现「拼错的名字(」⇒ `function-name-typo`（写死在 `TYPO` 表里）。
 */
const TYPO = new Map<string, string>([['最大直', '最大值']]);

function fakeDecorate(source: string): LineDecoration[] {
  const out: LineDecoration[] = [];
  source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .forEach(({ line, n }) => {
      if (line.split('%').length === 2) out.push(stray(n));
      for (const [wrong, right] of TYPO) {
        if (line.includes(`${wrong}(`)) out.push(typo(n, wrong, right));
      }
    });
  return out;
}

const SRC = ['角色: 1', '时机 初见：', '    你好 50% 吧。', '    她笑了。', ''].join('\n');

/* ------------------------------ 一、闭集与准入 ------------------------------ */

describe('kojo-quickfix · 判据闭集', () => {
  it('收敛的码只有三条（要补内容 / 要查字典 / 要挪行的一律不做；unknown 走登记动作）', () => {
    expect(QUICKFIX_SUGAR_CODES).toEqual(['stray-percent', 'function-name-typo', 'function-name-unknown']);
  });

  it('宿主没点明波浪线 ⇒ 一条不产（不凭空造 quickfix）', () => {
    expect(buildSugarQuickFixes({ text: SRC, diagnostics: [], decorate: fakeDecorate })).toEqual([]);
  });

  it('不在闭集里的码一律不应答（哪怕它确实是条红线）', () => {
    const other: LineDecoration = {
      line: 3,
      severity: 'error',
      message: '「续」写在了引号内。',
      code: 'cont-inside-quotes',
    };
    expect(buildSugarQuickFixes({ text: SRC, diagnostics: [other], decorate: fakeDecorate })).toEqual([]);
  });

  it('闭集内但**本行判据不收敛**（一行两个半角 %）⇒ 不产动作', () => {
    const text = '    甲 1% 乙 2% 丙\n';
    const d = stray(1, '文本里出现落单的半角 `%`。');
    // 替身按"恰好一个 %"产诊断 ⇒ 这条红线本就与两个 % 的文本不符：走"陈旧/别家"那条准入
    const actions = buildSugarQuickFixes({ text, diagnostics: [d], decorate: () => [d] });
    expect(actions).toEqual([]);
  });

  it('递进来的波浪线在当前文本里复现不出来（陈旧行号 / 别家装饰器）⇒ 不应答', () => {
    const stale = { ...stray(99), line: 99 };
    expect(buildSugarQuickFixes({ text: SRC, diagnostics: [stale], decorate: fakeDecorate })).toEqual([]);
    // 行号合法但消息不是本文件此刻的那一条 ⇒ 身份键对不上，同样不应答
    const drifted = stray(3, '不是当前文本里的那句话');
    expect(buildSugarQuickFixes({ text: SRC, diagnostics: [drifted], decorate: fakeDecorate })).toEqual([]);
  });
});

/* ------------------------------ 二、身份键（B9 的成败） ------------------------------ */

describe('kojo-quickfix · 关联诊断的身份键', () => {
  it('动作的 diagnostics 就是宿主递进来的**那一个对象**（同行同 code 同 message 同 severity）', () => {
    const given = stray(3);
    const actions = buildSugarQuickFixes({ text: SRC, diagnostics: [given], decorate: fakeDecorate });
    expect(actions).toHaveLength(1);
    const linked = actions[0]!.diagnostics!;
    expect(linked).toHaveLength(1);
    expect(linked[0]).toBe(given); // **同一个引用**：一个字段都没重建
    expect(decorationKey(linked[0]!)).toBe(decorationKey(given));
    expect(linked[0]!.line).toBe(given.line);
    expect(linked[0]!.code).toBe(given.code);
    expect(linked[0]!.message).toBe(given.message);
    expect(linked[0]!.severity).toBe(given.severity);
  });

  it('身份键刻意不含列（列在 marker ↔ 装饰 双向翻译里未必逐字相等）', () => {
    const a = { line: 3, severity: 'warning' as const, message: 'm', code: 'stray-percent', startColumn: 1 };
    const b = { ...a, startColumn: 8, endColumn: 12 };
    expect(decorationKey(a)).toBe(decorationKey(b));
    expect(decorationKey({ ...a, message: 'x' })).not.toBe(decorationKey(a));
    expect(decorationKey({ ...a, code: undefined })).not.toBe(decorationKey(a));
  });

  it('每条动作类别都是 quickfix（不是 refactor——refactor 修不了红线）', () => {
    const actions = buildSugarQuickFixes({ text: SRC, diagnostics: [stray(3)], decorate: fakeDecorate });
    expect(actions.every((a) => a.kind === 'quickfix')).toBe(true);
    expect(actions.every((a) => typeof a.run === 'function')).toBe(true);
  });
});

/* ------------------------------ 三、改写内容 ------------------------------ */

describe('kojo-quickfix · 行级改写', () => {
  it('stray-percent：半角 % → 全角 ％，整行其余逐字不变', () => {
    const actions = buildSugarQuickFixes({ text: SRC, diagnostics: [stray(3)], decorate: fakeDecorate });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toEqual([{ fromLine: 3, toLine: 3, newText: '    你好 50％ 吧。' }]);
    expect(actions[0]!.title).toContain('％');
  });

  it('function-name-typo：只把那一处调用名换成文案点名的唯一近名', () => {
    const text = ['角色: 1', '时机 初见：', '    调用 最大直(1, 2)', ''].join('\n');
    const actions = buildSugarQuickFixes({ text, diagnostics: [typo(3, '最大直', '最大值')], decorate: fakeDecorate });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toEqual([{ fromLine: 3, toLine: 3, newText: '    调用 最大值(1, 2)' }]);
  });

  it('function-name-typo：同一行两处同样写法 ⇒ 落点不唯一 ⇒ 不动手', () => {
    const text = '    调用 最大直(1) + 最大直(2)\n';
    const d = typo(1, '最大直', '最大值');
    const actions = buildSugarQuickFixes({ text, diagnostics: [d], decorate: () => [d] });
    expect(actions).toEqual([]);
  });

  it('function-name-typo：文案措辞对不上（取不到写错的名 / 唯一近名）⇒ 一条都不给', () => {
    const text = '    调用 最大直(1)\n';
    const d: LineDecoration = {
      line: 1,
      severity: 'error',
      message: '这条文案换了措辞，没有把改法说出口。',
      code: 'function-name-typo',
    };
    expect(buildSugarQuickFixes({ text, diagnostics: [d], decorate: () => [d] })).toEqual([]);
  });

  it('CRLF 文本：行尾 \\r 原样带回（quickfix 不顺手改换行风格）', () => {
    const text = ['角色: 1', '    你好 50% 吧。', ''].join('\r\n');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [{ ...stray(2), message: '文本里出现落单的半角 `%`。' }],
      decorate: (s) => fakeDecorate(s.replace(/\r\n/g, '\n')),
    });
    expect(actions[0]!.edits![0]!.newText).toBe('    你好 50％ 吧。\r');
  });

  it('编辑不越界：每条 edit 的 fromLine/toLine 都落在 [1, 行数] 且是整行替换', () => {
    const text = ['角色: 1', '    甲 1% 乙。', '    你好 50% 吧。', ''].join('\n');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [stray(2), stray(3)],
      decorate: fakeDecorate,
    });
    const lineCount = text.split('\n').length;
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      for (const edit of action.edits!) {
        expect(edit.fromLine).toBe(edit.toLine);
        expect(edit.fromLine).toBeGreaterThanOrEqual(1);
        expect(edit.toLine).toBeLessThanOrEqual(lineCount);
      }
    }
  });
});

/* ------------------------------ 四、自证（不猜的落地） ------------------------------ */

describe('kojo-quickfix · 代回转译器的自证', () => {
  it('改完那条红线还在 ⇒ 不交付（绝不让 💡 里躺着修不动的动作）', () => {
    const actions = buildSugarQuickFixes({
      text: SRC,
      diagnostics: [stray(3)],
      // 替身判定"改不改都报"——正是那种会把"看着像修法"的动作交出去的情形
      decorate: (source) => (source === SRC ? fakeDecorate(source) : [stray(3)]),
    });
    expect(actions).toEqual([]);
  });

  it('改完**多出**一条新的波浪线 ⇒ 不交付（修一条别赔一条）', () => {
    const extra: LineDecoration = {
      line: 4,
      severity: 'error',
      message: '凭空多出来的新红',
      code: 'block-empty',
    };
    const actions = buildSugarQuickFixes({
      text: SRC,
      diagnostics: [stray(3)],
      decorate: (source) => (source === SRC ? fakeDecorate(source) : [...fakeDecorate(source), extra]),
    });
    expect(actions).toEqual([]);
  });

  it('自证会**代回** decorate：先当前文本作基准，再喂改写后的那份', () => {
    const seen: string[] = [];
    buildSugarQuickFixes({
      text: SRC,
      diagnostics: [stray(3)],
      decorate: (source) => {
        seen.push(source);
        return fakeDecorate(source);
      },
    });
    expect(seen[0]).toBe(SRC); // 基准 = 当前文本（通常命中转译缓存）
    expect(seen[1]).toContain('50％'); // 第二个输入 = 改写后的文本
  });

  it('没有可修的红线时**一次转译都不跑**（💡 可用性探测由 Monaco 自动触发，代价必须 ≈ 0）', () => {
    let calls = 0;
    const counting = (source: string): LineDecoration[] => {
      calls++;
      return fakeDecorate(source);
    };
    // ① 宿主没给波浪线
    expect(buildSugarQuickFixes({ text: SRC, diagnostics: [], decorate: counting })).toEqual([]);
    // ② 给了，但全是闭集外的码
    expect(
      buildSugarQuickFixes({
        text: SRC,
        decorate: counting,
        diagnostics: [{ line: 3, severity: 'error', message: '块没有正文', code: 'block-empty' }],
      }),
    ).toEqual([]);
    // ③ 闭集内的码，但那一行的判据不收敛（两个半角 %）
    expect(
      buildSugarQuickFixes({
        text: '甲 1% 乙 2%\n',
        decorate: counting,
        diagnostics: [{ line: 1, severity: 'warning', message: '落单的 %', code: 'stray-percent' }],
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it('预算用满即停，并**可见退化**（铁律 4：不静默少给）', () => {
    const text = Array.from({ length: 6 }, (_, i) => `第 ${i} 行 50% 吧。`).join('\n');
    const diags = text.split('\n').map((_, i) => stray(i + 1));
    const warns: string[] = [];
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: diags,
      decorate: fakeDecorate,
      verifyBudget: 2,
      onDegrade: (m) => warns.push(m),
    });
    expect(actions).toHaveLength(2);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('预算');
  });

  it('缺省预算是个正数（0/负数 = 关掉自证 ⇒ 一条不产）', () => {
    expect(DEFAULT_VERIFY_BUDGET).toBeGreaterThan(0);
    expect(
      buildSugarQuickFixes({ text: SRC, diagnostics: [stray(3)], decorate: fakeDecorate, verifyBudget: 0 }),
    ).toEqual([]);
  });

  it('纯函数：同输入两次调用逐字节一致，且不改动传入的诊断对象', () => {
    const given = stray(3);
    const snapshot = JSON.stringify(given);
    const a = buildSugarQuickFixes({ text: SRC, diagnostics: [given], decorate: fakeDecorate });
    const b = buildSugarQuickFixes({ text: SRC, diagnostics: [given], decorate: fakeDecorate });
    // 逐字节比 `JSON.stringify`（`run` 是每次新建的闭包，`toEqual` 按引用比函数会假红）
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(given)).toBe(snapshot);
  });
});

/* ------------------------------ 五、登记动作（ZH-F2：一键加入名表） ------------------------------ */

const unknown = (line: number, name: string): LineDecoration => ({
  line,
  severity: 'warning',
  message: `「${name}」是中文函数名调用形态，但既不在系统函数表、也不在当前工程的基础库函数表里——该调用已原样写进产物。`,
  startColumn: 1,
  code: 'function-name-unknown',
});

/** 替身二额外认得 `函数 <名>…：` 声明行（第 0 列）：声明过的关注名不再报（模拟 per-file 名表合并生效） */
const WATCH = ['呓语未登录', '自定甲', '自定乙', '最大直'];

function fakeWithDecl(source: string): LineDecoration[] {
  const declared = new Set<string>();
  const ls = source.split('\n');
  for (const l of ls) {
    const m = /^函数 ([^（(：:\s]+)/.exec(l);
    if (m !== null && WATCH.includes(m[1]!)) declared.add(m[1]!);
  }
  const out: LineDecoration[] = [];
  ls.forEach((l, i) => {
    const indented = /^\s/.test(l);
    if (!indented) return;
    for (const [wrong, right] of TYPO)
      if (!declared.has(wrong) && l.includes(`${wrong}(`)) out.push(typo(i + 1, wrong, right));
    for (const w of WATCH) if (!declared.has(w) && l.includes(`${w}(`)) out.push(unknown(i + 1, w));
  });
  return out;
}

const doc = (nodes: readonly (readonly [string, number, number])[]): DocumentBlockLocation[] =>
  nodes.map(([kind, start, end]) => ({ kind, loc: { start: { line: start }, end: { line: end } } }));

const SRC_UNKNOWN = ['角色: 1', '时机 初见：', '    台词 {呓语未登录(7)}。', ''].join('\n');
const DOC_UNKNOWN = () => doc([['timingBlock', 2, 3]]);

describe('kojo-quickfix · 登记动作（function-name-unknown → 函数声明）', () => {
  it('unknown：产一条 quickfix，edits = 在第一个时机块之前插入 `函数 <名>(形参…)：`（形参数取自被诊断那行的调用）', () => {
    const actions = buildSugarQuickFixes({
      text: SRC_UNKNOWN,
      diagnostics: [unknown(3, '呓语未登录')],
      decorate: fakeWithDecl,
      topLevelOf: DOC_UNKNOWN,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('quickfix');
    expect(actions[0]!.title).toContain('登记');
    expect(actions[0]!.edits).toEqual([
      { fromLine: 2, toLine: 2, newText: '函数 呓语未登录(引数1)：\n时机 初见：' },
    ]);
  });

  it('实参两个 → 声明两个形参；行内没有配对的括号闭合 → 无参声明（名字登记不受影响）', () => {
    const text = ['角色: 1', '时机 初见：', '    调用 自定甲(她的, 3)', ''].join('\n');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [unknown(3, '自定甲')],
      decorate: fakeWithDecl,
      topLevelOf: () => doc([['timingBlock', 2, 3]]),
    });
    expect(actions[0]!.edits![0]!.newText).toBe('函数 自定甲(引数1, 引数2)：\n时机 初见：');
    const broken = ['角色: 1', '时机 初见：', '    调用 自定甲(她的,', '    3)', ''].join('\n');
    const a2 = buildSugarQuickFixes({
      text: broken,
      diagnostics: [unknown(3, '自定甲')],
      decorate: fakeWithDecl,
      topLevelOf: () => doc([['timingBlock', 2, 4]]),
    });
    expect(a2[0]!.edits![0]!.newText).toBe('函数 自定甲：\n时机 初见：');
  });

  it('已有「函数」块 ⇒ 落点 = 最后一块之后（声明聚堆）；否则取最早落点（时机 / 自定指令 / 原生 @ 块之前）', () => {
    const text = ['角色: 1', '函数 开场()：', '    「开始。」', '时机 初见：', '    调用 自定乙(1)', ''].join('\n');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [unknown(5, '自定乙')],
      decorate: fakeWithDecl,
      topLevelOf: () => doc([['functionBlock', 2, 3], ['timingBlock', 4, 5]]),
    });
    expect(actions[0]!.edits).toEqual([{ fromLine: 4, toLine: 4, newText: '函数 自定乙(引数1)：\n时机 初见：' }]);
    // @ 块会吞掉其后所有行：落点必须在它**之前**（`functionDeclAnchor` 的判据在此钉死）
    expect(functionDeclAnchor(doc([['rawFunctionBlock', 2, 9]]), 10)).toBe(2);
    expect(functionDeclAnchor(doc([['timingBlock', 3, 8], ['functionBlock', 4, 5]]), 10)).toBe(3);
    expect(functionDeclAnchor(doc([]), 10)).toBeNull(); // 没有文档级块 ⇒ 没有可靠落点 ⇒ 不出动作
  });

  it('接线没给 `topLevelOf` ⇒ 登记动作整类不产（旧调用方逐字保持），行级改写照旧', () => {
    const text = SRC_UNKNOWN;
    expect(
      buildSugarQuickFixes({ text, diagnostics: [unknown(3, '呓语未登录')], decorate: fakeWithDecl }),
    ).toEqual([]);
  });

  it('self-check 拒绝"登记了但没登记上"：目标那条只是跟着行号下移 ⇒ 不交付（不混过漂移这一关）', () => {
    const stubborn = (source: string): LineDecoration[] =>
      source === SRC_UNKNOWN ? fakeWithDecl(source) : [unknown(4, '呓语未登录')];
    const actions = buildSugarQuickFixes({
      text: SRC_UNKNOWN,
      diagnostics: [unknown(3, '呓语未登录')],
      decorate: stubborn,
      topLevelOf: DOC_UNKNOWN,
    });
    expect(actions).toEqual([]);
  });

  it('两条 unknown 同在：登记其中一条，另一条**下移后的波浪线不算新增**（漂移基准）', () => {
    const text = ['角色: 1', '时机 初见：', '    台词 {呓语未登录(1)}。', '    调用 自定乙(2)', ''].join('\n');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [unknown(3, '呓语未登录'), unknown(4, '自定乙')],
      decorate: fakeWithDecl,
      topLevelOf: () => doc([['timingBlock', 2, 4]]),
    });
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.edits![0]!.fromLine === 2)).toBe(true); // 同锚点：宿主「全部修复」按轮排开
  });

  it('typo：改近名与登记**两条并存**（"我要的确实是这个名字"那一支），都挂同一条诊断', () => {
    const text = ['角色: 1', '时机 初见：', '    调用 最大直(1, 2)', ''].join('\n');
    const d = typo(3, '最大直', '最大值');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [d],
      decorate: fakeWithDecl,
      topLevelOf: () => doc([['timingBlock', 2, 3]]),
    });
    expect(actions.map((a) => a.kind)).toEqual(['quickfix', 'quickfix']);
    expect(actions.map((a) => a.title).join(' ')).toContain('改成');
    expect(actions.map((a) => a.title).join(' ')).toContain('登记');
    const reg = actions.find((a) => a.title.includes('登记'))!;
    expect(reg.edits![0]!.newText).toBe('函数 最大直(引数1, 引数2)：\n时机 初见：');
    expect(reg.diagnostics![0]).toBe(d); // 原样回递**同一个对象**（B9 身份键）
  });

  it('登记动作也走闭集文案闸：对不上措辞（取不到名字）⇒ 不产', () => {
    const d: LineDecoration = { line: 3, severity: 'warning', message: '这句文案换措辞了。', code: 'function-name-unknown' };
    expect(
      buildSugarQuickFixes({
        text: SRC_UNKNOWN,
        diagnostics: [d],
        decorate: fakeWithDecl,
        topLevelOf: DOC_UNKNOWN,
      }),
    ).toEqual([]);
  });

  it('CRLF 文档：插入块沿用 \\r\\n，锚行原文（含 \\r）整条带走', () => {
    const text = ['角色: 1', '时机 初见：', '    台词 {呓语未登录(7)}。', ''].join('\r\n');
    const actions = buildSugarQuickFixes({
      text,
      diagnostics: [unknown(3, '呓语未登录')],
      decorate: (s) => fakeWithDecl(s.replace(/\r\n/g, '\n')),
      topLevelOf: DOC_UNKNOWN,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits![0]!.newText).toBe('函数 呓语未登录(引数1)：\r\n时机 初见：\r');
  });
});
