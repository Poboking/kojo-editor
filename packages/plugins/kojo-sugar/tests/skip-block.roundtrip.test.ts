/**
 * **`[SKIPSTART]` / `[SKIPEND]` 成对停用块 round-trip（接力工包 · 非语料）**：写形 → 编译 → 块内逐字节相同。
 *
 * 工包 F 把 `#DIM` 族做完后**故意没登记** `[SKIPSTART]`：区段要按上下文整段透传，必须动
 * `parser.ts`（不在它清单里）。这半归本批。判据与它给的路线一致，一条不放宽：
 * 严格等值 `content === '[SKIPSTART]'`，逐字等于上游 `packages/plugins/erb-parser/src/scanner.ts:308/312`
 * 的 `trimmed === '[SKIPSTART]'`（大小写 / 带尾注变体取证为语料 0 行 ⇒ 放开只会改写"这段是不是引擎
 * 不编译的死区"，而本仓没有引擎侧依据 ⇒ 不猜，见下面的"负例"那一节）。
 *
 * 通路：词法层认两枚标记行（`lexer.ts` 的 `skipStart` / `skipEnd`）→ 配对与逐行透传在
 * `parser.readSkipBlock`，产出现成的 `rawFunctionBlock` → `codegen` 的 `em.pushRaw` 整块逐字节发射。
 * **`codegen.ts` 零改动**：复用 `@` 原生块那条发射手径，正是"不解释死区"的唯一口径。
 * `formatter.ts` 只需两位：`skipStart` / `skipEnd` 进 `NO_INLINE_COMMENT`，并把停用区掩码
 * 按成对标记起落——块体是逐字节进产物的，缩进归一 / 注释折算 / 清空白行都等于改内容。
 */

