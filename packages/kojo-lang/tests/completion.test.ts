/**
 * K2-EDITOR-SEMANTIC · `kojo2` 补全候选（纯函数）行为闸。
 *
 * 覆盖面：
 * - 五锚点 / 声明词 / `# 机` 事件 / 域符号 / 表·池·模·函名单；
 * - 位置门：台词正文不补、`@原生` 体内不补、注释不补；`{…}` 插值内例外；
 * - 名单零手抄：事件与 adapter `ERATW_EVENT_CATALOG` 逐项相等，声明词与 core
 *   `KOJO_DECL_WORDS` 同引用，域符号与 core `KOJO_DOMAIN_SYMBOL_NAMES` 同引用；
 * - 候选只按前缀裁剪，不做 Monaco 翻译（`insertText` 就是原文名）。
 *
 * B3c 车道 2（2026-10-28）：本闸从 `packages/app/tests/kojo2-completion.test.ts` **整枚搬进包**
 * ——判据住了包（`src/completion.ts`），闸就住包，否则"包改了、宿主闸还绿"。断言一条未减
 * （82 条），只换了 import 出处与夹具落点（`tests/fixtures/kojo2/`，逐字节相同）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KOJO_DECL_WORDS,
  KOJO_DOMAIN_SYMBOL_NAMES,
  KOJO_FACE_OBJECT_WORDS,
  KOJO_STORAGE_WORDS,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
  KOJO_TYPE_WORDS,
  eventNames,
  parseSource,
  projectEventArgs,
  type KojoDecl,
} from '@kojo/kojo-core';
import { ERATW_EVENT_CATALOG, ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import { ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter';
import {
  KOJO2_ANCHOR_CHARS,
  kojo2CompletionAt,
  kojo2EventNamesOf,
  type Kojo2CompletionCandidate,
  type Kojo2CompletionKind,
} from '../src/completion';
import { kojo2CompletionSnippets, kojo2SnippetCandidatesAt } from '../src/completion-snippets';
import {
  KOJO2_DECL_WORD_BY_KIND,
  KOJO2_MACHINE_WORD,
  type Kojo2Query,
} from '@kojo/kojo-lang';
import { KOJO2_DISPATCH_WORDS } from '../src/lexicon';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'kojo2', 'completion.kojo2'),
  'utf8',
);
/** 保证夹具末尾有一个换行：下面所有"追加一行"的查询都从新行开始。 */
const BASE = FIXTURE.endsWith('\n') ? FIXTURE : `${FIXTURE}\n`;

/** 把 `|` 当光标标记：摘掉标记，换成 1 基行列。 */
function queryAt(text: string, marker = '|'): Kojo2Query {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`夹具里没有光标标记 ${marker}`);
  const source = text.slice(0, at) + text.slice(at + marker.length);
  const before = source.slice(0, at);
  const lastBreak = before.lastIndexOf('\n');
  return { source, line: before.split('\n').length, column: at - lastBreak };
}

const labelsOf = (candidates: readonly Kojo2CompletionCandidate[]): string[] =>
  candidates.map((candidate) => candidate.label);

const kindsOf = (candidates: readonly Kojo2CompletionCandidate[]): Kojo2CompletionKind[] =>
  candidates.map((candidate) => candidate.kind);

/** 夹具里表 / 池 / 模 / 函的声明名（从 core AST 取，不手抄）。 */
const MEMBER_NAMES: readonly string[] = parseSource(FIXTURE).decls
  .filter(isMemberDecl)
  .map((decl) => decl.name);

type MemberDecl = Extract<
  KojoDecl,
  { kind: 'table' | 'pool' | 'template' | 'function' }
>;

function isMemberDecl(decl: KojoDecl): decl is MemberDecl {
  return (
    decl.kind === 'table' ||
    decl.kind === 'pool' ||
    decl.kind === 'template' ||
    decl.kind === 'function'
  );
}

type CallableDecl = Extract<KojoDecl, { kind: 'pool' | 'template' | 'function' }>;

function isCallableDecl(decl: KojoDecl): decl is CallableDecl {
  return decl.kind === 'pool' || decl.kind === 'template' || decl.kind === 'function';
}

/** 夹具里池 / 模 / 函的声明名（`!` 调用位可补的那三种）。 */
const CALLABLE_NAMES: readonly string[] = parseSource(FIXTURE).decls
  .filter(isCallableDecl)
  .map((decl) => decl.name);

