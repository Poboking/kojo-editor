/**
 * K2-MIGRATE-SHAPE 回归（批次七，§16.8 M7.1 / §15.2 / §12.1）。
 *
 * 钉三件 batch-6 交接的缺口：
 *
 * ### ① `时机` 参数**形状**按 adapter 目录校验（additive `MigrateOptions.eventArgs`）
 * `eventNames` 只挡面词；`时机 初见 3`（目录内面词、参数多）仍会产 `# 机 初见 3`，在 2.0 编译期
 * 撞 `event/argument`。本批把 `eventCatalog.events[].args` 的投影交进迁移器：面词命中后按目录核
 * 参数个数 / 必填 / 整数形状，不合即 unsupported（**不产 `# 机`**）。**没给就不猜**——参数原样带过去。
 *
 * ### ② v1 `角色：「…」` 与 2.0 台词同形（`core/migration/ambiguous-dialogue`）
 * v1 没有"说话人前缀"语法：`角色：「…」` 是**连前缀与引号一起打印**的旁白文本；2.0 同一行是台词
 * （只打印引号内正文）。判据（写死在 `migrate/index.ts::reshapeV1DialogueLike`）：
 * - 只有输入里存在 v1 专属构造才裁决（纯 2.0 输入一律原样放行 = 幂等）；
 * - `你：「…」` 是 v1 自机前缀（`codegen.ts::isPlayerLine`）⇒ 按台词迁移、正文 = 前缀后的打印文本；
 * - 已知 v1 说话人 S 且前缀 ≠ S ⇒ 可证不是说话人前缀 ⇒ 按旁白打印迁移（整行逐字）；
 * - 前缀 = S 或 S 未知 ⇒ 证不出 ⇒ 保留台词 + warning（不进 `ok`，不静默）。
 *
 * ### ③ `# 表` 值列是字面量（不插值）
 * v1 `当` 的臂正文带 `{}` 时语义层拒绝改写成 `# 表`；机械层台账必须给出可行动落点
 * （`?` 链 / `@原生`），而不是继续建议"值查找写 `# 表`"。
 */
import { describe, expect, it } from 'vitest';

import {
  ERATW_EVENT_CATALOG,
  ERATW_EVENT_NAMES,
  ERATW_GAME_ADAPTER,
  createEratwEmitBackend,
} from '../../plugins/eratw-adapter/src/kojo2/index.js';
import { compileKojoSource } from '../src/index.js';
import { migrateKojoSource, projectEventArgs, type MigrateOptions } from '../src/migrate/index.js';
import { migrateKojoSourceSemantic } from '../src/migrate/semantic.js';

/* ============================== 夹具 ============================== */

/** adapter 事件目录的参数形状投影（宿主/conformance 同一条路：`projectEventArgs`） */
const EVENT_ARGS = projectEventArgs(ERATW_EVENT_CATALOG);

/** 宿主接线形状：面词白名单 + 参数形状一起注入 */
const CATALOG: MigrateOptions = { eventNames: ERATW_EVENT_NAMES, eventArgs: EVENT_ARGS };

const backend = createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
/** 取色口径与迁移语料同源（v1 未声明旁白色时旁白是 D 系） */
const ADAPTER = Object.freeze({
  ...ERATW_GAME_ADAPTER,
  profile: Object.freeze({ ...ERATW_GAME_ADAPTER.profile, narrationColor: 'default' as const }),
});

const migrate = (source: string, options: MigrateOptions = {}) => migrateKojoSource(source, options);
const warnings = (result: ReturnType<typeof migrate>) =>
  result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
const ambiguous = (result: ReturnType<typeof migrate>) =>
  result.diagnostics.filter((diagnostic) => diagnostic.code === 'core/migration/ambiguous-dialogue');
const compile2 = (source: string) => compileKojoSource({ source, adapter: ADAPTER, backend });

/* ============================== ① 参数形状 ============================== */

