/**
 * W1/W2 语言重构 · **编辑器作者面**回归（新正典表面：方寸声明 / 冒号动作 / 若-否则 / 演调用 /
 * 裸行旁白 / `※` 注释；W2：`【定】`/`【设】`、`数`/`文字`、`下一轮`/`跳出循环`）。
 *
 * 覆盖：
 * - **Monarch 词法面**：新表面逐词 token 化（方寸 > 条件 > 冒号动作 > 旧锚点），旧五锚点不回退；
 * - **补全 / snippets**：新正典模板在前、旧写法保留并标注（`completion.test.ts` 另有一组全量断言）；
 * - **formatter**：不破坏新表面、幂等、语义 token 不变（只动缩进 / 空行 / 行尾空白）；
 * - **hover / 符号 / 签名 / 同符号高亮**：新词能读出与旧词同义的一句话说明，方寸声明进大纲。
 *
 * 判据来源：`docs/KOJO-2.0-LANGUAGE-REDESIGN.md` §2 / §8.3；core 侧行为见
 * `packages/kojo-core/tests/language-redesign-w1.test.ts` / `-w2.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { lex, parseSource } from '@kojo/kojo-core';
import { KOJO2_MONARCH, KOJO2_TOKEN } from '../src/monarch';
import {
  KOJO2_CANONICAL_ELSE_IF_WORD,
  KOJO2_CANONICAL_ELSE_WORD,
  KOJO2_CANONICAL_IF_WORD,
  KOJO2_DISPATCH_WORDS,
  KOJO2_LOOP_CONTROL_CANONICAL_WORDS,
} from '../src/lexicon';
import { formatKojo2Source } from '../src/format';
import { kojo2HoverAt } from '../src/hover';
import { kojo2DocumentSymbols, kojo2SymbolPathAt } from '../src/symbols';
import { kojo2SignatureAt } from '../src/signature';
import { kojo2DocumentHighlights } from '../src/highlight';
import { KOJO2_DECL_WORD_BY_KIND } from '../src/declarations';

/* ============================== 测试夹具（一份真实新正典文件） ============================== */

/** 一份应当 **parse 零 error** 的新正典样例（下面多条腿共用同一份源事实）。 */
const SAMPLE = [
  '【幕 神社清晨】',
  '【视角 灵梦】',
  '【挂 指令 310】',
  '',
  '【定 亲近线 数 = 500】',
  '【设 计数 数 = 0 存档】',
  '',
  '※ 这是整行注释',
  '',
  '晨光透过鸟居，斑驳地洒在石阶上。',
  '灵梦：「{你}今天来得挺早嘛。」',
  '',
  '若 计数 >= 亲近线：',
  '    灵梦：「其实我一直在等你。」',
  '再若 计数 >= 100：',
  '    灵梦：「早上好。」',
  '否则：',
  '    灵梦：「……早。」',
  '',
  '算：',
  '    计数 = 计数 + 1',
  '',
  '【池 早安问候】',
  '    若 计数 < 100：',
  '        「……早。」',
  '    否则：',
  '        「早上好。」',
  '',
  '【函 增加羁绊(目标, 数值 = 10)】',
  '    @返 数值',
  '',
  '【模 娇羞退场(原因)】',
  '    > （她红着脸）',
  '',
  '演：早安问候',
  '',
  '循环：计数 < 3',
  '    计数 += 1',
  '    下一轮',
  '    跳出循环',
  '',
].join('\n');

const SAMPLE_LINES = SAMPLE.split('\n');

/** 某一行文本（1 基）。 */
function lineOf(line: number): string {
  return SAMPLE_LINES[line - 1] ?? '';
}

/** 第一行满足条件（1 基；找不到 ⇒ 夹具写错就当场红）。 */
function findLine(pred: (text: string) => boolean): number {
  const index = SAMPLE_LINES.findIndex(pred);
  if (index < 0) throw new Error('夹具里找不到目标行');
  return index + 1;
}