describe('候选源：锚点 / 声明词 / 事件 / 域符号 / 成员名单', () => {
  it('空行行首给五锚点（每枚都是可插入的标点）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}|`));
    expect(kindsOf(candidates)).toEqual(candidates.map(() => 'anchor'));
    expect(labelsOf(candidates)).toEqual([...KOJO2_ANCHOR_CHARS]);
    for (const candidate of candidates) {
      expect(candidate.insertText).toBe(candidate.label);
      expect(candidate.detail).toBe('锚点');
    }
  });

  it('`#` 之后给完整声明词表（与 core `KOJO_DECL_WORDS` 逐项相等）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# |`));
    expect(kindsOf(candidates)).toEqual(candidates.map(() => 'declarationWord'));
    expect(labelsOf(candidates)).toEqual([...KOJO_DECL_WORDS]);
  });

  it('声明词按已输入前缀裁剪（`# 变|` → 只留“变量”）', () => {
    const prefix = KOJO_DECL_WORDS[3]!;
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# ${prefix.slice(0, 1)}|`));
    expect(labelsOf(candidates)).toEqual([prefix]);
    expect(candidates[0]?.kind).toBe('declarationWord');
  });

  it('`# 机` 之后给 adapter 事件目录（零手抄；与 ERATW_GAME_ADAPTER.eventCatalog 逐项相等）', () => {
    const expected = ERATW_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    expect([...kojo2EventNamesOf(ERATW_GAME_ADAPTER)]).toEqual(expected);
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 |`), {
      adapter: ERATW_GAME_ADAPTER,
    });
    expect(kindsOf(candidates)).toEqual(candidates.map(() => 'event'));
    expect(labelsOf(candidates)).toEqual(expected);
  });

  it('事件位按前缀裁剪（`# 机 指|` 只留以“指”开头的事件）', () => {
    const prefix = '指';
    const expected = eventNames(ERATW_GAME_ADAPTER).filter((event) => event.startsWith(prefix));
    expect(expected.length).toBeGreaterThan(0);
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 ${prefix}|`), {
      adapter: ERATW_GAME_ADAPTER,
    });
    expect(labelsOf(candidates)).toEqual([...expected]);
  });

  it('事件目录可注入（纯函数不绑死 eraTW）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 |`), {
      events: ['合成事件甲', '合成事件乙'],
    });
    expect(labelsOf(candidates)).toEqual(['合成事件甲', '合成事件乙']);
  });

  it('没有 adapter / events 注入时 `# 机` 零候选（不猜内置事件）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}# 机 |`))).toEqual([]);
  });

  it('`!` 调用位给池 / 模 / 函，不给表', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}! |`));
    expect(new Set(labelsOf(candidates))).toEqual(new Set(CALLABLE_NAMES));
    for (const candidate of candidates) {
      expect(candidate.kind).toBe('declaration');
      expect(['pool', 'template', 'function']).toContain(candidate.declarationKind);
    }
  });

  it('表达式位（条件行）给表 / 池 / 模 / 函全名单', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}? |`));
    expect(new Set(labelsOf(candidates))).toEqual(new Set(MEMBER_NAMES));
    for (const candidate of candidates) {
      expect(candidate.kind).toBe('declaration');
    }
  });

  it('`{…}` 插值内给域符号 + 成员名单（域符号排在前）', () => {
    const candidates = kojo2CompletionAt(queryAt(FIXTURE.replace('{我}', '{|我}')));
    expect(labelsOf(candidates).slice(0, KOJO_DOMAIN_SYMBOL_NAMES.length)).toEqual([
      ...KOJO_DOMAIN_SYMBOL_NAMES,
    ]);
    for (const name of MEMBER_NAMES) expect(labelsOf(candidates)).toContain(name);
  });

  it('插值内也按前缀裁剪（`{我|}` 只留域符号“我”）', () => {
    const pronoun = KOJO_DOMAIN_SYMBOL_NAMES[0]!;
    const candidates = kojo2CompletionAt(queryAt(FIXTURE.replace('{我}', `{${pronoun}|}`)));
    expect(labelsOf(candidates)).toEqual([pronoun]);
    expect(candidates[0]?.kind).toBe('domainSymbol');
  });
});