describe('`时机` 参数形状：按 adapter 目录校验（eventArgs 注入）', () => {
  it('投影：`projectEventArgs` 与 `ERATW_EVENT_CATALOG.events[].args` 逐项相等（required 取反）', () => {
    expect(Object.keys(EVENT_ARGS)).toEqual([...ERATW_EVENT_NAMES]);
    expect(EVENT_ARGS['初见']).toEqual([]);
    expect(EVENT_ARGS['指令']).toEqual([{ name: '编号', optional: true, kind: 'int' }]);
    for (const spec of ERATW_EVENT_CATALOG.events) expect(EVENT_ARGS[spec.event]).toHaveLength(spec.args.length);
  });

  it('目录内面词 + 参数合形状：`时机 指令 310` → `# 机 指令 310`（不误伤）', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    「甲」\n', CATALOG);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 指令 310\n12：「「甲」」\n');
  });

  it('可选参数可以省略：`时机 指令` → `# 机 指令`', () => {
    const result = migrate('角色: 12\n时机 指令：\n    「甲」\n', CATALOG);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 指令\n12：「「甲」」\n');
  });

  it('0 参事件带编号：`时机 初见 3` → unsupported（不产 `# 机`，原块逐字保留）', () => {
    const result = migrate('角色: 12\n时机 初见 3：\n    「甲」\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.code).toBe('时机 初见 3：\n    「甲」\n');
    const entry = result.unsupported[0]!;
    expect(entry.line).toBe(2);
    expect(entry.code).toBe('core/migration/timing');
    expect(entry.construct).toContain('参数过多');
    expect(entry.construct).toContain('初见');
    expect(entry.targetHint).toContain('@原生');
    expect(result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([
      'core/migration/timing',
    ]);
  });

  it('参数超过上限：`时机 指令 310 311` → unsupported，点名多出的段', () => {
    const result = migrate('角色: 12\n时机 指令 310 311：\n    「甲」\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.unsupported[0]!.construct).toContain('参数过多');
    expect(result.unsupported[0]!.construct).toContain('311');
  });

  it('int 参数给了非整数（v1 中文指令名）：`时机 指令 摸屁股` → unsupported', () => {
    const result = migrate('角色: 12\n时机 指令 摸屁股：\n    「甲」\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.unsupported[0]!.construct).toContain('必须是整数');
    expect(result.unsupported[0]!.targetHint).toContain('编号');
  });

  it('`名称=值` 配置形：`时机 指令 编号=310` → unsupported（位置参数只写值）', () => {
    const result = migrate('角色: 12\n时机 指令 编号=310：\n    「甲」\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.unsupported[0]!.construct).toContain('配置形');
    expect(result.unsupported[0]!.targetHint).toContain('adapter');
  });

  it('也吃 adapter 原样 `EventArgumentSpec[]`（`required` 字段）：`时机 指令` 的可选参数不被误判成必填', () => {
    const rawArgs = { 指令: ERATW_EVENT_CATALOG.events.find((spec) => spec.event === '指令')!.args };
    const optionalOk = migrate('角色: 12\n时机 指令：\n    「甲」\n', { eventArgs: rawArgs });
    expect(optionalOk.ok).toBe(true);
    expect(optionalOk.code).toContain('# 机 指令\n');
    const intShape = migrate('角色: 12\n时机 指令 摸屁股：\n    「甲」\n', { eventArgs: rawArgs });
    expect(intShape.ok).toBe(false);
    expect(intShape.unsupported[0]!.construct).toContain('必须是整数');
  });

  it('`名称 值` 两段配置形：`时机 织入 甲 1`（首段与目录参数名同名）→ unsupported', () => {
    const options: MigrateOptions = { eventArgs: { 织入: [{ name: '甲' }, { name: '乙', optional: true }] } };
    const result = migrate('角色: 12\n时机 织入 甲 1：\n    「甲」\n', options);
    expect(result.ok).toBe(false);
    expect(result.unsupported[0]!.construct).toContain('配置形');
    expect(result.unsupported[0]!.targetHint).toContain('@原生');
  });

  it('必填参数不够：2 参事件只给 1 个 → unsupported（点名必填参数）', () => {
    const options: MigrateOptions = { eventArgs: { 织入: [{ name: '甲' }, { name: '乙' }] } };
    const result = migrate('角色: 12\n时机 织入 1：\n    「甲」\n', options);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 机');
    expect(result.unsupported[0]!.construct).toContain('参数不足');
    expect(result.unsupported[0]!.construct).toContain('甲');
  });

  it('必填参数全给：2 参事件给 2 个 → 合法（可选性按目录而不是按段数猜）', () => {
    const options: MigrateOptions = { eventArgs: { 织入: [{ name: '甲' }, { name: '乙', optional: true }] } };
    const ok = migrate('角色: 12\n时机 织入 1 2：\n    「甲」\n', options);
    expect(ok.ok).toBe(true);
    expect(ok.code).toBe('# 机 织入 1 2\n12：「「甲」」\n');
    const missingRequired = migrate('角色: 12\n时机 织入：\n    「甲」\n', options);
    expect(missingRequired.ok).toBe(false);
    expect(missingRequired.unsupported[0]!.construct).toContain('参数不足');
  });

  it('未给 `eventArgs` ⇒ 不猜参数（只给 eventNames 时 `时机 初见 3` 照旧产 `# 机`）', () => {
    const result = migrate('角色: 12\n时机 初见 3：\n    「甲」\n', { eventNames: ERATW_EVENT_NAMES });
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 初见 3\n12：「「甲」」\n');
  });

  it('完全不给目录 ⇒ 沿用 v1 形状判定（老行为固定）', () => {
    const result = migrate('角色: 12\n时机 初见 3：\n    「甲」\n');
    expect(result.ok).toBe(true);
    expect(result.code).toContain('# 机 初见 3\n');
  });

  it('只给 `eventArgs` 也能判：目录里有的面词按形状核，没有的面词不猜', () => {
    const rejected = migrate('角色: 12\n时机 初见 3：\n    「甲」\n', { eventArgs: EVENT_ARGS });
    expect(rejected.ok).toBe(false);
    expect(rejected.unsupported[0]!.construct).toContain('参数过多');
    const unknownFace = migrate('角色: 12\n时机 未知 3：\n    「甲」\n', { eventArgs: EVENT_ARGS });
    expect(unknownFace.ok).toBe(true);
    expect(unknownFace.code).toContain('# 机 未知 3\n');
  });

  it('目录投影是局部的（该面词没有条目）⇒ 不猜参数，不把"没给事实"记成错误', () => {
    const result = migrate('角色: 12\n时机 指令 310 311：\n    「甲」\n', {
      eventNames: ERATW_EVENT_NAMES,
      eventArgs: { 初见: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain('# 机 指令 310 311\n');
  });

  it('`# 时机 <事件>` 旧声明形同判据：`# 时机 初见 3` → unsupported（不产 `# 机`）', () => {
    const result = migrate('角色: 12\n# 时机 初见 3\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('# 时机 初见 3\n');
    expect(result.unsupported[0]!.code).toBe('core/migration/timing');
    expect(result.unsupported[0]!.construct).toContain('参数过多');
  });

  it('EOL 保真：CRLF 源在参数形状 unsupported 时仍 CRLF（原块逐字保留）', () => {
    const result = migrate('角色: 12\r\n时机 初见 3：\r\n    「甲」\r\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('时机 初见 3：\r\n    「甲」\r\n');
  });

  it('目录键不经原型链：面词写 `__proto__` 不崩、也不把原型对象当参数表', () => {
    const result = migrate('角色: 12\n时机 __proto__ 1：\n    「甲」\n', { eventArgs: EVENT_ARGS });
    expect(result.ok).toBe(true);
    expect(result.code).toContain('# 机 __proto__ 1\n');
  });

  it('幂等：参数形状通过的产物再迁移逐字节不变（`# 机` 不再被当 v1 块头）', () => {
    const once = migrate('角色: 12\n时机 指令 310：\n    「甲」\n', CATALOG);
    expect(once.ok).toBe(true);
    const twice = migrate(once.code, CATALOG);
    expect(twice.ok).toBe(true);
    expect(twice.code).toBe(once.code);
  });
});

/* ============================== ② 同形歧义 ============================== */

describe('v1 `角色：「…」` 同形歧义：可证判据 + 显式 warning 台账', () => {
  it('前缀 ≠ v1 说话人 ⇒ 可证是 v1 旁白打印：整行逐字迁成 `> …`', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    灵梦：「甲」\n', CATALOG);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 指令 310\n> 灵梦：「甲」\n');
    expect(ambiguous(result)).toEqual([]);
    // 产物打印的就是 v1 的整行文本（前缀 + 引号都在正文里）
    expect(compile2(result.code).erb).toContain('PRINTFORMW 灵梦：「甲」');
  });

  it('旁白改写保留行尾 `续`（v1 等待语义不变）', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    灵梦：「甲」 续\n', CATALOG);
    expect(result.code).toBe('# 机 指令 310\n> 灵梦：「甲」 续\n');
  });

  it('前缀 = v1 文件头说话人 ⇒ 证不出（可能已手改成 2.0）⇒ 保留台词 + warning，不阻断', () => {
    const result = migrate('角色: 灵梦\n时机 指令 310：\n    灵梦：「甲」\n', CATALOG);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「甲」\n');
    expect(ambiguous(result)).toHaveLength(1);
    expect(ambiguous(result)[0]!.severity).toBe('warning');
    expect(ambiguous(result)[0]!.span?.start.line).toBe(3);
    expect(ambiguous(result)[0]!.message).toContain('> 灵梦：「…」');
    expect(result.unsupported).toEqual([]);
  });

  it('文件没有 v1 说话人事实（无 `角色:`）⇒ 证不出 ⇒ 保留台词 + warning', () => {
    const result = migrate('时机 指令 310：\n    灵梦：「甲」\n', CATALOG);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 指令 310\n灵梦：「甲」\n');
    expect(ambiguous(result)).toHaveLength(1);
    expect(ambiguous(result)[0]!.message).toContain('没有 v1 说话人声明');
  });

  it('旁白改写撞行尾半角括号（2.0 会当表演提示）⇒ fail-closed，不产改变打印文本的旁白', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    灵梦：「甲」(微笑)\n', CATALOG);
    expect(result.ok).toBe(false);
    expect(result.unsupported[0]!.code).toBe('core/migration/raw');
    expect(result.unsupported[0]!.targetHint).toContain('全角');
    expect(result.code).toContain('    灵梦：「甲」(微笑)\n');
  });

  it('v1 `你：` 是已知的自机前缀 ⇒ 按台词迁，正文 = 前缀后的打印文本（引号不丢）', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    你：「甲」\n', CATALOG);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('# 机 指令 310\n你：「「甲」」\n');
    expect(compile2(result.code).erb).toContain('PRINTFORMW 「甲」');
  });

  it('v1 `你：` + 行尾 `续` / 多段引号：打印文本整段进正文', () => {
    const wait = migrate('角色: 12\n时机 指令 310：\n    你：「甲」 续\n', CATALOG);
    expect(wait.code).toBe('# 机 指令 310\n你：「「甲」」 续\n');
    const multi = migrate('角色: 12\n时机 指令 310：\n    你：「甲」「乙」\n', CATALOG);
    expect(multi.code).toBe('# 机 指令 310\n你：「「甲」「乙」」\n');
  });

  it('`你 ：`（冒号前有空格）不是 v1 自机前缀 ⇒ 按普通前缀判：不是说话人 ⇒ 旁白打印', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    你 ：「甲」\n', CATALOG);
    expect(result.code).toBe('# 机 指令 310\n> 你 ：「甲」\n');
    expect(ambiguous(result)).toEqual([]);
  });

  it('自机前缀改写幂等：产物再迁移不再套第四层引号', () => {
    const once = migrate('角色: 12\n时机 指令 310：\n    你：「甲」\n', CATALOG);
    const twice = migrate(once.code, CATALOG);
    expect(twice.code).toBe(once.code);
    // 已经是我们产物形状的输入（正文本身带引号）原样放行
    const already = migrate('角色: 12\n时机 指令 310：\n    你：「「甲」」\n', CATALOG);
    expect(already.code).toBe('# 机 指令 310\n你：「「甲」」\n');
  });

  it('纯 2.0 输入一律原样放行（文件级门）：即使传了 speaker/目录也不改写、不报歧义', () => {
    const source = '# 机 指令 310\n灵梦：「甲」\n';
    const result = migrate(source, { ...CATALOG, speaker: '12' });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(source);
    expect(result.diagnostics).toEqual([]);
  });

  it('语义层也不猜同形：`当` 的臂正文是 `灵梦：「甲」` ⇒ 不改写 `# 表`，整块 unsupported', () => {
    const source =
      '角色: 12\n时机 指令 310：\n    当 心情：\n        是 0：\n            灵梦：「甲」\n        否则：\n            灵梦：「乙」\n';
    const result = migrateKojoSourceSemantic(source, CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 表');
    expect(result.unsupported[0]!.code).toBe('core/migration/switch');
    expect(result.unsupported[0]!.targetHint).toContain('同形歧义');
    expect(result.code).toContain('            灵梦：「甲」\n');
  });

  it('语义层也不猜同形：`分支：` 正文是 `灵梦：「甲」` ⇒ 不改写 `# 池`，整块 unsupported', () => {
    const source =
      '角色: 12\n时机 指令 310：\n    分支：\n        [恋慕 >= 1]\n            灵梦：「甲」\n        [其他]\n            「乙」\n';
    const result = migrateKojoSourceSemantic(source, CATALOG);
    expect(result.ok).toBe(false);
    expect(result.code).not.toContain('# 池');
    expect(result.unsupported[0]!.code).toBe('core/migration/branch');
    expect(result.unsupported[0]!.targetHint).toContain('同形歧义');
  });

  it('2.0 缩进块体 / `选项` 不算 v1 证据：`@算` 体赋值 + 选项台词不触发歧义 warning', () => {
    const source =
      '# 机 指令 310\n' +
      '@算\n    心情 = 1\n' +
      '选项：\n    「好」：\n        灵梦：「甲」\n' +
      '灵梦：「乙」\n';
    const result = migrate(source);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(source);
    expect(ambiguous(result)).toEqual([]);
  });

  it('旁白改写的 sourceMap 回映到 v1 行（新行 → 旧行）', () => {
    const result = migrate('角色: 12\n时机 指令 310：\n    灵梦：「甲」\n', CATALOG);
    expect(result.sourceMap).toEqual([2, 3]);
  });

  it('旁白改写幂等：产物再迁移逐字节不变（`>` 行不会被当成台词形）', () => {
    const once = migrate('角色: 12\n时机 指令 310：\n    灵梦：「甲」\n', CATALOG);
    const twice = migrate(once.code, CATALOG);
    expect(twice.code).toBe(once.code);
  });
});

/* ============================== ③ `# 表` 值列 ============================== */

describe('`# 表` 值列是字面量：fail-closed 的 targetHint 必须可行动', () => {
  it('v1 `当` 的臂正文带 `{}`：不改写 `# 表`，台账给出 `?` 链 / `@原生` 落点', () => {
    const source =
      '角色: 12\n时机 指令 310：\n    当 心情：\n        是 0：\n            「她{恋慕}。」\n        否则：\n            「乙。」\n';
    const result = migrateKojoSourceSemantic(source);
    expect(result.ok).toBe(false);
    const entry = result.unsupported[0]!;
    expect(entry.code).toBe('core/migration/switch');
    // 具体原因（值列不插值）与可行动落点都进 targetHint，而不是只建议继续写 `# 表`
    expect(entry.targetHint).toContain('值列');
    expect(entry.targetHint).toContain('不做插值');
    expect(entry.targetHint).toContain('?` 链');
    expect(entry.targetHint).toContain('@原生');
    expect(entry.targetHint).toContain('{}');
    // warning 里也有同一原因，便于逐条上屏
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'core/migration/switch' && diagnostic.message.includes('不做插值'),
      ),
    ).toBe(true);
    // 不产半成品：`当` 块原样保留
    expect(result.code).toContain('    当 心情：\n        是 0：\n            「她{恋慕}。」\n');
  });

  it('2.0 `# 表` 值列含 `{}` 仍 fail-closed（编译期拒绝，不静默打印）', () => {
    const result = compile2('# 机 指令 310\n# 表 心情 由 恋慕\n    0 她{}。\n    否 未知\n\n> {心情}\n');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/lex/interpolation');
  });
});