/** 以某段文本开头的第一行（1 基）。 */
function lineStarting(prefix: string): number {
  return findLine((text) => text.startsWith(prefix));
}

/** 恰好等于某段文本的第一行（1 基）。 */
function lineExact(text: string): number {
  return findLine((line) => line === text);
}

/** 某行里某段文本的首列（1 基）；找不到 ⇒ 失败（夹具写错就当场红）。 */
function columnOf(line: number, needle: string): number {
  const at = lineOf(line).indexOf(needle);
  if (at < 0) throw new Error(`第 ${line} 行找不到「${needle}」：${lineOf(line)}`);
  return at + 1;
}

/** 任意源里某行某段的首列（1 基）。 */
function columnOfIn(source: string, line: number, needle: string): number {
  const text = source.split('\n')[line - 1] ?? '';
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`第 ${line} 行找不到「${needle}」：${text}`);
  return at + 1;
}

/* ============================== Monarch 最小驱动器 ============================== */

interface Emitted {
  readonly text: string;
  readonly token: string;
}

type MonarchAction =
  | string
  | {
      readonly token?: string;
      readonly next?: string;
      readonly cases?: Readonly<Record<string, MonarchAction>>;
    }
  | readonly MonarchAction[];

type MonarchRule = readonly [RegExp | string, MonarchAction];

interface MonarchDef {
  readonly wordLists: Readonly<Record<string, readonly string[]>>;
  readonly tokenizer: Readonly<Record<string, readonly MonarchRule[]>>;
}

/**
 * 根状态驱动（**只够本文件用**：根态单行，不追状态栈）。
 *
 * 语义与仓内 `app/tests/monarch-harness.ts` 的真编译驱动器一致的最小集：列表序首个命中、
 * `^` 只许行首、群组逐子段发射、空子段免发射、`@wordList` cases 卫兵逐档判词。
 * 真编译 + 跨行态的守卫在宿主测试里（本包不引 monaco-editor，purity 闸钉住）。
 */
function tokenizeRoot(line: string): Emitted[] {
  const def = KOJO2_MONARCH as unknown as MonarchDef;
  const rules = def.tokenizer.root ?? [];
  const out: Emitted[] = [];
  let pos = 0;
  let steps = 0;
  while (pos < line.length) {
    if (++steps > line.length * 4 + 64) throw new Error(`驱动器无进展：${line}`);
    const rest = line.slice(pos);
    let hit: { readonly length: number; readonly emits: Emitted[] } | null = null;
    for (const [pattern, action] of rules) {
      if (typeof pattern === 'string') continue; // 本 def 的根态没有字符串规则
      if (pos !== 0 && pattern.source.startsWith('^')) continue;
      // 真 Monarch 的规则**一律锚在当前位置**（`^` 只是额外的"仅行首"限制）；正则字面量没写
      // `^` 时要自己补成 `^(?:…)`——直接用 exec 找"后面某处"，会把收口 `】` 从行尾捞出来。
      const anchoredSource = pattern.source.startsWith('^')
        ? pattern.source
        : `^(?:${pattern.source})`;
      const flags = pattern.flags.replace(/[gy]/g, '');
      const match = new RegExp(anchoredSource, flags).exec(rest);
      if (match === null) continue;
      hit = { length: match[0].length, emits: resolveAction(def, action, match, match[0]) };
      break;
    }
    if (hit === null) {
      pos += 1; // 无规则命中 = 一字符、零 token（与 Monarch defaultToken 同义）
      continue;
    }
    for (const emit of hit.emits) if (emit.text.length > 0) out.push(emit);
    pos += hit.length;
  }
  return out;
}