describe('位置门：台词正文 / `@原生` / 注释一律不补', () => {
  it('台词正文（不在插值里）零候选', () => {
    const source = FIXTURE.replace('今天来得', '今|天来得');
    expect(kojo2CompletionAt(queryAt(source))).toEqual([]);
  });

  it('`@原生` 围栏体内零候选（ERB 原文不解释）', () => {
    const source = FIXTURE.replace('CALL HPH_PRINT "w"', 'CALL HPH_PRINT |"w"');
    expect(kojo2CompletionAt(queryAt(source))).toEqual([]);
  });

  it('`@原生` 栏头本身零候选', () => {
    const source = FIXTURE.replace('@原生\n', '@原生|\n');
    expect(kojo2CompletionAt(queryAt(source))).toEqual([]);
  });

  it('整行注释零候选', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}// |`))).toEqual([]);
  });
});

/* ============================================================================ */
/* K2-COMPLETE-ARGS-FACE：事件参数 / `@织` / 存储期 / 模板形参与插槽 / 颜绘 / 提示名 */
/* ============================================================================ */

/** adapter 事件目录的**参数形状投影**（与宿主 wiring 同一条派生，不手抄一份）。 */
const EVENT_ARGS = projectEventArgs(ERATW_EVENT_CATALOG);

/** 颜绘参数模板（宿主注入的假事实；与 adapter / 工程数据无关，只钉"注入才有候选"）。 */
const FACE_TEMPLATES = {
  expressions: ['笑顔', '真顔'],
  costumes: ['服1', '服2'],
  differentials: ['裸', '差1'],
  effects: ['汗'],
};

/** 行尾表演提示名（宿主按 adapter `hintSupport` 投影的假事实）。 */
const HINT_NAMES = ['心形', '别过头'];

const SORTED_TYPES = [...KOJO_TYPE_WORDS];
const SORTED_STORAGE = [...KOJO_STORAGE_WORDS];

describe('`# 机 <事件>` 参数位：注入才有候选，未注入零候选', () => {
  it('事件后第一格给该事件的参数名（`指令` 的 `编号`）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 指令 |`), {
      eventArgs: EVENT_ARGS,
    });
    expect(labelsOf(candidates)).toEqual(['编号']);
    expect(candidates[0]?.kind).toBe('eventArgument');
    expect(candidates[0]?.detail).toContain('可选');
    expect(candidates[0]?.detail).toContain(KOJO_TYPE_WORDS[0]); // 整数
  });

  it('参数名按已输入前缀裁剪（`编|` ⇒ 只留 `编号`）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 指令 编|`), {
      eventArgs: EVENT_ARGS,
    });
    expect(labelsOf(candidates)).toEqual(['编号']);
  });

  it('前缀不是参数名开头 ⇒ 零候选（参数值是作者写的整数，不按值猜名称）', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}# 机 指令 3|`), { eventArgs: EVENT_ARGS }),
    ).toEqual([]);
  });

  it('该事件没有第二枚参数 ⇒ 第二格零候选', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}# 机 指令 310 |`), { eventArgs: EVENT_ARGS }),
    ).toEqual([]);
  });

  it('目录里该事件没有参数条目 ⇒ 零候选（`初见`）', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}# 机 初见 |`), { eventArgs: EVENT_ARGS }),
    ).toEqual([]);
  });

  it('未注入 `eventArgs`（哪怕注入了 adapter）⇒ 参数位零候选，不猜', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}# 机 指令 |`), { adapter: ERATW_GAME_ADAPTER }),
    ).toEqual([]);
  });

  it('目录里没有的事件名 ⇒ 参数位零候选', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}# 机 没这个事件 |`), { eventArgs: EVENT_ARGS }),
    ).toEqual([]);
  });

  it('注入 `eventArgs` 不改事件名位本身（事件位仍是 adapter 名单）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 |`), {
      adapter: ERATW_GAME_ADAPTER,
      eventArgs: EVENT_ARGS,
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual(candidates.map(() => 'event'));
    expect(labelsOf(candidates)).toEqual([...eventNames(ERATW_GAME_ADAPTER)]);
  });
});