import { describe, expect, it } from 'vitest';
import type { RawFunctionBlock, SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { classifyLine, splitLogicalLines, type LineClass } from '../src/lexer';
import { computeFormatEdits } from '../src/formatter';
import type { TopNode } from '../src/parser';
import { stubDict, stubFaceTable } from './support';

const FW = '　'; // U+3000

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 产物按物理行切开（**不**去缩进、**不**丢空行——本文件的判据就是字节） */
const rows = (erb: string): string[] => erb.split('\n');

/** 在产物里找一段**连续**的行；命中返回起点下标，否则 -1 */
function indexOfRun(product: readonly string[], run: readonly string[]): number {
  for (let i = 0; i + run.length <= product.length; i++) {
    let hit = true;
    for (let j = 0; j < run.length; j++) {
      if (product[i + j] !== run[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

const errorsOf = (diagnostics: readonly SugarDiagnostic[]): string[] =>
  diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}@${d.loc?.line}: ${d.message}`);

/** 块体行逐字节进产物：区内每一行都必须作为一段**连续**行出现，一行不增一行不减 */
function expectBlockVerbatim(erb: string, block: readonly string[], source: string): void {
  const at = indexOfRun(rows(erb), block);
  expect(at, `产物里找不到这段连续的块体（逐字节判据）。源：\n${source}\n产物：\n${erb}`).toBeGreaterThanOrEqual(0);
}

const line = (text: string): LineClass => {
  const [logical] = splitLogicalLines(text);
  return classifyLine(logical!);
};

/* ============================== 词法层：两枚标记，严格等值 ============================== */

describe('停用块标记的词法判据＝上游严格等值（不放开、不发明第三种口径）', () => {
  it('整行恰为 `[SKIPSTART]` / `[SKIPEND]` ⇒ 各自一枚 kind；带缩进同判（`contentOf` ≡ 上游 `trim()`）', () => {
    expect(line('[SKIPSTART]').kind).toBe('skipStart');
    expect(line('[SKIPEND]').kind).toBe('skipEnd');
    expect(line('\t[SKIPSTART]').kind).toBe('skipStart');
    expect(line(`${FW}[SKIPEND]`).kind).toBe('skipEnd');
    // 行尾空白（含全角）在上游那一侧同样被 `trim()` 掉 ⇒ 这里同判才算"逐字等于上游"，不是放开
    expect(line('[SKIPSTART]' + FW).kind).toBe('skipStart');
    expect(line('[SKIPEND]  ').kind).toBe('skipEnd');
  });

  it('负例（取证过的零行变体）：大小写 / 带尾注 / 别名 / 多余字符 —— 一概**不**当标记', () => {
    for (const s of [
      '[skipstart]',
      '[SkipStart]',
      '[SKIPSTART] ; 尾注',
      '[SKIPEND] ; 尾注',
      '[SKIP]',
      '[SKIP_START]',
      'SKIPSTART',
      '[SKIPSTART]X',
      '[SKIPEND]X',
      '「[SKIPSTART]」', // 台词里的引号形：整行不是"恰为该记号"
    ]) {
      expect(line(s).kind, s).not.toBe('skipStart');
      expect(line(s).kind, s).not.toBe('skipEnd');
    }
  });

  it(`与规则池标签的边界：\`[SKIPSTART]\` 不是 \`[条件]\`（\`matchRuleTag\` 早已排除纯大写记号，这里兜住台词那条路）`, () => {
    expect(line('[SKIPSTART]').kind).not.toBe('ruleTag');
    expect(line('[其他]').kind).toBe('ruleTag'); // 中文标签照常
  });
});

/* ============================== 顶层成对块 ============================== */

describe('顶层 `[SKIPSTART]` … `[SKIPEND]`：写形 → 编译 → 块内逐字节相同', () => {
  const BLOCK = [
    '[SKIPSTART]',
    ';現状未実装',
    '', // 块内空行：一行都不许丢
    '#DIM 死区计数',
    '@M_KOJO_DEAD_K12_900',
    'PRINTFORML 这行不该被打印 ; 行尾注释也是死区正文的一部分',
    'CALL M_KOJO_MESSAGE_COM_K12_900',
    '[SKIPEND]',
  ];
  const source = `角色: 12\n${BLOCK.join('\n')}\n时机 绝顶：\n\t「台词」\n`;

  it('块体作为一段连续行原样进产物（含空行、`;` 注释、`@` 定义、`#` 声明这类"引擎不编译的死区"内容）', () => {
    const result = svc().transpile(source);
    expect(errorsOf(result.diagnostics), `源：\n${source}`).toEqual([]);
    expectBlockVerbatim(result.erb, BLOCK, source);
  });

  it('两枚标记各只出现一次（不被复制、也不被搬到第二处）', () => {
    const result = svc().transpile(source);
    const r = rows(result.erb);
    expect(r.filter((l) => l === '[SKIPSTART]').length).toBe(1);
    expect(r.filter((l) => l === '[SKIPEND]').length).toBe(1);
  });

  it('块外的糖照常编译（块不是黑洞：它前后的行都还在原轨道上）', () => {
    const result = svc().transpile(source);
    expect(result.erb).toContain('PRINTFORMW 「台词」');
  });

  it('AST 形态＝复用现成 `rawFunctionBlock`（不新增节点种类 ⇒ codegen / formatter 零改动的根据）', () => {
    const doc = svc().parse(source);
    // 公开契约把 `topLevel` 收窄成「别名 + 时机」，`buildDoc` 实际装的是全量 `TopNode`
    // （口径同 `sugar-autoidx.perf.test.ts`：按内部视图取那枚块节点）
    const inner = doc.topLevel as unknown as readonly TopNode[];
    const block = inner.filter((n): n is RawFunctionBlock => n.kind === 'rawFunctionBlock');
    expect(block).toHaveLength(1);
    expect(block[0]!.lines).toEqual(BLOCK); // 头尾两枚标记都在 `lines` 里 ⇒ 产物有得 emit，不丢字节
    expect(block[0]!.loc.start.line).toBe(2);
  });
});

/* ============================== 与 `@` 原生块的边界 ============================== */

describe('边界：`@` 块内的标记仍是块体；顶层块在 `[SKIPEND]` 处收手，不吞下一个原生块', () => {
  it('`@` 原生块里的 `[SKIPSTART]` … `[SKIPEND]` 走既有通路（逐字节进产物，且**不**报未配对）', () => {
    // golden 的真实形状：整函数原生直通，停用区在它内部——`classifyLine` 根本到不了那一行
    const src = [
      '角色: 12',
      '@M_KOJO_DEAD_K12_1',
      '[SKIPSTART]',
      'PRINTFORML 死区',
      '[SKIPEND]',
      '',
      '@M_KOJO_DEAD_K12_2',
      'PRINTL 活区',
    ].join('\n');
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expectBlockVerbatim(result.erb, ['[SKIPSTART]', 'PRINTFORML 死区', '[SKIPEND]'], src);
    expectBlockVerbatim(result.erb, ['@M_KOJO_DEAD_K12_2', 'PRINTL 活区'], src);
    expect(result.diagnostics.filter((d) => d.code === 'unclosed-block')).toEqual([]);
  });

  it('顶层块在 `[SKIPEND]` 处收手：紧随其后的 `@` 行另成一枚原生块（两块不并成一枚）', () => {
    // `@` 原生块本就地吃到下一个 `@` 或文件尾（既有口径，本批不动），故时机写在两块**之前**
    const src = [
      '角色: 12',
      '时机 绝顶：',
      '\t「台词」',
      '[SKIPSTART]',
      'PRINTFORML 死区',
      '[SKIPEND]',
      '@M_KOJO_DEAD_K12_1',
      'PRINTL 活区',
    ].join('\n');
    const nodes = svc().parse(src).topLevel as unknown as readonly TopNode[];
    const blocks = nodes.filter((n): n is RawFunctionBlock => n.kind === 'rawFunctionBlock');
    expect(blocks.map((b) => b.lines)).toEqual([
      ['[SKIPSTART]', 'PRINTFORML 死区', '[SKIPEND]'],
      ['@M_KOJO_DEAD_K12_1', 'PRINTL 活区'],
    ]);
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expectBlockVerbatim(result.erb, ['[SKIPSTART]', 'PRINTFORML 死区', '[SKIPEND]'], src);
    expectBlockVerbatim(result.erb, ['@M_KOJO_DEAD_K12_1', 'PRINTL 活区'], src);
    expect(result.erb).toContain('PRINTFORMW 「台词」');
  });
});

/* ============================== 反向红线：块内一个字节都不许多 ============================== */

describe('反向红线：死区里的糖形一律不降、缩进不归一、注释不折算', () => {
  // 这些行写在块**外**会各自走一条编译通路（IF 三行 / PRINTFORML / 别名表 / 头部声明）；
  // 写进死区就必须原样落回产物——"多一行 / 少一行 / 改一行"都是把死区当活代码解释。
  const BLOCK = [
    '[SKIPSTART]',
    '如果 胆怯 >= 1：',
    '\t「台词冒充旁白」',
    '[SKIPEND]',
  ];
  const source = `角色: 12\n${BLOCK.join('\n')}\n时机 绝顶：\n\t「真台词」\n`;

  it('块内的块头**不**展开成 IF/ENDIF：产物里那三行逐字节 ≡ 源三行，且行数不增', () => {
    const result = svc().transpile(source);
    expect(errorsOf(result.diagnostics), `源：\n${source}`).toEqual([]);
    const r = rows(result.erb);
    const at = indexOfRun(r, BLOCK);
    expect(at, `产物：\n${result.erb}`).toBeGreaterThanOrEqual(0);
    // 逐字节判据：段内没有第二枚 `IF` / `ENDIF` 被凭空造出来
    expect(r.slice(at, at + BLOCK.length)).toEqual(BLOCK);
  });

  it('台词形 / `空行` / `别名` / `角色:` 写在死区里都不产打印行，也不改字节', () => {
    const inner = [
      '[SKIPSTART]',
      '「打印我试试」',
      '空行',
      '别名 甲 = 1',
      `角色: 12${FW}带全角缩进的死区`,
      `${FW}${FW}PRINTL 全角缩进不许折`,
      '   ', // 纯空白行：糖区会被清空，死区里它是一行真实存在的字节
      '[SKIPEND]',
    ];
    const src = `角色: 12\n${inner.join('\n')}\n时机 绝顶：\n\t「真台词」\n`;
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    const r = rows(result.erb);
    const at = indexOfRun(r, inner);
    expect(at, `产物：\n${result.erb}`).toBeGreaterThanOrEqual(0);
    expect(r.slice(at, at + inner.length)).toEqual(inner);
  });

  it(`格式化（\`Shift+Alt+F\`）在块内零编辑；同一份规则在块外照常生效（证明规则是活的）`, () => {
    // 块体行全在列 0、不含全角空白 ⇒ 天然不参与缩进归一 / 注释折算
    const src = [
      '角色: 12',
      '时机 绝顶：',
      '\t;　注释里的全角空格该被折掉', // ← 块外：teeth，规则必须真的在跑
      '[SKIPSTART]',
      ';現状未実装',
      '#DIM 死区计数',
      '@M_KOJO_DEAD_K12_900',
      '',
      '[SKIPEND]',
    ].join('\n');
    const edits = computeFormatEdits(src, 'kojo');
    const blockRange = [4, 5, 6, 7, 8, 9]; // 1 基：`[SKIPSTART]` … `[SKIPEND]`（含空行）
    expect(edits.filter((e) => blockRange.includes(e.line))).toEqual([]);
    expect(edits.some((e) => e.line === 3)).toBe(true);
  });

  it(`块体带缩进与纯空白行也零编辑（这几类字节会逐字节进产物，格式化动它就是改内容）`, () => {
    const src = [
      '角色: 12',
      '[SKIPSTART]',
      '  ;缩进注释　带全角空格', // 缩进归一 + 注释折算两类目标
      '   ', // 纯空白行：格式化会把它清成空行
      '  PRINTFORML 死区台词',
      '[SKIPEND]',
    ].join('\n');
    expect(computeFormatEdits(src, 'kojo').filter((e) => [2, 3, 4, 5, 6].includes(e.line))).toEqual([]);
  });

  it(`配对的 [SKIPEND] 之后区必须关掉（否则区一路骑到文件尾，后半篇糖行不再排版）`, () => {
    const src = [
      '角色: 12',
      '[SKIPSTART]',
      '  IF LOCAL:1',
      '[SKIPEND]',
      '  ;　区外注释里的全角空格该被折掉', // 与块内那一行同形态 ⇒ 有编辑才证明区真的关了
    ].join('\n');
    expect(computeFormatEdits(src, 'kojo').some((e) => e.line === 5)).toBe(true);
  });
});

/* ============================== 块写在时机正文里 ============================== */

describe('时机正文里的成对停用块：按缩进行走，块体连缩进一起透传', () => {
  const BLOCK = [
    '\t[SKIPSTART]',
    '\t;死区缩进注释',
    '\tIF LOCAL:1',
    `\t\tPRINTFORML 死区台词${FW}带全角`,
    '\tENDIF',
    '\t[SKIPEND]',
  ];
  const source = `角色: 12\n时机 绝顶：\n\t「前」\n${BLOCK.join('\n')}\n\t「后」\n`;

  it('块体逐字节进产物（**含原有 TAB 缩进**——ERB 不靠缩进，改了就是改内容）', () => {
    const result = svc().transpile(source);
    expect(errorsOf(result.diagnostics), `源：\n${source}`).toEqual([]);
    expectBlockVerbatim(result.erb, BLOCK, source);
  });

  it('块后的正文没被吞掉（`「后」` 仍编译），块前的也没（`「前」` 仍编译）', () => {
    const result = svc().transpile(source);
    expect(result.erb).toContain('PRINTFORMW 「前」');
    expect(result.erb).toContain('PRINTFORMW 「后」');
  });

  it('随机候选位置的块同样成段透传（`buildStandaloneNode` 入口：头行已被调用方消费）', () => {
    // 候选写在 `随机：` 的下一层缩进上；块体连它自己的 TAB 一起进产物
    const block = ['\t\t[SKIPSTART]', '\t\tPRINTFORML 候选里的死区', '\t\t[SKIPEND]'];
    const src = `角色: 12\n时机 绝顶：\n\t随机：\n${block.join('\n')}\n`;
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expectBlockVerbatim(result.erb, block, src);
  });
});

/* ============================== 不静默：未配对 / 无尾记号 ============================== */

describe('铁律 4：内核不静默——未配对与落单尾记号都不许丢行', () => {
  it('只有 `[SKIPSTART]`（无尾）⇒ 吃到文件尾，一行不丢，且报 `unclosed-block` 让作者看得见', () => {
    const src = [
      '角色: 12',
      '时机 绝顶：',
      '\t「台词」',
      '[SKIPSTART]',
      ';这段一直到文件尾都是死区',
      '@M_KOJO_DEAD_K12_999',
      'PRINTFORML 死区最后一行',
    ].join('\n');
    const result = svc().transpile(src);
    const tail = ['[SKIPSTART]', ';这段一直到文件尾都是死区', '@M_KOJO_DEAD_K12_999', 'PRINTFORML 死区最后一行'];
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expectBlockVerbatim(result.erb, tail, src);
    // 源里的死区行数 ≡ 产物里的死区行数（丢行＝静默）
    expect(rows(result.erb).filter((l) => tail.includes(l)).length).toBe(tail.length);
    expect(result.diagnostics.filter((d) => d.code === 'unclosed-block').map((d) => d.severity)).toEqual(['warning']);
  });

  it('时机正文里未配对也一样：吃到文件尾 + 不吞已解析的正文', () => {
    const src = ['角色: 12', '时机 绝顶：', '\t「台词」', '\t[SKIPSTART]', '\tPRINTFORML 死区'].join('\n');
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expectBlockVerbatim(result.erb, ['\t[SKIPSTART]', '\tPRINTFORML 死区'], src);
    expect(result.erb).toContain('PRINTFORMW 「台词」');
    expect(result.diagnostics.some((d) => d.code === 'unclosed-block')).toBe(true);
  });

  it('`[SKIPEND]` 单独出现（无头）⇒ 不崩、不误当块头、按原生行逐字带走，后面的糖照常编译', () => {
    const src = ['角色: 12', '[SKIPEND]', '时机 绝顶：', '\t「台词」'].join('\n');
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    const r = rows(result.erb);
    expect(r.filter((l) => l === '[SKIPEND]').length).toBe(1);
    // 它没"开"出任何区：紧随其后的时机照样编译成打印行
    expect(result.erb).toContain('PRINTFORMW 「台词」');
  });

  it('正文里的落单 `[SKIPEND]` 也不吞后续行', () => {
    const src = ['角色: 12', '时机 绝顶：', '\t「前」', '\t[SKIPEND]', '\t「后」'].join('\n');
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expect(result.erb).toContain('PRINTFORMW 「前」');
    expect(result.erb).toContain('PRINTFORMW 「后」');
    expect(rows(result.erb)).toContain('\t[SKIPEND]');
  });

  it('配对好的两块相邻（前一块不吞后一块的头）', () => {
    const src = [
      '角色: 12',
      '[SKIPSTART]',
      'PRINTFORML 一区',
      '[SKIPEND]',
      '[SKIPSTART]',
      'PRINTFORML 二区',
      '[SKIPEND]',
      '时机 绝顶：',
      '\t「台词」',
    ].join('\n');
    const result = svc().transpile(src);
    expect(errorsOf(result.diagnostics), `源：\n${src}`).toEqual([]);
    expectBlockVerbatim(result.erb, ['[SKIPSTART]', 'PRINTFORML 一区', '[SKIPEND]'], src);
    expectBlockVerbatim(result.erb, ['[SKIPSTART]', 'PRINTFORML 二区', '[SKIPEND]'], src);
    expect(result.diagnostics.filter((d) => d.code === 'unclosed-block')).toEqual([]);
  });
});
