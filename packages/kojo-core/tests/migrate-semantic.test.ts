/**
 * K2-MIGRATE-SEMANTIC 回归：迁移**语义升级层**（`当` → `# 表` / `分支：` → `# 池` / `初回` → `@原生`）。
 *
 * 四层判据（与机械层同一套纪律，不放松）：
 * 1. **可证正例逐字节**：每个改写都断言产物逐字相等（不是"大致像"）；
 * 2. **不可证维持 unsupported**：区间重叠 / 缺兜底 / 非数值臂 / 副作用 / 排序口径不一致 …
 *    一律 `ok=false` + 机械层原码 + **原块逐字保留**（不猜、不产半成品）；
 * 3. **闭环**：迁移产物过 2.0 前端 `parseSource` 零 error；
 * 4. **幂等**：产物再迁移逐字节不变（语义层已无可改写块 ⇒ 空转）。
 *
 * 另外钉住"分层"本身：机械层 `migrateKojoSource` 对同一份 v1 仍然 `ok=false`——语义层是**加法**，
 * 不改机械层的判据，也不替它放行。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import { migrateKojoSource } from '../src/migrate/index.js';
import { migrateKojoSourceSemantic, type SemanticMigrateResult } from '../src/migrate/semantic.js';
import { parseSource } from '../src/parser.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/migrate/${name}`, import.meta.url), 'utf8');
}

/** 语义升级并断言成功（失败时把台账打到断言消息里） */
function migrateOk(source: string, options?: Parameters<typeof migrateKojoSourceSemantic>[1]): SemanticMigrateResult {
  const result = migrateKojoSourceSemantic(source, options);
  expect(result.ok, `unexpected unsupported: ${JSON.stringify(result.unsupported)}`).toBe(true);
  expect(result.unsupported).toEqual([]);
  return result;
}

/** 断言产物里没有 error 诊断（迁移后能过 2.0 前端） */
function expectParsesClean(code: string): void {
  const diagnostics = parseSource(code).diagnostics.filter((d) => d.severity === 'error');
  expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
}

/** 断言"不可证 ⇒ 维持 unsupported"：ok=false、有指定码、原块逐字保留 */
function expectBlocked(source: string, code: string, construct: string): SemanticMigrateResult {
  const result = migrateKojoSourceSemantic(source);
  expect(result.ok, `expected ok=false for ${construct}`).toBe(false);
  expect(result.rewrites).toEqual([]);
  expect(result.unsupported.map((entry) => entry.code)).toContain(code);
  return result;
}

const HEADER = '角色: 灵梦\n';
const MACHINE = '时机 指令 310：\n';

/* ============================== 正例：逐字节 ============================== */