describe('`@织 <事件>` 事件位：与 `# 机` 同一枚名单', () => {
  it('`@织 ` 之后给 adapter 事件目录（顺序逐项相等）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}@织 |`), {
      adapter: ERATW_GAME_ADAPTER,
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual(candidates.map(() => 'event'));
    expect(labelsOf(candidates)).toEqual([...eventNames(ERATW_GAME_ADAPTER)]);
  });

  it('事件位按前缀裁剪（`@织 回|`）', () => {
    const prefix = '回';
    const expected = eventNames(ERATW_GAME_ADAPTER).filter((event) => event.startsWith(prefix));
    expect(expected.length).toBeGreaterThan(0);
    expect(
      labelsOf(kojo2CompletionAt(queryAt(`${BASE}@织 ${prefix}|`), { adapter: ERATW_GAME_ADAPTER })),
    ).toEqual([...expected]);
  });

  it('未注入 adapter / events ⇒ 零候选（同 `# 机`，不猜内置事件）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}@织 |`))).toEqual([]);
  });

  it('事件名之后（实参 / 修饰词区）不再给事件名', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}@织 回合末 |`), { adapter: ERATW_GAME_ADAPTER }),
    ).toEqual([]);
  });
});

describe('`# 变量 / # 常量` 尾槽：类型词与存储期（core 词表派生）', () => {
  it('名字之后的类型位给 `整数 / 字符串`（与 core 词表逐项相等）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 |`));
    expect(labelsOf(candidates)).toEqual(SORTED_TYPES);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(candidates.map(() => 'valueType'));
  });

  it('类型按前缀裁剪（`字|` ⇒ `字符串`）', () => {
    expect(labelsOf(kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 字|`)))).toEqual([
      KOJO_TYPE_WORDS[1],
    ]);
  });

  it('类型之后的存储期位给 `场景 / 存档 / 会话`（顺序 = core 默认值优先级）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 整数 |`));
    expect(labelsOf(candidates)).toEqual(SORTED_STORAGE);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(
      candidates.map(() => 'storagePeriod'),
    );
  });

  it('存储期按前缀裁剪（`存|` ⇒ `存档`）', () => {
    expect(labelsOf(kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 整数 存|`)))).toEqual(['存档']);
  });

  it('初值之后的存储期位照给（`= 0 |`）', () => {
    expect(labelsOf(kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 整数 = 0 |`)))).toEqual(
      SORTED_STORAGE,
    );
  });

  it('初值位（`= |`）不给存储期（初值只允许字面量）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 整数 = |`))).toEqual([]);
  });

  it('名字位（还在写名字）不给候选', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}# 变量 状|`))).toEqual([]);
  });

  it('初值字符串里不给候选（字符串位置门先手）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}# 变量 状态 字符串 = "存|`))).toEqual([]);
  });

  it('`# 常量` 只有类型位（常量没有存储期）', () => {
    expect(labelsOf(kojo2CompletionAt(queryAt(`${BASE}# 常量 阈值 |`)))).toEqual(SORTED_TYPES);
    expect(kojo2CompletionAt(queryAt(`${BASE}# 常量 阈值 整数 |`))).toEqual([]);
    expect(kojo2CompletionAt(queryAt(`${BASE}# 常量 阈值 整数 = 5 |`))).toEqual([]);
  });
});