function resolveAction(
  def: MonarchDef,
  action: MonarchAction,
  match: RegExpExecArray,
  matched: string,
): Emitted[] {
  if (typeof action === 'string') {
    return action === '' ? [] : [{ text: matched, token: action }];
  }
  if (Array.isArray(action)) {
    const out: Emitted[] = [];
    for (let i = 0; i < action.length; i++) {
      const piece = match[i + 1] ?? '';
      const token = resolveToken(def, action[i], piece);
      if (piece.length > 0 && token !== '') out.push({ text: piece, token });
    }
    return out;
  }
  const token = resolveToken(def, action, matched);
  return token === '' ? [] : [{ text: matched, token }];
}

function isActionArray(action: MonarchAction): action is readonly MonarchAction[] {
  return Array.isArray(action);
}

function resolveToken(def: MonarchDef, action: MonarchAction, word: string): string {
  if (typeof action === 'string') return action;
  if (isActionArray(action)) return ''; // 嵌套群组不用于本 def 的根态判据
  if (action.cases !== undefined) {
    for (const [key, sub] of Object.entries(action.cases)) {
      if (!key.startsWith('@') || key === '@default') continue;
      const list = def.wordLists[key.slice(1)] ?? [];
      if (list.includes(word)) return resolveToken(def, sub, word);
    }
    const fallback = action.cases['@default'];
    return fallback === undefined ? '' : resolveToken(def, fallback, word);
  }
  return action.token ?? '';
}

/** 某段文本在该行里发出的 token（取第一次出现；没有 ⇒ 失败）。 */
function tokenOf(line: string, text: string): string {
  const found = tokenizeRoot(line).find((emit) => emit.text === text);
  if (found === undefined) {
    throw new Error(
      `「${line}」里没有为「${text}」发出 token：${JSON.stringify(tokenizeRoot(line))}`,
    );
  }
  return found.token;
}

/** 该行是否**没有**任何 token 等于给定档（用于"旁白不该被染成条件词"的反证）。 */
function hasToken(line: string, token: string): boolean {
  return tokenizeRoot(line).some((emit) => emit.token === token);
}

/* ============================== ① Monarch：新表面逐词 token 化 ============================== */

