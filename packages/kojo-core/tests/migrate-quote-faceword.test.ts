/**
 * K2-MIGRATE-QUOTE / K2-EVENT-FACEWORD 回归（批次六续，§16.8 M7.1 / §15.2 / §12.1）。
 *
 * ## 两条口径（本文件是"钉住裁决"的地方）
 *
 * ### ① v1 台词的引号是**内容**，迁移必须语义保持
 *
 * v1 把 `「…」` 行连引号一起打印（`PRINTFORMW 「涩涩的话」`）；2.0 的 `角色：「…」` 引号是**语法**、
 * 只剥最外层一对（首 `「` … 末 `」`）。所以迁移把 **v1 打印文本原样**放进 2.0 正文：
 * `灵梦：「涩涩的话」`（v1 `「涩涩的话」`）⇒ `灵梦：「「涩涩的话」」` ⇒ 产物仍是
 * `PRINTFORMW 「涩涩的话」`。依据：§12.1（裸台词 → `角色：「…」`）+ §15.2.3「只换行首分类；
 * PRINT 变体、插值、转义复用」；§2.6 的转义闭集只有行首 `\` / `\{` / `\}` / `\\`，`「」` 不是
 * 需要转义的字符（可打印形态 = 放进 2.0 正文）；§4.8 的规范级约束只针对"作者文本进引擎字面量"。
 * **不丢字符**是硬线：形态不完整（未闭合 / 引号后还有正文 / 缺说话人）一律 unsupported（fail-closed）。
 * 心形是 v1 唯一把引号当语法的路径（`HPH_PRINT` 实参不含引号），迁移沿用 v1 `stripQuotesForHeart`
 * 判据：单段剥、多段原样。
 *
 * ### ② `时机` 面词只认 adapter `eventCatalog`
 *
 * 迁移器不内置任何事件名（core 零游戏知识）；`options.eventNames` 是宿主交进来的 adapter 名字投影。
 * 给了目录而面词不在其中 ⇒ 迁移期 unsupported（带"可迁的事件名"提示），**不产 `# 机`**；命名参数
 * （`成否:` / `类型:` / `参数:`）同样 unsupported 且台账点名——两条都不静默丢。
 */
import { describe, expect, it } from 'vitest';

import {
  ERATW_EVENT_NAMES,
  ERATW_GAME_ADAPTER,
  createEratwEmitBackend,
} from '../../plugins/eratw-adapter/src/kojo2/index.js';
import { compileKojoSource, parseSource } from '../src/index.js';
import { migrateKojoSource, normalizeMachine } from '../src/migrate/index.js';
import { migrateKojoSourceSemantic } from '../src/migrate/semantic.js';

/* ============================== 夹具：真 eraTW backend ============================== */

const backend = createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });

/** 取色口径与迁移语料同源：`narrationColor = default`（v1 未声明旁白色时旁白是 D 系） */
const ADAPTER = Object.freeze({
  ...ERATW_GAME_ADAPTER,
  profile: Object.freeze({ ...ERATW_GAME_ADAPTER.profile, narrationColor: 'default' as const }),
});