describe('语义升级：可证正例逐字节', () => {
  it('端到端 fixture：三类构造一起迁 → 逐字节 → 2.0 前端零 error → 幂等', () => {
    const source = fixture('semantic.kojo.txt');
    const result = migrateOk(source);
    expect(result.code).toBe(fixture('semantic.kojo2'));
    expect(result.rewrites.map((rewrite) => rewrite.kind)).toEqual(['switch-table', 'branch-pool', 'ask-native']);
    expect(result.rewrites.map((rewrite) => rewrite.declName)).toEqual(['迁移表1', '迁移池1', null]);
    expect(result.rewrites.map((rewrite) => [rewrite.line, rewrite.endLine])).toEqual([
      [4, 10],
      [11, 16],
      [17, 18],
    ]);
    expectParsesClean(result.code);

    // 幂等：产物再迁一遍逐字节不变，且没有可改写块
    const again = migrateOk(result.code);
    expect(again.code).toBe(result.code);
    expect(again.rewrites).toEqual([]);

    // 分层自证：机械层对同一份 v1 仍然 fail-closed（语义层没有替它放行）
    const mechanical = migrateKojoSource(source);
    expect(mechanical.ok).toBe(false);
    expect(mechanical.unsupported.map((entry) => [entry.line, entry.code])).toEqual([
      [4, 'core/migration/switch'],
      [11, 'core/migration/branch'],
      [17, 'core/migration/ask'],
    ]);
  });

  it('`当` → `# 表`：旁白臂（值列 = 正文），引用点 `> {表}`', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 TFLAG:193：\n' +
      '        是 1：\n' +
      '            她一言不发。\n' +
      '        是 5 到 8：\n' +
      '            她微微眯起眼睛。\n' +
      '        否则：\n' +
      '            她什么也没说。\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 表 迁移表1 由 TFLAG:193\n' +
        '    1 她一言不发。\n' +
        '    5..8 她微微眯起眼睛。\n' +
        '    否 她什么也没说。\n' +
        '\n' +
        '# 机 指令 310\n' +
        '> {迁移表1}\n',
    );
    expect(result.rewrites[0]).toMatchObject({ kind: 'switch-table', line: 3, declName: '迁移表1' });
    expectParsesClean(result.code);
  });

  it('`当` → `# 表`：台词臂（同一说话人）+ 逗号列表 + 区间；说话人取 v1 文件头', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 恋慕：\n' +
      '        是 0：\n' +
      '            「甲。」\n' +
      '        是 1, 2：\n' +
      '            「乙。」\n' +
      '        是 10 到 20：\n' +
      '            「丙。」\n' +
      '        否则：\n' +
      '            「丁。」\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 表 迁移表1 由 恋慕\n' +
        '    0 甲。\n' +
        '    1 乙。\n' +
        '    2 乙。\n' +
        '    10..20 丙。\n' +
        '    否 丁。\n' +
        '\n' +
        '# 机 指令 310\n' +
        '灵梦：「{迁移表1}」\n',
    );
    expectParsesClean(result.code);
  });

  it('`当` → `# 表`：负数 / 单点区间也算可证数值', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 TFLAG:7：\n' +
      '        是 -2：\n' +
      '            负二。\n' +
      '        是 0 到 0：\n' +
      '            零。\n' +
      '        否则：\n' +
      '            其他。\n';
    const result = migrateOk(source);
    expect(result.code).toContain('# 表 迁移表1 由 TFLAG:7\n    -2 负二。\n    0 零。\n    否 其他。\n');
    expectParsesClean(result.code);
  });

  it('`分支：` → `# 池`：条件原样进 `?`，`[其他]` → `? 否`，块体走真实文本迁移', () => {
    const source =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的好感度 >= 900]\n' +
      '            如果 TFLAG:1：\n' +
      '                「甲。」\n' +
      '            否则：\n' +
      '                「乙。」\n' +
      '        [其他]\n' +
      '            「丙。」\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 池 迁移池1\n' +
        '    ? 她的好感度 >= 900\n' +
        '        ? TFLAG:1\n' +
        '            灵梦：「甲。」\n' +
        '        ? 否\n' +
        '            灵梦：「乙。」\n' +
        '    ? 否\n' +
        '        灵梦：「丙。」\n' +
        '\n' +
        '# 机 指令 310\n' +
        '! 迁移池1\n',
    );
    expect(result.rewrites[0]).toMatchObject({ kind: 'branch-pool', line: 3, declName: '迁移池1' });
    expectParsesClean(result.code);
  });

  it('`分支：` → `# 池`：多个条件分支保序（不可排序形态：不同主语）', () => {
    const source =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的恋慕 >= 100]\n' +
      '            她笑了。\n' +
      '        [她的思慕 >= 100]\n' +
      '            她低下头。\n' +
      '        [其他]\n' +
      '            她什么也没说。\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 池 迁移池1\n' +
        '    ? 她的恋慕 >= 100\n' +
        '        > 她笑了。\n' +
        '    ? 她的思慕 >= 100\n' +
        '        > 她低下头。\n' +
        '    ? 否\n' +
        '        > 她什么也没说。\n' +
        '\n' +
        '# 机 指令 310\n' +
        '! 迁移池1\n',
    );
    expectParsesClean(result.code);
  });

  it('`初回 / 询问 / 确认` → `@原生` 围栏：整块逐行搬，块内不解释', () => {
    const source =
      HEADER +
      MACHINE +
      '    初回 "once"：\n' +
      '        「甲」\n' +
      '            ; 深一层也不解释\n' +
      '    询问 "想说什么？"：\n' +
      '        「乙」\n' +
      '    确认 "确定吗？"：\n' +
      '        「丙」\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 机 指令 310\n' +
        '@原生\n' +
        '    初回 "once"：\n' +
        '        「甲」\n' +
        '            ; 深一层也不解释\n' +
        '@原生\n' +
        '    询问 "想说什么？"：\n' +
        '        「乙」\n' +
        '@原生\n' +
        '    确认 "确定吗？"：\n' +
        '        「丙」\n',
    );
    expect(result.rewrites.map((rewrite) => rewrite.kind)).toEqual(['ask-native', 'ask-native', 'ask-native']);
    expect(result.diagnostics.filter((d) => d.code === 'core/migration/ask').map((d) => d.severity)).toEqual([
      'warning',
      'warning',
      'warning',
    ]);
    expectParsesClean(result.code);
  });

  it('`分支：` → `# 池`：设计稿 §3.11 的原样例子（`且` 条件 + 行内条件插值）', () => {
    const source =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的恋慕 且 她的思慕]\n' +
      '            「……那、那里……！」\n' +
      '            她红着脸缩了一下身子。\n' +
      '        [她的好感度 >= 500]\n' +
      '            「……嗯，{她的恋慕 ? "主人的话，可以哦。" : "只、只能一下哦。"}」\n' +
      '        [其他]\n' +
      '            「……请不要乱摸。」\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 池 迁移池1\n' +
        '    ? 她的恋慕 且 她的思慕\n' +
        '        灵梦：「……那、那里……！」\n' +
        '        > 她红着脸缩了一下身子。\n' +
        '    ? 她的好感度 >= 500\n' +
        '        灵梦：「……嗯，{她的恋慕 ? "主人的话，可以哦。" : "只、只能一下哦。"}」\n' +
        '    ? 否\n' +
        '        灵梦：「……请不要乱摸。」\n' +
        '\n' +
        '# 机 指令 310\n' +
        '! 迁移池1\n',
    );
    expectParsesClean(result.code);
  });

  it('块头的 v1 行内 `;` 注释随引用行搬成整行 `//`', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 TFLAG:1： ; 分档\n' +
      '        是 0：\n' +
      '            她笑了。\n' +
      '        否则：\n' +
      '            她没说话。\n' +
      '    分支： ; 规则池\n' +
      '        [TFLAG:1]\n' +
      '            「甲」\n' +
      '        [其他]\n' +
      '            「乙」\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 表 迁移表1 由 TFLAG:1\n' +
        '    0 她笑了。\n' +
        '    否 她没说话。\n' +
        '\n' +
        '# 池 迁移池1\n' +
        '    ? TFLAG:1\n' +
        '        灵梦：「甲」\n' +
        '    ? 否\n' +
        '        灵梦：「乙」\n' +
        '\n' +
        '# 机 指令 310\n' +
        '> {迁移表1}\n' +
        '// 分档\n' +
        '! 迁移池1\n' +
        '// 规则池\n',
    );
    expectParsesClean(result.code);
  });

  it('`初回` 在顶层（不在 `时机` 体内）也搬得动', () => {
    const result = migrateOk('初回 "once"：\n    「甲」\n');
    expect(result.code).toBe('@原生\n    初回 "once"：\n        「甲」\n');
    // 该源没有 `# 机`（v1 也不合法），2.0 前端会报 `core/decl/missing-machine`——与本层无关
    expect(parseSource(result.code).diagnostics.map((d) => d.code)).toEqual(['core/decl/missing-machine']);
  });

  it('嵌套在 `如果` 体里的 `当` 也改写（引用点跟着缩进归一到 `?` 链下）', () => {
    const source =
      HEADER +
      MACHINE +
      '    如果 TFLAG:1：\n' +
      '        当 TFLAG:2：\n' +
      '            是 0：\n' +
      '                她笑了。\n' +
      '            否则：\n' +
      '                她没说话。\n' +
      '    否则：\n' +
      '        普通旁白。\n';
    const result = migrateOk(source);
    expect(result.code).toBe(
      '# 表 迁移表1 由 TFLAG:2\n' +
        '    0 她笑了。\n' +
        '    否 她没说话。\n' +
        '\n' +
        '# 机 指令 310\n' +
        '? TFLAG:1\n' +
        '    > {迁移表1}\n' +
        '? 否\n' +
        '    > 普通旁白。\n',
    );
    expectParsesClean(result.code);
  });

  it('CRLF / BOM / 末尾换行原样保留', () => {
    const source = '\uFEFF角色: 灵梦\r\n时机 指令 310：\r\n    初回 "once"：\r\n        「甲」\r\n';
    const result = migrateOk(source);
    expect(result.code).toBe('\uFEFF# 机 指令 310\r\n@原生\r\n    初回 "once"：\r\n        「甲」\r\n');
    const noFinal = migrateOk('角色: 灵梦\n时机 指令 310：\n    初回 "once"：\n        「甲」');
    expect(noFinal.code.endsWith('\n')).toBe(false);
  });

  it('sourceMap：生成的声明行回源到触发它的 v1 块头，引用行回源到原块位置', () => {
    const result = migrateOk(fixture('semantic.kojo.txt'));
    const lines = result.code.split('\n');
    const at = (needle: string): number => lines.indexOf(needle);
    expect(result.sourceMap.length).toBe(lines.length - 1);
    expect(result.sourceMap[at('# 表 迁移表1 由 TFLAG:193')]).toBe(4);
    expect(result.sourceMap[at('# 池 迁移池1')]).toBe(11);
    expect(result.sourceMap[at('灵梦：「{迁移表1}」')]).toBe(4);
    expect(result.sourceMap[at('! 迁移池1')]).toBe(11);
    expect(result.sourceMap[at('@原生')]).toBe(17);
    expect(result.sourceMap[at('        「第一次呢。」')]).toBe(18);
    expect(result.sourceMap[at('> 普通旁白。')]).toBe(19);
  });

  it('生成的声明名避开源里已有的标识符（同一文件命名空间不撞名）', () => {
    const source =
      '# 表 迁移表1 由 TFLAG:2\n' +
      '    否 未知\n' +
      '\n' +
      HEADER +
      MACHINE +
      '    当 TFLAG:1：\n' +
      '        是 0：\n' +
      '            「甲」\n' +
      '        否则：\n' +
      '            「乙」\n';
    const result = migrateOk(source);
    expect(result.code).toContain('# 表 迁移表2 由 TFLAG:1\n');
    expect(result.code).toContain('灵梦：「{迁移表2}」\n');
    expectParsesClean(result.code);
  });
});