describe('W1/W2 Monarch：新正典表面着色', () => {
  it('方寸声明 `【…】`：括号 anchor、方寸词 declaration（含别名 `挂` / `定`）', () => {
    expect(tokenOf('【幕 神社清晨】', '【')).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('【幕 神社清晨】', '幕')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('【幕 神社清晨】', '】')).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('【挂 指令 310】', '挂')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('【定 亲近线 数 = 500】', '定')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('【设 计数 数 = 0 存档】', '设')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('【函 增加羁绊(目标)】', '函')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('【织 回合末 之后】', '织')).toBe(KOJO2_TOKEN.declaration);
  });

  it('方寸行体：类型词正典 `数` / `文字` 走类型档，收口 `】` 仍是 anchor', () => {
    expect(tokenOf('【设 计数 数 = 0 存档】', '数')).toBe(KOJO2_TOKEN.type);
    expect(tokenOf('【设 称呼 文字 = "灵梦"】', '文字')).toBe(KOJO2_TOKEN.type);
    expect(tokenOf('【设 计数 数 = 0 存档】', '】')).toBe(KOJO2_TOKEN.anchor);
  });

  it('条件族 `若/再若/否则` 是条件词（收口 `：` 是 delimiter）', () => {
    expect(tokenOf('若 计数 >= 亲近线：', KOJO2_CANONICAL_IF_WORD)).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('再若 计数 >= 100：', KOJO2_CANONICAL_ELSE_IF_WORD)).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('否则：', KOJO2_CANONICAL_ELSE_WORD)).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('若 计数 >= 亲近线：', '：')).toBe(KOJO2_TOKEN.delimiter);
  });

  it('旁白里以「若」开头但不收口 `：` ⇒ 不误染成条件词（`若你愿意，就留下来吧。`）', () => {
    expect(hasToken('若你愿意，就留下来吧。', KOJO2_TOKEN.anchor)).toBe(false);
  });

  it('冒号动作族：动作词 declaration + 冒号 delimiter；参数照常着色（hex / 数字）', () => {
    for (const surface of [
      '算',
      '色',
      '颜绘',
      '择一',
      '组',
      '循环',
      '重复',
      '遍历',
      '标',
      '跳',
    ]) {
      expect(tokenOf(`${surface}：`, surface), surface).toBe(KOJO2_TOKEN.declaration);
      expect(tokenOf(`${surface}：`, '：'), surface).toBe(KOJO2_TOKEN.delimiter);
    }
    expect(tokenOf('色：0xFF8080', '0xFF8080')).toBe(KOJO2_TOKEN.hex);
    expect(tokenOf('循环：计数 < 3', '3')).toBe(KOJO2_TOKEN.number);
  });

  it('`演：名字` 是被调名 declaration（与旧 `! 名字` 同档）', () => {
    expect(tokenOf('演：早安问候', '演')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('演：早安问候', '早安问候')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('! 早安问候', '早安问候')).toBe(KOJO2_TOKEN.declaration);
  });

  it('独立成行的循环控制 `下一轮` / `跳出循环`（W2）与 `断` / `续`（W1 兼容）走调度词档', () => {
    for (const word of KOJO2_LOOP_CONTROL_CANONICAL_WORDS) {
      expect(tokenOf(word, word), word).toBe(KOJO2_TOKEN.declaration);
    }
    for (const word of [KOJO2_DISPATCH_WORDS[13] ?? '', KOJO2_DISPATCH_WORDS[14] ?? '']) {
      expect(tokenOf(word, word), word).toBe(KOJO2_TOKEN.declaration);
    }
  });

  it('`※` 整行注释走注释档；`//` 兼容不变', () => {
    expect(tokenOf('※ 这是整行注释', '※ 这是整行注释')).toBe(KOJO2_TOKEN.comment);
    expect(tokenOf('// 注释', '// 注释')).toBe(KOJO2_TOKEN.comment);
  });

  it('旧五锚点高亮不回退（`#` / `@` / `?` / `!` / `>` 各自 anchor + 词档）', () => {
    expect(tokenOf('# 幕 清晨', '# ')).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('# 幕 清晨', '幕')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('@算', '@')).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('@算', '算')).toBe(KOJO2_TOKEN.declaration);
    expect(tokenOf('? 计数 >= 1', '? ')).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('! 早安问候', '! ')).toBe(KOJO2_TOKEN.anchor);
    expect(tokenOf('> 晨光。', '> ')).toBe(KOJO2_TOKEN.anchor);
  });
});

/* ============================== ② formatter：不破坏新表面 + 幂等 ============================== */

