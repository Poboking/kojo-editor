/**
 * `# 方言 <名字>` 的 **Monaco 侧词法/词表闸**（LAU §5.3 / spec §3.3 · L5 车道）。
 *
 * 钉三件事：
 * 1. **高亮接上且不新造 token**：`# 方言` 的词走 Monarch `@declWords` 分支，
 *    发的是既有 `KOJO2_TOKEN.declaration`（角色表是 LAU-2 的事，本批不开新 token 名）；
 *    未知词仍然不上声明色。
 * 2. **位序契约没被打乱**：`kojo2-format.ts` 按下标取词
 *    （`[, , , , , TABLE, POOL, TEMPLATE]` 与 `slice(0, 5)`）⇒ `方言` 只能钉在尾部，
 *    前五枚与 5/6/7 三枚逐字不变；这一条是"插队会静默改格式化行为"的守门员。
 * 3. **格式化不吃亏**：带 `# 方言` 的文件过一遍格式化，正文保真、`parseSource` 的
 *    error 数不涨（词位进表后格式化层不许引入新破坏）。
 *
 * 驱动器用仓里既有的 `tests/monarch-harness.ts` ⇒ 断言的 token 名就是屏上真发的名字。
 *
 * ⚠ 与 `kojo2-format.ts` 的关系（本批实测出来的坑，已就地接上）：该文件按**位置**取词
 * （`[, , , , , TABLE, POOL, TEMPLATE]` 与 `slice(0, 5)`）。`方言` 钉在尾部 ⇒ 这两处
 * 一个字没动；但它因此**不落** `slice(0, 5)` ⇒ 一度被 `roleOf` 判成 `flat`，格式化会把
 * `# 方言` 前后各塞一个空行、**把 §3.2 的单行声明组劈成两段**。修法是"从尾格单独取词再
 * 并入 `SINGLE_DECL_WORDS`"（零位置扰动），下面第 3 组判据钉的就是这一条。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { KOJO_DECL_WORDS } from '@kojo/kojo-core';
import { parseSource } from '@kojo/kojo-core';
import { compileMonarch, driveLine, stubMonaco, type CompiledLexer } from './monarch-harness';
import { KOJO2_DECL_WORDS } from '../src/monaco/kojo2-lexicon';
import { KOJO2_TOKEN, registerKojo2Language } from '../src/monaco/kojo2-language';
// B3d：格式化判据搬进语言面库（宿主那枚文件只剩翻译层），测试直接取包内叶子。
import { formatKojo2Source } from '@kojo/kojo-lang/format';
import { KOJO2_MONACO_LANGUAGE_SURFACE } from '@kojo/plugin-kojo-lang';
import { registerMonacoLanguageSurfaceSource } from '../src/monaco/monaco-language-surface';

const { monaco, captured } = stubMonaco();
// B4：词法正文在语言面库、由插件经槽交出 ⇒ 认领语言之后还要有供方才着色。
// 这里把真供方接进落点（同 `kojo2-language.test.ts`），本文件驱动的仍是屏上那一份词法。
registerMonacoLanguageSurfaceSource(() => [
  { id: 'kojo2-monaco-language', surface: KOJO2_MONACO_LANGUAGE_SURFACE },
]);
registerKojo2Language(monaco);

let lexer!: CompiledLexer;

beforeAll(async () => {
  const def = captured.monarchs.get('kojo2');
  expect(def, '注册语言面时没有交 Monarch 定义').toBeTruthy();
  lexer = await compileMonarch('kojo2', def!);
}, 120_000);

/* ============================== 驱动器小工具（与 kojo2-language.test.ts 同口径） ============================== */

function bare(token: string): string {
  const postfix = lexer.tokenPostfix;
  return postfix !== '' && token.endsWith(postfix) ? token.slice(0, -postfix.length) : token;
}

function ofToken(line: string, token: string): string[] {
  const driven = driveLine(lexer, line);
  return driven.emitted
    .filter((e) => e.text.length > 0 && bare(e.token) === token)
    .map((e) => e.text);
}

/** 一行跑完必须回根状态（防跨行状态泄漏）。 */
function expectBackToRoot(line: string): void {
  const driven = driveLine(lexer, line);
  expect(driven.stack, `行跑完没有回根状态：${line}`).toHaveLength(1);
}

/* ============================== 1. Monarch 声明档 ============================== */