/* ============================== 不可证：维持 unsupported ============================== */

describe('语义升级：不可证一律维持 unsupported（不猜）', () => {
  it('`当` 臂区间静态重叠 → 不改写（`# 表` 要求非重叠）', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 TFLAG:1：\n' +
      '        是 0 到 5：\n' +
      '            「甲」\n' +
      '        是 3 到 8：\n' +
      '            「乙」\n' +
      '        否则：\n' +
      '            「丙」\n';
    const result = expectBlocked(source, 'core/migration/switch', '`当` 重叠区间');
    expect(result.code).toContain('    当 TFLAG:1：\n        是 0 到 5：\n            「甲」\n        是 3 到 8：\n');
    expect(result.diagnostics.some((d) => d.message.includes('语义升级未采纳'))).toBe(true);
  });

  it('`当` 缺 `否则` 兜底 → 不改写（`# 表` 的 `否` 必填）', () => {
    const source =
      HEADER + MACHINE + '    当 TFLAG:1：\n        是 0：\n            「甲」\n        是 1：\n            「乙」\n';
    expectBlocked(source, 'core/migration/switch', '`当` 缺兜底');
  });

  it('`当` 臂值不是十进制整数（字符串 / 变量 / 表达式）→ 不改写', () => {
    for (const arm of ['「甲」', '她的好感度', '1 + 1', '0x10']) {
      const source = HEADER + MACHINE + `    当 TFLAG:1：\n        是 ${arm}：\n            「甲」\n        否则：\n            「乙」\n`;
      expectBlocked(source, 'core/migration/switch', `非数值臂 ${arm}`);
    }
  });

  it('`当` 臂正文多行 / 带注释 / 带等待 → 不改写（表值列只装一行字面量）', () => {
    const multiLine =
      HEADER +
      MACHINE +
      '    当 TFLAG:1：\n' +
      '        是 0：\n' +
      '            「甲」\n' +
      '            「乙」\n' +
      '        否则：\n' +
      '            「丙」\n';
    expectBlocked(multiLine, 'core/migration/switch', '多行臂');
    const withComment =
      HEADER +
      MACHINE +
      '    当 TFLAG:1：\n' +
      '        是 0：\n' +
      '            ; 说明\n' +
      '            「甲」\n' +
      '        否则：\n' +
      '            「丙」\n';
    expectBlocked(withComment, 'core/migration/switch', '臂内注释');
    const withWait =
      HEADER +
      MACHINE +
      '    当 TFLAG:1：\n' +
      '        是 0：\n' +
      '            「甲」 续\n' +
      '        否则：\n' +
      '            「丙」\n';
    expectBlocked(withWait, 'core/migration/switch', '臂内等待标记');
    // 表值列会把整数字面量解码成数值（`0x10` / `+5` 也算）⇒ 打印出来的字会变
    for (const literal of ['0x10', '+5', '-1']) {
      const intLike =
        HEADER +
        MACHINE +
        `    当 TFLAG:1：\n        是 0：\n            ${literal}\n        否则：\n            她没说话。\n`;
      expectBlocked(intLike, 'core/migration/switch', `整数字面量臂正文 ${literal}`);
    }
  });

  it('`当` 臂正文形态混用（台词 / 旁白）→ 不改写', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 TFLAG:1：\n' +
      '        是 0：\n' +
      '            「甲」\n' +
      '        否则：\n' +
      '            她什么也没说。\n';
    expectBlocked(source, 'core/migration/switch', '臂形态混用');
  });

  it('`当` 判别式带全角标点 → 不改写（2.0 表达式只认半角）', () => {
    const source =
      HEADER +
      MACHINE +
      '    当 她的好感度（内向）：\n' +
      '        是 0：\n' +
      '            「甲」\n' +
      '        否则：\n' +
      '            「乙」\n';
    expectBlocked(source, 'core/migration/switch', '判别式全角标点');
  });

  it('`分支：` 缺 `[其他]` 兜底 → 不改写（`# 池` 的 `? 否` 必填）', () => {
    const source = HEADER + MACHINE + '    分支：\n        [她的好感度 >= 500]\n            「甲」\n';
    expectBlocked(source, 'core/migration/branch', '`分支：` 缺兜底');
  });

  it('`分支：` 兜底不在最后 → 不改写', () => {
    const source =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [其他]\n' +
      '            「甲」\n' +
      '        [她的好感度 >= 500]\n' +
      '            「乙」\n';
    expectBlocked(source, 'core/migration/branch', '兜底不在最后');
  });

  it('`分支：` 正文有副作用（`!` 调用 / `@算` / `@着色`）→ 不改写（§7.1 池内禁止副作用）', () => {
    const call =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的好感度 >= 500]\n' +
      '            调用 早安()\n' +
      '        [其他]\n' +
      '            「甲」\n';
    expectBlocked(call, 'core/migration/branch', '池内函数调用');
    const color =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的好感度 >= 500]\n' +
      '            着色 0xFF8080：\n' +
      '                「甲」\n' +
      '        [其他]\n' +
      '            「乙」\n';
    expectBlocked(color, 'core/migration/branch', '池内着色');
  });

  it('`分支：` 条件带全角标点 → 不改写（2.0 表达式只认半角）', () => {
    const source =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的好感度 ＞ 500]\n' +
      '            「甲」\n' +
      '        [其他]\n' +
      '            「乙」\n';
    expectBlocked(source, 'core/migration/branch', '条件全角标点');
  });

  it('`分支：` 属 v1 可自动排序形态、但书写顺序不是排序结果 → 不改写（否则静默改命中）', () => {
    const unsorted =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的好感度 >= 100]\n' +
      '            「甲」\n' +
      '        [她的好感度 >= 500]\n' +
      '            「乙」\n' +
      '        [其他]\n' +
      '            「丙」\n';
    const result = expectBlocked(unsorted, 'core/migration/branch', '可排序但未按排序书写');
    expect(result.diagnostics.some((d) => d.message.includes('自动排序'))).toBe(true);

    // 已经按 v1 排序口径书写（严格条件在前）⇒ 可证等价，能改写
    const sorted =
      HEADER +
      MACHINE +
      '    分支：\n' +
      '        [她的好感度 >= 500]\n' +
      '            「乙」\n' +
      '        [她的好感度 >= 100]\n' +
      '            「甲」\n' +
      '        [其他]\n' +
      '            「丙」\n';
    const ok = migrateOk(sorted);
    expect(ok.code).toContain('    ? 她的好感度 >= 500\n');
    expect(ok.code.indexOf('? 她的好感度 >= 500')).toBeLessThan(ok.code.indexOf('? 她的好感度 >= 100'));
  });

  it('`初回` 空块 → 不改写（围栏不许空，v1 也报空块）', () => {
    expectBlocked(HEADER + MACHINE + '    初回 "once"：\n    普通旁白。\n', 'core/migration/ask', '空 `初回` 块');
  });

  it('`当` 只有 `否则` 一条臂 → 不改写（`# 表` 没有可分档的行）', () => {
    const source = HEADER + MACHINE + '    当 TFLAG:1：\n        否则：\n            「甲」\n';
    expectBlocked(source, 'core/migration/switch', '只有兜底的 `当`');
  });

  it('未改写的块照样按机械层原码上账，且行号回映到 v1 行（前面有成功改写也不漂）', () => {
    const source =
      HEADER +
      MACHINE +
      '    初回 "once"：\n' +
      '        「甲」\n' +
      '    当 TFLAG:1：\n' +
      '        是 0 到 5：\n' +
      '            「乙」\n' +
      '        是 3 到 8：\n' +
      '            「丙」\n' +
      '        否则：\n' +
      '            「丁」\n';
    const result = migrateKojoSourceSemantic(source);
    expect(result.ok).toBe(false);
    expect(result.rewrites.map((rewrite) => rewrite.kind)).toEqual(['ask-native']);
    expect(result.unsupported.map((entry) => [entry.line, entry.code])).toEqual([[5, 'core/migration/switch']]);
    expect(result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.span?.start.line)).toEqual([5]);
  });
});