describe('`# 模`：声明头形参在体内可引用 + 调用处形参 / `[插槽]` 提示', () => {
  it('模板体内的 `{…}` 插值给本模板形参（追加在既有候选之后）', () => {
    const candidates = kojo2CompletionAt(queryAt(FIXTURE.replace('{原因}', '{|原因}')));
    const labels = labelsOf(candidates);
    expect(labels).toContain('原因');
    expect(candidates.find((candidate) => candidate.label === '原因')?.kind).toBe('templateParam');
    // 既有候选（域符号在前）顺序不动
    expect(labels.slice(0, KOJO_DOMAIN_SYMBOL_NAMES.length)).toEqual([
      ...KOJO_DOMAIN_SYMBOL_NAMES,
    ]);
  });

  it('模板体外不给该形参（不把模板体作用域漏到整份文件）', () => {
    const labels = labelsOf(kojo2CompletionAt(queryAt(`${BASE}? {原|}`)));
    expect(labels).not.toContain('原因');
  });

  it('调用位 `! 娇羞…` 的 detail 带声明头形参与 `[插槽]` 提示', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}! 娇羞|`));
    const template = candidates.find((candidate) => candidate.label === '娇羞退场');
    expect(template).toBeDefined();
    expect(template?.detail).toContain('参数：原因');
    expect(template?.detail).toContain('[插槽]');
  });

  it('调用位 `@函` 的 detail 带形参默认值（字面量原样）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}! 增加|`));
    const fn = candidates.find((candidate) => candidate.label === '增加羁绊');
    expect(fn?.detail).toContain('数值 = 10');
  });

  it('池没有插槽概念：调用位 detail 不出现 `[插槽]`', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}! 早安|`));
    const pool = candidates.find((candidate) => candidate.label === '早安问候');
    expect(pool?.detail).not.toContain('[插槽]');
    expect(pool?.detail).not.toContain('参数：');
  });

  it('模板体里还没有插槽时，体基准缩进的空行给 `[插槽]`（追加在五锚点之后）', () => {
    const source = `${BASE}# 模 还没插槽(甲)\n    |\n`;
    const candidates = kojo2CompletionAt(queryAt(source));
    expect(labelsOf(candidates).slice(0, KOJO2_ANCHOR_CHARS.length)).toEqual([
      ...KOJO2_ANCHOR_CHARS,
    ]);
    const slot = candidates.find((candidate) => candidate.label === '[插槽]');
    expect(slot?.kind).toBe('templateSlot');
  });

  it('模板已有 `[插槽]` ⇒ 空行不再给 `[插槽]`', () => {
    const source = FIXTURE.replace('    [插槽]\n', '    [插槽]\n    |\n');
    const labels = labelsOf(kojo2CompletionAt(queryAt(source)));
    expect(labels).not.toContain('[插槽]');
    expect(labels).toEqual([...KOJO2_ANCHOR_CHARS]);
  });

  it('模板体之外的空行不给 `[插槽]`（只有五锚点）', () => {
    const source = `${BASE}> 旁白\n    |\n`;
    expect(labelsOf(kojo2CompletionAt(queryAt(source)))).toEqual([...KOJO2_ANCHOR_CHARS]);
  });
});

describe('`@颜绘`：对象 + 表情 / 服装 / 差分 / 特效（注入才有参数候选）', () => {
  it('第一格 = 对象（core `我 / 你`）+ 表情（对象省略时表情也在第一格）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}@颜绘 |`), {
      faceTemplates: FACE_TEMPLATES,
    });
    expect(labelsOf(candidates)).toEqual([
      ...KOJO_FACE_OBJECT_WORDS,
      ...FACE_TEMPLATES.expressions,
    ]);
    expect(kindsOf(candidates).slice(0, KOJO_FACE_OBJECT_WORDS.length)).toEqual(
      KOJO_FACE_OBJECT_WORDS.map(() => 'faceObject'),
    );
    expect(kindsOf(candidates).slice(KOJO_FACE_OBJECT_WORDS.length)).toEqual(
      FACE_TEMPLATES.expressions.map(() => 'faceArgument'),
    );
  });

  it('对象之后第一格 = 表情', () => {
    expect(
      labelsOf(
        kojo2CompletionAt(queryAt(`${BASE}@颜绘 我 |`), { faceTemplates: FACE_TEMPLATES }),
      ),
    ).toEqual(FACE_TEMPLATES.expressions);
  });

  it('第二格 = 服装；第三格 = 差分；第四格 = 特效', () => {
    const at = (tail: string) =>
      labelsOf(
        kojo2CompletionAt(queryAt(`${BASE}@颜绘 ${tail}|`), { faceTemplates: FACE_TEMPLATES }),
      );
    expect(at('我 笑顔 ')).toEqual(FACE_TEMPLATES.costumes);
    expect(at('我 笑顔 服1 ')).toEqual(FACE_TEMPLATES.differentials);
    expect(at('我 笑顔 服1 裸 ')).toEqual(FACE_TEMPLATES.effects);
  });

  it('参数格按前缀裁剪（`我 笑|` ⇒ 表情里的 `笑顔`）', () => {
    expect(
      labelsOf(
        kojo2CompletionAt(queryAt(`${BASE}@颜绘 我 笑|`), { faceTemplates: FACE_TEMPLATES }),
      ),
    ).toEqual(['笑顔']);
  });

  it('对象省略时格位整体前移（`@颜绘 笑顔 |` ⇒ 服装）', () => {
    expect(
      labelsOf(
        kojo2CompletionAt(queryAt(`${BASE}@颜绘 笑顔 |`), { faceTemplates: FACE_TEMPLATES }),
      ),
    ).toEqual(FACE_TEMPLATES.costumes);
  });

  it('超过四格（`KOJO_FACE_MAX_ARGS`）零候选', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}@颜绘 我 笑顔 服1 裸 汗 |`), {
        faceTemplates: FACE_TEMPLATES,
      }),
    ).toEqual([]);
  });

  it('未注入 `faceTemplates` ⇒ 只有对象候选（表情 / 服装 / 差分零候选，不猜）', () => {
    expect(labelsOf(kojo2CompletionAt(queryAt(`${BASE}@颜绘 |`)))).toEqual([
      ...KOJO_FACE_OBJECT_WORDS,
    ]);
    expect(kojo2CompletionAt(queryAt(`${BASE}@颜绘 我 |`))).toEqual([]);
  });

  it('`@颜绘` 还没空格（还在写调度词）⇒ 零候选（与既有位置门一致）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}@颜绘|`), { faceTemplates: FACE_TEMPLATES })).toEqual(
      [],
    );
  });

  it('正在写对象词时也按前缀给对象（`我|` ⇒ `我`）', () => {
    expect(
      labelsOf(
        kojo2CompletionAt(queryAt(`${BASE}@颜绘 我|`), { faceTemplates: FACE_TEMPLATES }),
      ),
    ).toEqual([KOJO_FACE_OBJECT_WORDS[0]]);
  });
});