describe('`# 方言` 走 Monarch 既有声明档（不新造 token 名）', () => {
  it('词发 `KOJO2_TOKEN.declaration`，锚点发 `KOJO2_TOKEN.anchor`（锚点档连词后那个空白一起发）', () => {
    expect(ofToken('# 方言 erafl', KOJO2_TOKEN.declaration)).toEqual(['方言']);
    expect(ofToken('# 方言 erafl', KOJO2_TOKEN.anchor)).toEqual(['# ']);
    expectBackToRoot('# 方言 erafl');
  });

  it('被断言的名字不抢声明色（它与 `# 视角` 一样只是个裸名字）', () => {
    expect(ofToken('# 方言 erafl', KOJO2_TOKEN.declaration)).not.toContain('erafl');
    expectBackToRoot('# 方言 erafl');
  });

  it('未知词仍然不上声明色（`方言` 进表没有放宽这一档）', () => {
    expect(ofToken('# 未知声明 x', KOJO2_TOKEN.declaration)).toEqual([]);
    expect(ofToken('#方言 erafl', KOJO2_TOKEN.declaration)).toEqual([]);
  });

  it('方言取值不是词表内容：词表里只有断言词位本身', () => {
    expect(KOJO_DECL_WORDS).not.toContain('erafl');
    expect(KOJO_DECL_WORDS).not.toContain('eratw');
    // 除断言行本身外，语法层没有任何"方言词汇"
    expect(KOJO_DECL_WORDS.filter((word) => word !== '方言' && word.includes('方言'))).toEqual([]);
  });
});

/* ============================== 2. 位序契约（格式化按下标取词） ============================== */

describe('声明词位序契约：`方言` 只能钉在尾部', () => {
  it('Monarch 词表就是 core 真源本体（同引用 ⇒ 加词一处生效）', () => {
    expect(KOJO2_DECL_WORDS).toBe(KOJO_DECL_WORDS);
  });

  it('九枚逐字对位，`方言` 在最后一格', () => {
    expect(KOJO_DECL_WORDS).toEqual(['幕', '视角', '机', '设', '设', '对照表', '池', '模', '方言']);
    expect(KOJO_DECL_WORDS.indexOf('方言')).toBe(KOJO_DECL_WORDS.length - 1);
  });

  it('`kojo2-format.ts` 依赖的下标一个字都没动（slice(0,5) 与 5/6/7 三枚）', () => {
    // 单行声明组：slice(0, 5)
    expect(KOJO2_DECL_WORDS.slice(0, 5)).toEqual(['幕', '视角', '机', '设', '设']);
    // 位置解构 `[, , , , , TABLE_WORD, POOL_WORD, TEMPLATE_WORD]`
    expect([KOJO2_DECL_WORDS[5], KOJO2_DECL_WORDS[6], KOJO2_DECL_WORDS[7]]).toEqual([
      '对照表',
      '池',
      '模',
    ]);
    // 其它按下标取词的模块（codelens / references / inlay / expand-view / symbols）
    expect(KOJO2_DECL_WORDS[2]).toBe('机');
    expect(KOJO2_DECL_WORDS[3]).toBe('设');
    expect(KOJO2_DECL_WORDS[4]).toBe('设');
  });
});

/* ============================== 3. 格式化不吃亏 ============================== */

describe('带 `# 方言` 的文件过格式化：并进单行声明组、诊断不涨', () => {
  /** 三条夹具都已是规范形状（§3.2：单行声明连写、整组与正文之间空一行）⇒ 必须逐字节不动。 */
  const SAMPLES: readonly string[] = [
    '# 幕 神社清晨\n# 方言 erafl\n# 视角 灵梦\n# 机 指令 310\n\n> 正文\n',
    '# 方言 erafl\n# 机 指令 310\n\n> 正文\n',
    '# 机 指令 310\n# 方言 erafl\n# 设 心情 整数\n\n> 正文\n',
  ];

  for (const source of SAMPLES) {
    it(`逐字节不动且幂等、error 数为 0：${JSON.stringify(source.slice(0, 22))}…`, () => {
      expect(parseSource(source).diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
      const once = formatKojo2Source(source);
      expect(once.changed, `格式化改写了本来已规范的夹具：\n${JSON.stringify(once.code)}`).toBe(false);
      expect(once.code).toBe(source);
      expect(formatKojo2Source(once.code).code).toBe(once.code);
    });
  }

  it('反证：漏了组内空行时，格式化只在**组与正文之间**补一行，绝不在 `# 方言` 前后插行', () => {
    const tight = '# 幕 神社清晨\n# 方言 erafl\n# 机 指令 310\n> 正文\n';
    const expected = '# 幕 神社清晨\n# 方言 erafl\n# 机 指令 310\n\n> 正文\n';
    expect(formatKojo2Source(tight).code).toBe(expected);
  });

  it('对照同构夹具：加一行 `# 方言` 不改变其它声明组的呼吸', () => {
    const without = '# 幕 神社清晨\n# 视角 灵梦\n# 机 指令 310\n\n> 正文\n';
    const withDialect = '# 幕 神社清晨\n# 视角 灵梦\n# 方言 erafl\n# 机 指令 310\n\n> 正文\n';
    expect(formatKojo2Source(without).code).toBe(without);
    expect(formatKojo2Source(withDialect).code).toBe(withDialect);
  });
});