/* ============================== 闭环：parse / 幂等 ============================== */

describe('语义升级：闭环（parse 零 error / 幂等）', () => {
  const positives: readonly (readonly [string, string])[] = [
    [
      '当→表（旁白臂）',
      HEADER + MACHINE + '    当 TFLAG:1：\n        是 0：\n            她笑了。\n        否则：\n            她没说话。\n',
    ],
    [
      '当→表（台词臂）',
      HEADER + MACHINE + '    当 恋慕：\n        是 0 到 99：\n            「甲。」\n        否则：\n            「乙。」\n',
    ],
    [
      '分支→池',
      HEADER +
        MACHINE +
        '    分支：\n        [TFLAG:1]\n            「甲。」\n        [其他]\n            > 乙。\n',
    ],
    ['初回→原生', HEADER + MACHINE + '    初回 "once"：\n        「甲」\n'],
    ['询问→原生', HEADER + MACHINE + '    询问 "想问"：\n        「甲」\n'],
    ['确认→原生', HEADER + MACHINE + '    确认 "确认"：\n        「甲」\n'],
  ];

  it('每个正例：产物过 2.0 parse 零 error，再迁移逐字节不变', () => {
    for (const [label, source] of positives) {
      const once = migrateOk(source);
      expectParsesClean(once.code);
      const twice = migrateKojoSourceSemantic(once.code);
      expect(twice.ok, label).toBe(true);
      expect(twice.code, label).toBe(once.code);
      expect(twice.rewrites, label).toEqual([]);
    }
  });

  it('已经是 2.0 的文件原样通过（语义层空转，机械层也不动）', () => {
    const canonical = fixture('semantic.kojo2');
    const result = migrateKojoSourceSemantic(canonical);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(canonical);
    expect(result.rewrites).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('产物跑完整 2.0 编译：`# 表` 判别式只求值一次、`# 池` 落 IF/ELSE、`@原生` 块内逐行透传', () => {
    const source =
      HEADER +
      '时机 开场：\n' +
      '    当 TFLAG:193：\n' +
      '        是 1：\n' +
      '            「甲。」\n' +
      '        是 2 到 3：\n' +
      '            「乙。」\n' +
      '        否则：\n' +
      '            「丙。」\n' +
      '    分支：\n' +
      '        [她的好感度 >= 500]\n' +
      '            「嗯。」\n' +
      '        [其他]\n' +
      '            「唔。」\n' +
      '    初回 "once"：\n' +
      '        「第一次呢。」\n';
    const migrated = migrateOk(source);
    const compiled = compileKojoSource({ source: migrated.code, adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([]);
    // 运行期形状与 v1 同构：分档值只算一次 ⇒ 隐藏槽 + IF 链；池在调用点展开成 IF/ELSE；
    // `@原生` 围栏体原样进产物（逃生舱口径：作者按 ERB 手改，warning 已上屏）
    expect(compiled.erb).toBe(
      'MACHINE 开场\n' +
        ';SLOT __kojo_table_迁移表1 table int\n' +
        ';SLOT __kojo_table_迁移表1__value table string\n' +
        'SET __kojo_table_迁移表1 = {TFLAG:193}\n' +
        'IF {__kojo_table_迁移表1 == 1}\n' +
        'SET __kojo_table_迁移表1__value = {"甲。"}\n' +
        'ELSEIF {__kojo_table_迁移表1 >= 2 && __kojo_table_迁移表1 <= 3}\n' +
        'SET __kojo_table_迁移表1__value = {"乙。"}\n' +
        'ELSE\n' +
        'SET __kojo_table_迁移表1__value = {"丙。"}\n' +
        'ENDIF\n' +
        'SAY 灵梦: {__kojo_table_迁移表1__value} /WAIT\n' +
        'IF {她的好感度 >= 500}\n' +
        'SAY 灵梦: 嗯。 /WAIT\n' +
        'ELSE\n' +
        'SAY 灵梦: 唔。 /WAIT\n' +
        'ENDIF\n' +
        '初回 "once"：\n' +
        '    「第一次呢。」\n' +
        'MACHINE.END\n',
    );
  });
});