describe('`(心形)` 行尾提示名：注入才有候选', () => {
  it('台词行尾未闭合的 `(` 之后给注入的提示名', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}灵梦：「早安」(心|`), {
      hintNames: HINT_NAMES,
    });
    expect(labelsOf(candidates)).toEqual(['心形']);
    expect(candidates[0]?.kind).toBe('hintName');
  });

  it('提示名按前缀裁剪（`别|` ⇒ `别过头`）', () => {
    expect(
      labelsOf(kojo2CompletionAt(queryAt(`${BASE}灵梦：「早安」(别|`), { hintNames: HINT_NAMES })),
    ).toEqual(['别过头']);
  });

  it('旁白行尾同样给提示名', () => {
    expect(
      labelsOf(kojo2CompletionAt(queryAt(`${BASE}> 晨光(别|`), { hintNames: HINT_NAMES })),
    ).toEqual(['别过头']);
  });

  it('未注入 `hintNames` ⇒ 零候选（不猜任何提示名）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}灵梦：「早安」(心|`))).toEqual([]);
  });

  it('提示组已闭合（`(心形)|`）⇒ 零候选', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}灵梦：「早安」(心形)|`), { hintNames: HINT_NAMES }),
    ).toEqual([]);
  });

  it('台词引号内的 `(` 不是提示组（正文门先手）', () => {
    expect(
      kojo2CompletionAt(queryAt(`${BASE}灵梦：「(心|」`), { hintNames: HINT_NAMES }),
    ).toEqual([]);
  });

  it('注释里的 `(` 不给提示名', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}// (心|`), { hintNames: HINT_NAMES })).toEqual([]);
  });
});

/* ============================================================================ */
/* K2-COMPLETE-DATA：eraTW 契约字段（adapter 数据，同一份真源）                  */
/* ============================================================================ */