describe('W1/W2 formatter：新表面不破坏、幂等、语义 token 不变', () => {
  /** 词法语义指纹（kind + 归一化词 + rest；空行不参与——格式化允许增删空行）。 */
  function semanticFingerprint(source: string): string[] {
    const parsed = parseSource(source); // 先保证是合法源
    expect(
      parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
      JSON.stringify(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')),
    ).toEqual([]);
    return lex(source)
      .lines.filter((line) => line.kind !== 'blank')
      .map((line) => {
        const word = 'word' in line ? line.word : '';
        const rest = 'rest' in line ? line.rest : '';
        return `${line.kind}\u0000${word}\u0000${rest}`;
      });
  }

  it('样例本身 parse 零 error（下面的腿才有意义）', () => {
    expect(
      parseSource(SAMPLE).diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    ).toEqual([]);
  });

  it('格式化后新表面原样保留（方寸 / 冒号动作 / 若-否则 / 裸旁白 / `※`）', () => {
    const result = formatKojo2Source(SAMPLE);
    expect(result.changed).toBe(true);
    const text = result.code;
    for (const keep of [
      '【幕 神社清晨】',
      '【挂 指令 310】',
      '【定 亲近线 数 = 500】',
      '【设 计数 数 = 0 存档】',
      '若 计数 >= 亲近线：',
      '再若 计数 >= 100：',
      '否则：',
      '算：',
      '演：早安问候',
      '【函 增加羁绊(目标, 数值 = 10)】',
      '【池 早安问候】',
      '【模 娇羞退场(原因)】',
      '※ 这是整行注释',
      '晨光透过鸟居，斑驳地洒在石阶上。',
      KOJO2_LOOP_CONTROL_CANONICAL_WORDS[0] ?? '',
      KOJO2_LOOP_CONTROL_CANONICAL_WORDS[1] ?? '',
    ]) {
      expect(text, `格式化把「${keep}」改坏了`).toContain(keep);
    }
    // 收口没被写成半角 / 被吞
    expect(text).not.toContain(']');
  });

  it('幂等：第二次格式化 changed=false 且字节相同', () => {
    const first = formatKojo2Source(SAMPLE);
    const second = formatKojo2Source(first.code);
    expect(second.changed).toBe(false);
    expect(second.code).toBe(first.code);
  });

  it('语义 token 不变（只动缩进 / 空行 / 行尾空白，不动字面与归一化词）', () => {
    const before = semanticFingerprint(SAMPLE);
    const after = semanticFingerprint(formatKojo2Source(SAMPLE).code);
    expect(after).toEqual(before);
  });

  it('缩进归一：新正典块头 / 体与旧写法同一套层级（`【池 …】` 体一级、`若` 分支两级）', () => {
    const source =
      '【挂 指令 310】\n\n  【池 早安问候】\n        若 1 < 100：\n              「……早。」\n        否则：\n            「早上好。」\n\n演：早安问候\n';
    const result = formatKojo2Source(source);
    expect(result.changed).toBe(true);
    expect(result.code).toBe(
      '【挂 指令 310】\n\n【池 早安问候】\n    若 1 < 100：\n        「……早。」\n    否则：\n        「早上好。」\n\n演：早安问候\n',
    );
  });

  it('方寸声明行内一个字符都不改（`【定 …】` 的类型 / 等号 / 数字原样）', () => {
    const source = '【挂 指令 310】\n【定 亲近线 数 = 500】';
    const result = formatKojo2Source(source);
    expect(result.code).toBe(source);
    expect(result.changed).toBe(false);
  });
});

/* ============================== ③ hover：新词一句话说明 + 方寸声明名 ============================== */

describe('W1/W2 hover：新正典表面词可读', () => {
  const hover = (line: number, column: number) =>
    kojo2HoverAt({ source: SAMPLE, line, column });

  it('方寸词：`幕` = 场景头（旧写法 `# 幕 …`）', () => {
    const line = lineStarting('【幕');
    const result = hover(line, columnOf(line, '幕'));
    expect(result?.name).toBe('幕');
    expect(result?.kind).toBe('方寸声明');
    expect(result?.lines[0]).toBe('场景头');
    expect(result?.lines.join('\n')).toContain('# 幕');
  });

  it('方寸别名：`挂` 讲"新作者语法"（旧写法 `# 机 …`）', () => {
    const line = lineStarting('【挂');
    const result = hover(line, columnOf(line, '挂'));
    expect(result?.lines.join('\n')).toContain('事件头');
    expect(result?.lines.join('\n')).toContain('# 机');
  });

  it('W2 二义消解：`定` = 编译期常量、`设` = 运行期变量', () => {
    const fixedLine = lineStarting('【定');
    const fixed = hover(fixedLine, columnOf(fixedLine, '定'));
    expect(fixed?.lines[0]).toContain('编译期常量');
    const variableLine = lineStarting('【设');
    const variable = hover(variableLine, columnOf(variableLine, '设'));
    expect(variable?.lines[0]).toContain('运行期变量');
  });

  it('冒号动作：`算` = 状态更新块（旧写法 `@算`）', () => {
    const line = lineExact('算：');
    const result = hover(line, columnOf(line, '算'));
    expect(result?.name).toBe('算');
    expect(result?.kind).toBe('调度');
    expect(result?.lines[0]).toBe('状态更新块');
    expect(result?.lines.join('\n')).toContain('@算');
  });

  it('条件词：`若` / `否则` 与旧 `? 条件` / `? 否` 同义', () => {
    const ifLine = lineStarting('若 ');
    const ifHover = hover(ifLine, columnOf(ifLine, '若'));
    expect(ifHover?.kind).toBe('条件');
    expect(ifHover?.lines.join('\n')).toContain('? 条件');
    const elseLine = lineExact('否则：');
    const elseHover = hover(elseLine, columnOf(elseLine, '否则'));
    expect(elseHover?.kind).toBe('条件');
    expect(elseHover?.lines.join('\n')).toContain('? 否');
  });

  it('`演` = 调用池 / 模板 / 函数（旧写法 `! 名字`）', () => {
    const line = lineStarting('演：');
    const result = hover(line, columnOf(line, '演'));
    expect(result?.kind).toBe('调用');
    expect(result?.lines.join('\n')).toContain('! 名字');
  });

  it('W2 循环控制正典词有说明（`下一轮` ⇒ `@续`、`跳出循环` ⇒ `@断`）', () => {
    const nextWord = KOJO2_LOOP_CONTROL_CANONICAL_WORDS[0] ?? '';
    const nextLine = lineExact(`    ${nextWord}`);
    const next = hover(nextLine, columnOf(nextLine, nextWord));
    expect(next?.kind).toBe('循环控制');
    expect(next?.lines.join('\n')).toContain(`@${KOJO2_DISPATCH_WORDS[14]}`);
    const breakWord = KOJO2_LOOP_CONTROL_CANONICAL_WORDS[1] ?? '';
    const breakLine = lineExact(`    ${breakWord}`);
    const brk = hover(breakLine, columnOf(breakLine, breakWord));
    expect(brk?.lines.join('\n')).toContain(`@${KOJO2_DISPATCH_WORDS[13]}`);
  });

  it('方寸声明名（`【设 …】` / `【池 …】`）走既有声明悬停（种类词 = core 词表）', () => {
    const variableLine = lineStarting('【设');
    const variable = hover(variableLine, columnOf(variableLine, '计数'));
    expect(variable?.kind).toBe(`${KOJO2_DECL_WORD_BY_KIND.variable}声明`);
    expect(variable?.lines.join('\n')).toContain('类型：');
    const poolLine = lineStarting('【池');
    const pool = hover(poolLine, columnOf(poolLine, '早安问候'));
    expect(pool?.kind).toBe(`${KOJO2_DECL_WORD_BY_KIND.pool}声明`);
  });

  it('`※` 注释行不悬停（与旧注释一致）', () => {
    const line = lineStarting('※');
    expect(hover(line, 1)).toBeUndefined();
  });
});

/* ============================== ④ 符号 / outline：方寸声明进大纲 ============================== */

describe('W1/W2 符号：方寸声明进符号表 / outline', () => {
  const facts = kojo2DocumentSymbols(SAMPLE);
  const factOf = (name: string) => {
    const found = facts.find((fact) => fact.name === name);
    if (found === undefined) {
      throw new Error(`大纲缺少「${name}」：${JSON.stringify(facts.map((fact) => fact.name))}`);
    }
    return found;
  };

  it('幕 / 视 / 池 / 模 / 函 / 设 / 定 与旧声明等价地产符号', () => {
    expect(factOf('神社清晨').kind).toBe('scene');
    expect(factOf('灵梦').kind).toBe('view');
    expect(factOf('早安问候').kind).toBe('pool');
    expect(factOf('娇羞退场').kind).toBe('template');
    expect(factOf('增加羁绊').kind).toBe('function');
    expect(factOf('亲近线').kind).toBe('constant');
    expect(['variable', 'constant']).toContain(factOf('计数').kind);
  });

  it('名字段列由词法层真偏移给出（`【幕 神社清晨】` 的 selectionRange 落在 `神社清晨` 上）', () => {
    const scene = factOf('神社清晨');
    const line = lineStarting('【幕');
    expect(scene.selectionRange.startLine).toBe(line);
    expect(scene.selectionRange.startColumn).toBe(columnOf(line, '神社清晨'));
    expect(scene.selectionRange.endColumn).toBe(
      columnOf(line, '神社清晨') + '神社清晨'.length,
    );
  });

  it('面包屑：光标在 `【池 …】` 体内能读出池名（区间包含判据与旧写法同源）', () => {
    const line = lineExact('        「……早。」');
    expect(kojo2SymbolPathAt(SAMPLE, { line, column: 9 })).toContain('早安问候');
  });
});

/* ============================== ⑤ 签名：`演：` 调用位 / 方寸声明头 ============================== */

describe('W1/W2 签名帮助：`演：` 与 `【函 …】` 声明头', () => {
  const SIG = [
    '【挂 指令 310】',
    '【函 加(甲, 乙 = 2)】',
    '    @返 甲 + 乙',
    '',
    '演：加(1, ',
    '',
  ].join('\n');

  it('`演：加(...)` 调用位给形参签名（activeParameter 跟着实参走）', () => {
    const result = kojo2SignatureAt(SIG, { line: 5, column: 8 });
    expect(result?.signatures[0]?.label).toBe('加(甲, 乙 = 2)');
    expect(result?.signatures[0]?.activeParameter).toBe(1);
    expect(result?.signatures[0]?.params.map((param) => param.label)).toEqual(['甲', '乙 = 2']);
  });

  it('方寸声明头 `【函 加(…` 的括号里给同一份形参', () => {
    const result = kojo2SignatureAt(SIG, { line: 2, column: 8 });
    expect(result?.signatures[0]?.label).toBe('加(甲, 乙 = 2)');
  });

  it('旧 `! 加(...)` 调用位不回退', () => {
    const source = '【挂 指令 310】\n【函 加(甲, 乙 = 2)】\n    @返 甲 + 乙\n\n! 加(1, ';
    const result = kojo2SignatureAt(source, { line: 5, column: 8 });
    expect(result?.signatures[0]?.label).toBe('加(甲, 乙 = 2)');
  });
});

/* ============================== ⑥ 同符号高亮：新表面代码面可读 ============================== */

describe('W1/W2 同符号高亮：方寸声明与冒号动作体里的引用', () => {
  it('`【设 计数 …】` 的声明名与 `算：` 体里的赋值是同一符号（write + read）', () => {
    const source = '【挂 指令 310】\n【设 计数 数 = 0】\n算：\n    计数 = 1\n';
    const highlights = kojo2DocumentHighlights(source, {
      line: 2,
      column: columnOfIn(source, 2, '计数'),
    });
    const kinds = highlights.map((highlight) => highlight.kind);
    expect(kinds).toContain('write');
    expect(kinds).toContain('read');
    const read = highlights.find((highlight) => highlight.kind === 'read');
    expect(read?.range.startLine).toBe(4);
  });

  it('`演：池名` 里的池名与 `【池 …】` 声明同符号（引用可高亮）', () => {
    const source =
      '【挂 指令 310】\n【池 问候】\n    若 1 < 100：\n        「早。」\n    否则：\n        「嗨。」\n\n演：问候\n';
    const line = source.split('\n').findIndex((text) => text.startsWith('演：')) + 1;
    const highlights = kojo2DocumentHighlights(source, {
      line,
      column: columnOfIn(source, line, '问候'),
    });
    expect(highlights.some((highlight) => highlight.kind === 'read')).toBe(true);
    expect(highlights.some((highlight) => highlight.kind === 'write')).toBe(true);
  });
});
