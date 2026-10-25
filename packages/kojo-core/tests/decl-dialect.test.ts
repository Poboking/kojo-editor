/**
 * `# 方言 <名字>` 的 **core 侧语法/词法面**闸（LAU §5.3 第 3 级 / spec §3.3 · L5 车道）。
 *
 * 钉住四件事：
 * 1. **词表**：`方言` 在 `KOJO_DECL_WORDS` 里，且**只能钉在尾部**（位序是下游的公开契约）；
 * 2. **形状**：`# 方言 灵梦` 这类一行过词法（`known` 为真、`rest` 原样）与文法（产出
 *    `kind:'dialect'` 的声明节点，带被断言的名字供上层读）；
 * 3. **不透明**：core 不解释这个名字——换任何字符串都照样通过，**不校验它属于哪个方言**，
 *    也不把它登记进文件命名空间（它只断言、不声明名字）；
 * 4. **未登记词照旧红**：`方言` 进表之后，其它未知 `#` 词仍然报 `core/decl/unknown`。
 *
 * 方言对账（`core/dialect/mismatch` / `unbound`）不在本层，也不在本文件。
 */
import { describe, expect, it } from 'vitest';
import type { KojoDialectDecl } from '../src/ast.js';
import { lex } from '../src/lexer.js';
import { parseSource } from '../src/parser.js';
import { KOJO_DECL_WORDS, KOJO_DECL_WORD_SET, type KojoDeclRecord } from '../src/tokens.js';

const MACHINE = '# 机 指令 310\n';

/** 词法第一行（测试夹具都是单行声明） */
function firstLine(source: string): KojoDeclRecord {
  const line = lex(source).lines[0]!;
  if (line.kind !== 'decl') throw new Error(`期望 decl，实得 ${line.kind}`);
  return line;
}

function codesOf(source: string): string[] {
  return parseSource(source).diagnostics.map((diagnostic) => diagnostic.code);
}

function dialectDeclsOf(source: string): KojoDialectDecl[] {
  return parseSource(source).decls.filter((decl): decl is KojoDialectDecl => decl.kind === 'dialect');
}

/* ============================== 1. 词表 ============================== */

describe('`方言` 在声明词表里的位置契约', () => {
  it('已登记，且**恰在尾部**（前面八枚的位序一个字都不许动）', () => {
    expect(KOJO_DECL_WORDS).toEqual(['幕', '视', '机', '变量', '常量', '表', '池', '模', '方言']);
    expect(KOJO_DECL_WORD_SET.has('方言')).toBe(true);
  });

  it('下游按位置取的词仍然对位（`kojo2-format.ts` 的 slice(0,5) 与 5/6/7 三枚）', () => {
    expect(KOJO_DECL_WORDS.slice(0, 5)).toEqual(['幕', '视', '机', '变量', '常量']);
    expect(KOJO_DECL_WORDS[5]).toBe('表');
    expect(KOJO_DECL_WORDS[6]).toBe('池');
    expect(KOJO_DECL_WORDS[7]).toBe('模');
    expect(KOJO_DECL_WORDS[2]).toBe('机');
  });
});

/* ============================== 2. 词法 / 文法形状 ============================== */

describe('词法：`# 方言` 是合法声明行', () => {
  it('known=true，`rest` 与被断言名字的偏移原样交出去', () => {
    const line = firstLine('# 方言 erafl');
    expect(line.word).toBe('方言');
    expect(line.known).toBe(true);
    expect(line.rest).toBe('erafl');
    expect(line.restOffset).toBe(5);
    expect(line.invalid).toBe(false);
  });

  it('锚点后必须有空格：`#方言 x` 走 `core/lex/anchor`（与其它声明词同一条纪律）', () => {
    expect(codesOf('#方言 x')).toContain('core/lex/anchor');
    const line = lex('#方言 x').lines[0]!;
    expect(line.kind).toBe('unknown');
    if (line.kind === 'unknown') expect(line.reason).toBe('hash-no-space');
    expect(line.invalid).toBe(true);
  });

  it('词后必须整词：`# 方言性 1` 不是 `# 方言`，判未知词', () => {
    const line = firstLine('# 方言性 1');
    expect(line.known).toBe(false);
    expect(codesOf(`${MACHINE}# 方言性 1\n`)).toContain('core/decl/unknown');
  });
});