describe('K2-COMPLETE-DATA：eraTW 的补全数据就是 adapter 契约字段', () => {
  const faceTemplates = ERATW_GAME_ADAPTER.presentation.faceTemplates;
  const hintNames = ERATW_GAME_ADAPTER.presentation.hintNames;

  it('adapter 声明了表情格与提示名（补全数据有生产者）', () => {
    expect(faceTemplates?.expressions?.length).toBeGreaterThan(0);
    expect(hintNames?.length).toBeGreaterThan(0);
  });

  it('`@颜绘 我 |` 出 adapter 声明的表情（逐项相等，不手抄）', () => {
    expect(
      labelsOf(kojo2CompletionAt(queryAt(`${BASE}@颜绘 我 |`), { faceTemplates })),
    ).toEqual([...(faceTemplates?.expressions ?? [])]);
  });

  it('行尾未闭合的 `(` 之后出 adapter 声明的提示名', () => {
    expect(
      labelsOf(kojo2CompletionAt(queryAt(`${BASE}灵梦：「早安」( |`), { hintNames })),
    ).toEqual([...(hintNames ?? [])]);
  });

  it('未注入（旧 adapter / 无注入）⇒ 表情格与提示名格零候选，不猜', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}@颜绘 我 |`))).toEqual([]);
    expect(kojo2CompletionAt(queryAt(`${BASE}灵梦：「早安」( |`))).toEqual([]);
  });
});

/* ============================================================================ */
/* K2-COMPLETE-DATA-FL：eraFL 补全腿拿到 eraFL 自己的事实（入口 A/B 翻面判据）     */
/* ============================================================================ */

describe('K2-COMPLETE-DATA-FL：eraFL 的事件候选就是 ERAFL_GAME_ADAPTER 契约字段', () => {
  it('`# 机 ` 之后给 eraFL 事件目录（与 eventCatalog 逐项相等，零手抄）', () => {
    const expected = ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    // 真盘读数（D:/Game/erafl）：只有 4 个事件是引擎真事件，另 5 个 eraTW 有它没有
    expect(expected).toEqual(['初见', '读档', '商店', '购买']);
    expect([...kojo2EventNamesOf(ERAFL_GAME_ADAPTER)]).toEqual(expected);
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 |`), {
      adapter: ERAFL_GAME_ADAPTER,
    });
    expect(kindsOf(candidates)).toEqual(candidates.map(() => 'event'));
    expect(labelsOf(candidates)).toEqual(expected);
  });

  it('eraTW 独有事件不出现在 eraFL 候选里（入口 A 修的就是"串别家游戏事实"）', () => {
    const eraflEvents = ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    const eratwOnly = eventNames(ERATW_GAME_ADAPTER).filter((name) => !eraflEvents.includes(name));
    expect(eratwOnly).toEqual(['训练', '指令', '训练结束', '回合末', '指令结束']);
    const labels = labelsOf(
      kojo2CompletionAt(queryAt(`${BASE}# 机 |`), { adapter: ERAFL_GAME_ADAPTER }),
    );
    for (const name of eratwOnly) {
      expect(labels).not.toContain(name);
    }
  });

  it('eraFL 事件位按前缀裁剪（`# 机 初|` 只留"初见"）', () => {
    const candidates = kojo2CompletionAt(queryAt(`${BASE}# 机 初|`), {
      adapter: ERAFL_GAME_ADAPTER,
    });
    expect(labelsOf(candidates)).toEqual(['初见']);
  });
});

describe('新候选位的位置门：台词 / `@原生` / 注释 / 旧写法不误触', () => {
  it('`@原生` 体内的 `# 机 指令 编` 零候选（原文不解释）', () => {
    const source = FIXTURE.replace(
      'CALL HPH_PRINT "w"',
      'CALL HPH_PRINT "w" # 机 指令 编|',
    );
    expect(kojo2CompletionAt(queryAt(source), { eventArgs: EVENT_ARGS })).toEqual([]);
  });

  it('台词正文里的 `# 变量 名 ` 零候选', () => {
    const source = FIXTURE.replace('今天来得', '今天来得 # 变量 名 |');
    expect(kojo2CompletionAt(queryAt(source))).toEqual([]);
  });

  it('整行注释里的存储期位零候选', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}// # 变量 名 整数 |`))).toEqual([]);
  });

  it('旧写法行零候选（`# 时机` / `调用`）', () => {
    expect(kojo2CompletionAt(queryAt(`${BASE}# 时机 初见 3：|`))).toEqual([]);
    expect(kojo2CompletionAt(queryAt(`${BASE}调用 增加羁绊(目标)|`))).toEqual([]);
  });

  it('`@原生` 栏头后的 `@织 ` 不给事件（栏头本身零候选）', () => {
    const source = FIXTURE.replace('@原生\n', '@原生|\n');
    expect(kojo2CompletionAt(queryAt(source), { adapter: ERATW_GAME_ADAPTER })).toEqual([]);
  });
});

/* ============================== 块级 snippets（宿主翻译层数据） ============================== */

/** snippet 正文里的 tab stop 编号（`${n:…}` 的 n；`$0` 单独由收尾断言管）。 */
function placeholderNumbers(insertText: string): number[] {
  return [...insertText.matchAll(/\$\{(\d+):/g)].map((match) => Number(match[1]));
}

/** 去掉所有占位符之后的字面正文（用于查漏网的 `$` / `}`）。 */
function literalOf(insertText: string): string {
  return insertText.replace(/\$\{\d+:[^}]*\}/g, '').replace(/\$0/g, '');
}