const compile2 = (source: string) => compileKojoSource({ source, adapter: ADAPTER, backend });
const erbOf = (source: string): string => {
  const result = compile2(source);
  expect(result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([]);
  return result.erb;
};

/** 机械层迁移（断言 ok 时把台账打进消息） */
function migrated(source: string, options: Parameters<typeof migrateKojoSource>[1] = {}) {
  const result = migrateKojoSource(source, options);
  expect(result.ok, `unexpected unsupported: ${JSON.stringify(result.unsupported)}`).toBe(true);
  return result;
}

const MACHINE = '时机 指令 310：\n';
const HEADER = '角色: 灵梦\n';

/* ============================== ① 引号：语义保持 ============================== */

describe('引号口径：v1 台词「…」是内容，迁移后仍打印引号', () => {
  it('裸台词 → `角色：「「…」」`，产物逐字含引号（端到端 golden）', () => {
    const result = migrated(`${HEADER}${MACHINE}    「涩涩的话」\n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「涩涩的话」」\n');
    const erb = erbOf(result.code);
    expect(erb).toContain('PRINTFORMW 「涩涩的话」');
  });

  it('空台词 `「」`：v1 打印两个引号，迁移不吞（`「「」」`）', () => {
    const result = migrated(`${HEADER}${MACHINE}    「」\n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「」」\n');
    expect(erbOf(result.code)).toContain('PRINTFORMW 「」');
  });

  it('台词里本来就带引号：内层原样（`「他说「你好」」`）', () => {
    const result = migrated(`${HEADER}${MACHINE}    「他说「你好」」\n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「他说「你好」」」\n');
    expect(erbOf(result.code)).toContain('PRINTFORMW 「他说「你好」」');
  });

  it('半角旧引号 `｢…｣` 按 §12.1 归一成全角，内容仍保留引号', () => {
    const result = migrated(`${HEADER}${MACHINE}    ｢你好。｣\n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「你好。」」\n');
  });

  it('行尾等待标记：`~` / `续` 都归一到 `续`，引号内容不变', () => {
    expect(migrated(`${HEADER}${MACHINE}    「甲」 ~\n`).code).toBe('# 机 指令 310\n灵梦：「「甲」」 续\n');
    expect(migrated(`${HEADER}${MACHINE}    「甲」 续\n`).code).toBe('# 机 指令 310\n灵梦：「「甲」」 续\n');
    const erb = erbOf(migrated(`${HEADER}${MACHINE}    「甲」 续\n`).code);
    expect(erb).toContain('PRINTFORML 「甲」');
  });

  it('旁白不套语法引号：正文里的引号是正文（`> 她说「你好」`）', () => {
    const result = migrated(`${HEADER}${MACHINE}    她说「你好」。\n`);
    expect(result.code).toBe('# 机 指令 310\n> 她说「你好」。\n');
    expect(erbOf(result.code)).toContain('她说「你好」。');
  });

  it('fail-closed：缺说话人的裸台词 → unsupported（不产丢引号/丢字的产物）', () => {
    const result = migrateKojoSource(`${MACHINE}    「你好。」\n`);
    expect(result.ok).toBe(false);
    expect(result.unsupported).toEqual([
      {
        line: 2,
        construct: '裸台词（缺说话人）',
        targetHint: expect.stringContaining('角色'),
        code: 'core/narrative/bare-quote',
      },
    ]);
    // 原行逐字保留（调用方见 ok=false 不许写盘）；可迁移的 `时机` 头照常迁
    expect(result.code).toBe('# 机 指令 310\n    「你好。」\n');
  });

  it('fail-closed：引号未闭合 / 引号后还有正文 → unsupported', () => {
    expect(migrateKojoSource(`${HEADER}${MACHINE}    「你好\n`).unsupported[0]!.code).toBe(
      'core/narrative/bare-quote',
    );
    expect(migrateKojoSource(`${HEADER}${MACHINE}    「你好」剩下\n`).unsupported[0]!.code).toBe(
      'core/migration/raw',
    );
  });

  it('`选项` 条目正文照常保引号；条目标签是 UI 字面量不动', () => {
    const result = migrated(`${HEADER}${MACHINE}    选项：\n        「好」：\n            「嗯。」\n`);
    expect(result.code).toBe(
      '# 机 指令 310\n选项：\n    「好」：\n        灵梦：「「嗯。」」\n',
    );
    expect(erbOf(result.code)).toContain('「嗯。」');
  });

  it('`@随机` 候选（含 `@组` 内候选）照常保引号', () => {
    const result = migrated(
      `${HEADER}${MACHINE}    随机：\n        「甲。」\n        组：\n            「乙。」\n            旁白。\n`,
    );
    expect(result.code).toContain('@随机\n    灵梦：「「甲。」」\n    @组\n        灵梦：「「乙。」」\n        > 旁白。\n');
    const erb = erbOf(result.code);
    expect(erb).toContain('「甲。」');
    expect(erb).toContain('「乙。」');
  });

  it('`心形 「…」`：v1 心形剥引号 ⇒ 迁移**不**额外套引号（与 v1 产物一致）', () => {
    const result = migrated(`${HEADER}${MACHINE}    心形 「……嗯。」\n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「……嗯。」(心形)\n');
    const erb = erbOf(result.code);
    expect(erb).toContain('CALL HPH_PRINT(@"……嗯。","w")');
    expect(erb).not.toContain('「……嗯。」');
  });

  it('`心形` 多段文本（`「甲」「乙」`）：v1 原样打印 ⇒ 迁移保引号', () => {
    const result = migrated(`${HEADER}${MACHINE}    心形 「甲」「乙」\n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「甲」「乙」」(心形)\n');
    expect(erbOf(result.code)).toContain('CALL HPH_PRINT(@"「甲」「乙」","w")');
  });

  it('`你：` 心形自机前缀：`你：「…」` 不变形（v1 心形剥引号）', () => {
    const result = migrated(`${HEADER}${MACHINE}    心形：\n        你：「我也很高兴。」\n`);
    expect(result.code).toBe('# 机 指令 310\n你：「我也很高兴。」(心形)\n');
    expect(erbOf(result.code)).toContain('CALL HPH_PRINT(@"我也很高兴。","w")');
  });

  it('`# 表` 台词臂：值列收**打印文本**（含引号），引用点仍 `角色：「{表}」`', () => {
    const source =
      `${HEADER}${MACHINE}` +
      '    当 恋慕：\n' +
      '        是 0：\n            「甲。」\n' +
      '        否则：\n            「乙。」\n';
    const result = migrateKojoSourceSemantic(source);
    expect(result.ok, JSON.stringify(result.unsupported)).toBe(true);
    expect(result.code).toBe(
      '# 表 迁移表1 由 恋慕\n    0 「甲。」\n    否 「乙。」\n\n# 机 指令 310\n灵梦：「{迁移表1}」\n',
    );
    const erb = erbOf(result.code);
    expect(erb).toContain('__kojo_table_迁移表1__value = "「甲。」"');
    expect(erb).toContain('PRINTFORMW %__kojo_table_迁移表1__value%');
  });

  it('`# 池` 台词分支：分支正文保引号，池仍是 `? 否` 收束（2.0 可编译）', () => {
    const source =
      `${HEADER}${MACHINE}` +
      '    分支：\n' +
      '        [她的好感度 >= 500]\n            「嗯。」\n' +
      '        [其他]\n            「唔。」\n';
    const result = migrateKojoSourceSemantic(source);
    expect(result.ok, JSON.stringify(result.unsupported)).toBe(true);
    expect(result.code).toContain('灵梦：「「嗯。」」\n');
    expect(result.code).toContain('灵梦：「「唔。」」\n');
    expect(erbOf(result.code)).toContain('PRINTFORMW 「嗯。」');
  });

  it('幂等：迁移产物再迁移逐字节不变（含嵌套引号）', () => {
    const first = migrated(`${HEADER}${MACHINE}    「他说「你好」」 ~\n`).code;
    const second = migrateKojoSource(first);
    expect(second.ok).toBe(true);
    expect(second.code).toBe(first);
    // 已是 2.0 的 `角色：「「…」」` 不会被二次套引号
    expect(first).toBe('# 机 指令 310\n灵梦：「「他说「你好」」」 续\n');
  });

  it('v1 台词行尾的空白也保留（v1 照打；不丢字符）', () => {
    const result = migrated(`${HEADER}${MACHINE}    「甲」  \n`);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「甲」  」\n');
    // 2.0 语法只剥最外层一对，空白仍在正文里
    expect(parseSource(result.code).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('编码面：BOM + CRLF 原样保留（引号改写不动字节序）', () => {
    const result = migrated(`\uFEFF${HEADER.replace(/\n/g, '\r\n')}时机 指令 310：\r\n    「甲」\r\n`);
    expect(result.code).toBe('\uFEFF# 机 指令 310\r\n灵梦：「「甲」」\r\n');
  });

  it('迁移产物过 2.0 parse 零 error（引号嵌套不破语法）', () => {
    const code = migrated(`${HEADER}${MACHINE}    「他说「你好」」\n`).code;
    expect(parseSource(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

/* ============================== ② 面词白名单 / 命名参数台账 ============================== */

describe('`时机` 面词白名单（adapter eventCatalog 注入）', () => {
  const AUTO = { eventNames: ERATW_EVENT_NAMES };

  it('目录内面词：`时机 指令 310` → `# 机 指令 310`（照常迁移）', () => {
    const result = migrated(`${HEADER}${MACHINE}    「甲」\n`, AUTO);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「「甲」」\n');
  });

  it.each([
    ['日常 4', '日常'],
    ['事件 22', '事件'],
    ['标记', '标记'],
  ])('目录外面词 `%s` → unsupported（不产 `# 机`）', (rest, face) => {
    const result = migrateKojoSource(`${HEADER}时机 ${rest}：\n    「甲」\n`, AUTO);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.code).toContain(`时机 ${rest}：\n    「甲」\n`);
    const entry = result.unsupported[0]!;
    expect(entry.code).toBe('core/migration/timing');
    expect(entry.line).toBe(2);
    expect(entry.construct).toContain(`「${face}」`);
    // 提示必须列出可迁的事件名（九事件，来自 adapter，不是 core 内置）
    for (const eventName of ERATW_EVENT_NAMES) expect(entry.targetHint).toContain(eventName);
  });

  it('不传 eventNames：不猜目录、沿用形状判定（app 未接线口径，行为固定）', () => {
    const result = migrateKojoSource(`${HEADER}时机 事件 100：\n    「甲」\n`);
    expect(result.ok).toBe(true);
    expect(result.code).toContain('# 机 事件 100\n');
  });

  it('空目录（adapter 没声明事件）→ unsupported，提示补 adapter 契约', () => {
    const result = migrateKojoSource(`${HEADER}${MACHINE}    「甲」\n`, { eventNames: [] });
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.unsupported[0]!.targetHint).toContain('eventCatalog');
  });

  it('`# 时机 <事件>` 旧声明形同判据：目录外 → unsupported（不产 `# 机`）', () => {
    const result = migrateKojoSource(`${HEADER}# 时机 事件 100\n`, AUTO);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('# 时机 事件 100\n');
    expect(result.unsupported[0]!.construct).toContain('「事件」');
  });

  it('`# 时机 指令 310` 目录内 → `# 机 指令 310`', () => {
    const result = migrated(`${HEADER}# 时机 指令 310\n`, AUTO);
    expect(result.code).toBe('# 机 指令 310\n');
  });

  it('多 `时机` 块优先报"拆文件"（面词目录不是第一判据）', () => {
    const result = migrateKojoSource(
      `${HEADER}时机 日常 4：\n    「甲」\n时机 指令 310：\n    「乙」\n`,
      AUTO,
    );
    expect(result.ok).toBe(false);
    expect(result.unsupported.map((entry) => entry.construct)).toEqual([
      '多个 `时机` 块（2.0 一个文件只写一个 `# 机`）',
      '多个 `时机` 块（2.0 一个文件只写一个 `# 机`）',
    ]);
  });

  it('命名参数 `成否:` → unsupported 台账点名（不静默丢）', () => {
    const result = migrateKojoSource(
      `${HEADER}时机 指令 310 成否: 游戏判定：\n    「甲」\n`,
      AUTO,
    );
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    const entry = result.unsupported[0]!;
    expect(entry.code).toBe('core/migration/timing');
    expect(entry.construct).toContain('命名参数');
    expect(entry.construct).toContain('成否');
    expect(entry.targetHint).toContain('adapter');
  });

  it('命名参数 `类型:` → unsupported（含英文别名 `args:` 与 `参数:`）', () => {
    const typed = migrateKojoSource(`${HEADER}时机 指令 310 类型: SCOM：\n    「甲」\n`, AUTO);
    expect(typed.unsupported[0]!.construct).toContain('类型');
    const args = migrateKojoSource(`${HEADER}时机 指令 310 参数: ARG, ARG:1：\n    「甲」\n`, AUTO);
    expect(args.unsupported[0]!.construct).toContain('参数');
    // 取值里的 `ARG:1` 不被误当命名参数（只点名 `参数`）
    expect(args.unsupported[0]!.construct).not.toContain('`ARG:`');
    const alias = migrateKojoSource(`${HEADER}时机 指令 310 args: ARG：\n    「甲」\n`, AUTO);
    expect(alias.unsupported[0]!.construct).toContain('args');
  });

  it('块尾空值形（`时机 事件 1 参数：`）：冒号被块头吃掉也认命名参数', () => {
    const result = migrateKojoSource(`${HEADER}时机 事件 1 参数：\n    「甲」\n`, AUTO);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.unsupported[0]!.construct).toContain('参数');
  });

  it('台账行号回映 v1（语义层改写后行号不漂）', () => {
    const source =
      `${HEADER}${MACHINE}` +
      '    初回 "once"：\n        「甲」\n' +
      '    循环 3 次：\n        「乙」\n    循环结束\n';
    const result = migrateKojoSourceSemantic(source, AUTO);
    expect(result.ok).toBe(false);
    // `初回` 块（3-4 行）先改写成 `@原生`，`循环` 块仍是 unsupported——台账行号必须回映到 v1 第 5 / 7 行
    expect(result.unsupported.map((entry) => [entry.line, entry.code])).toEqual([
      [5, 'core/migration/loop'],
      [7, 'core/migration/loop'],
    ]);
    expect(result.rewrites.map((rewrite) => rewrite.kind)).toEqual(['ask-native']);
  });

  it('EOL 保留：CRLF 源在面词 unsupported 时仍 CRLF（原块逐字保留）', () => {
    const result = migrateKojoSource(
      `角色: 灵梦\r\n时机 日常 4：\r\n    「甲」\r\n`,
      AUTO,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('时机 日常 4：\r\n    「甲」\r\n');
  });

  it('旧入口 `normalizeMachine` 保留：只判形状、不判面词', () => {
    expect(normalizeMachine('指令 310')).toBe('指令 310');
    expect(normalizeMachine('  ')).toBeNull();
    expect(normalizeMachine('指令 310 成否: 游戏判定')).toBeNull();
    expect(normalizeMachine('事件 22 多 余 段')).toBeNull();
  });
});