describe('文法：`# 方言` 产出 dialect 声明节点', () => {
  it('一行断言 → `{ kind: "dialect", name, span }`，零诊断', () => {
    const source = `${MACHINE}# 方言 erafl\n> 正文\n`;
    const file = parseSource(source);
    expect(file.decls.filter((decl) => decl.kind === 'dialect')).toHaveLength(1);
    const decl = dialectDeclsOf(source)[0]!;
    expect(decl.name).toBe('erafl');
    // span 落在声明那一行（1 基行列，与 §4.13 同口径）
    expect(decl.span.start.line).toBe(2);
    expect(decl.span.end.line).toBe(2);
    expect(codesOf(source)).toEqual([]);
  });

  it('可选：整篇不写 `# 方言` 也完全合法（§3.3 约束 ①）', () => {
    expect(codesOf(`${MACHINE}> 正文\n`)).toEqual([]);
  });

  it('缺名字（`# 方言` 后什么都没有）→ `core/lex/anchor`，且不产出节点', () => {
    expect(codesOf(`${MACHINE}# 方言\n`)).toContain('core/lex/anchor');
    expect(dialectDeclsOf(`${MACHINE}# 方言\n`)).toHaveLength(0);
  });

  it('只接一个名字：多出一段 → `core/lex/anchor`，第一个名字仍然建出来', () => {
    expect(codesOf(`${MACHINE}# 方言 a b\n`)).toContain('core/lex/anchor');
    expect(dialectDeclsOf(`${MACHINE}# 方言 a b\n`)[0]!.name).toBe('a');
  });

  it('与 `# 幕` / `# 视` / `# 机` 同区连写不影响各自的节点', () => {
    const file = parseSource('# 幕 神社清晨\n# 方言 erafl\n# 视 灵梦\n# 机 指令 310\n> 正文\n');
    expect(file.decls.map((decl) => decl.kind)).toEqual(['dialect', 'view', 'machine']);
    // 断言行像其它声明一样被提升，不切场景、不吞正文
    expect(file.scenes.map((scene) => scene.title)).toEqual(['神社清晨']);
  });
});

/* ============================== 3. 不透明：core 不解释这个名字 ============================== */

describe('`# 方言` 的参数对 core 是不透明字符串', () => {
  it('任何合法名字都照样通过——core 不校验它是不是某个已知方言', () => {
    for (const name of ['erafl', 'eratw', 'zzz', '某个方言', 'X_1']) {
      const source = `${MACHINE}# 方言 ${name}\n`;
      expect(dialectDeclsOf(source)[0]?.name, name).toBe(name);
      expect(codesOf(source), name).toEqual([]);
    }
  });

  it('词表与 core 源码里**不许出现方言取值**（零游戏名词铁律）', () => {
    expect(KOJO_DECL_WORDS).not.toContain('erafl');
    expect(KOJO_DECL_WORDS).not.toContain('eratw');
    // `# 方言` 之外没有任何"方言"相关的词位
    expect(KOJO_DECL_WORDS.filter((word) => word.includes('方言'))).toEqual(['方言']);
  });

  it('只断言不赋值：名字**不进文件命名空间**（不与 `# 变量` 抢重名，§3.4.5）', () => {
    expect(codesOf(`${MACHINE}# 方言 心情\n# 变量 心情 整数\n> 正文\n`)).not.toContain(
      'core/decl/duplicate-name',
    );
    expect(codesOf(`${MACHINE}# 方言 心情\n# 变量 心情 整数\n> 正文\n`)).toEqual([]);
  });

  it('不提升语义、不参与降糖：断言行本身没有体，缩进正文照旧归上一条结构', () => {
    const source = `${MACHINE}# 方言 erafl\n> 正文\n`;
    const file = parseSource(source);
    expect(file.scenes[0]!.items.length).toBeGreaterThan(0);
  });
});

/* ============================== 4. 未知词仍然红 ============================== */

describe('`方言` 进表后未知声明词的判据不变', () => {
  it('未知 `#` 词 → `core/decl/unknown`，且错误信息把当前词表现场拼出来（无第二份抄本）', () => {
    expect(codesOf('# 未知词 x\n')).toContain('core/decl/unknown');
    const diagnostic = parseSource('# 未知词 x\n').diagnostics.find(
      (item) => item.code === 'core/decl/unknown',
    )!;
    expect(diagnostic.message).toContain(KOJO_DECL_WORDS.join('/'));
    expect(diagnostic.message).toContain('方言');
  });

  it('方言名**不能**当声明词用（`# erafl` 仍是未知词，语法里没有方言词汇）', () => {
    expect(codesOf('# erafl x\n')).toContain('core/decl/unknown');
  });
});