describe('块级 snippets 数据完整性（纯数据，宿主按 kind:snippet 追加）', () => {
  it('五副骨架：id 唯一、kind 全是 snippet', () => {
    expect(kojo2CompletionSnippets).toHaveLength(5);
    expect(new Set(kojo2CompletionSnippets.map((snippet) => snippet.id)).size).toBe(5);
    for (const snippet of kojo2CompletionSnippets) expect(snippet.kind).toBe('snippet');
  });

  it('每副骨架都以 $0 收尾，且 tab stop 编号从 1 连续', () => {
    for (const snippet of kojo2CompletionSnippets) {
      expect(snippet.insertText.endsWith('$0')).toBe(true);
      const numbers = placeholderNumbers(snippet.insertText).sort((a, b) => a - b);
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    }
  });

  it('字面正文里没有漏网的 `$` / `}`（Monaco snippet 控制字符）', () => {
    for (const snippet of kojo2CompletionSnippets) {
      const literal = literalOf(snippet.insertText);
      expect(literal).not.toContain('$');
      expect(literal).not.toContain('}');
    }
  });

  it('触发形态逐条对得上（`?` 链 / `# 对照表` / `# 池` / `@巡` / `# 机`）', () => {
    const byId = (id: string) => {
      const found = kojo2CompletionSnippets.find((snippet) => snippet.id === id);
      if (found === undefined) throw new Error(`缺少 snippet ${id}`);
      return found;
    };
    expect(byId('chain-question').insertText.startsWith('? ')).toBe(true);
    expect(byId('table-two-columns').insertText.startsWith(`# ${KOJO2_DECL_WORD_BY_KIND.table} `)).toBe(
      true,
    );
    expect(byId('pool-branches').insertText.startsWith(`# ${KOJO2_DECL_WORD_BY_KIND.pool} `)).toBe(
      true,
    );
    expect(byId('foreach-tour').insertText.startsWith(`@${KOJO2_DISPATCH_WORDS[7]} `)).toBe(true);
    expect(byId('machine-header').insertText.startsWith(`# ${KOJO2_MACHINE_WORD} `)).toBe(true);
    // 位序派生必须落在**真的语言词**上（core 改表 ⇒ 这里红，不静默漂移）
    expect(byId('foreach-tour').label).toContain('@巡');
    expect(byId('machine-header').label).toContain('# 机');
  });

  it('结构词全部派生自 core（`依据` / `否` 不是手抄的第二份）', () => {
    const table = kojo2CompletionSnippets.find((snippet) => snippet.id === 'table-two-columns');
    expect(table?.insertText).toContain(KOJO_TABLE_SUBJECT);
    expect(table?.insertText).toContain(KOJO_TABLE_DEFAULT);
    for (const id of ['chain-question', 'pool-branches', 'foreach-tour']) {
      const snippet = kojo2CompletionSnippets.find((entry) => entry.id === id);
      expect(snippet?.insertText).toContain(KOJO_TABLE_DEFAULT);
    }
  });

  it('标签带触发形态（作者按已输入字符能过滤到骨架）', () => {
    for (const snippet of kojo2CompletionSnippets) {
      const trigger = snippet.insertText[0];
      expect(snippet.label.startsWith(trigger ?? '')).toBe(true);
    }
  });

  it('位置门：行首才给 snippets，行中零条', () => {
    expect(kojo2SnippetCandidatesAt(queryAt(`${BASE}|`))).toHaveLength(5);
    expect(kojo2SnippetCandidatesAt(queryAt(`${BASE}# |`))).toEqual([]);
    expect(kojo2SnippetCandidatesAt(queryAt(`${BASE}> 旁白 |`))).toEqual([]);
  });

  it('全角空格缩进也算行首（与位置层同一份空白口径）', () => {
    expect(kojo2SnippetCandidatesAt(queryAt(`${BASE}\u3000|`))).toHaveLength(5);
  });

  it('骨架正文里的缩进是四级（模板体 / 分支体按语言惯例）', () => {
    const table = kojo2CompletionSnippets.find((snippet) => snippet.id === 'table-two-columns');
    for (const line of (table?.insertText ?? '').split('\n').slice(1)) {
      expect(line.startsWith('    ')).toBe(true);
      expect(line.startsWith('        ')).toBe(false);
    }
  });

  it('纯函数候选永不产出 snippet 档（纪律：snippet 只在宿主翻译层追加）', () => {
    expect(Object.isFrozen(kojo2CompletionSnippets)).toBe(true);
    expect(kindsOf(kojo2CompletionAt(queryAt(`${BASE}|`)))).not.toContain('snippet');
    expect(kindsOf(kojo2CompletionAt(queryAt(`${BASE}# |`)))).not.toContain('snippet');
  });
});
