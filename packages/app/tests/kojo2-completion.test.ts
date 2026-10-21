/**
 * K2-EDITOR-SEMANTIC · `kojo2` 补全候选（纯函数）行为闸。
 *
 * 覆盖面：
 * - 五锚点 / 声明词 / `# 机` 事件 / 域符号 / 表·池·模·函名单；
 * - 位置门：台词正文不补、`@原生` 体内不补、注释不补；`{…}` 插值内例外；
 * - 名单零手抄：事件与 adapter `ERATW_EVENT_CATALOG` 逐项相等，声明词与 core
 *   `KOJO_DECL_WORDS` 同引用，域符号与 core `KOJO_DOMAIN_SYMBOL_NAMES` 同引用；
 * - 候选只按前缀裁剪，不做 Monaco 翻译（`insertText` 就是原文名）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KOJO_DECL_WORDS,
  KOJO_DOMAIN_SYMBOL_NAMES,
  eventNames,
  parseSource,
  type KojoDecl,
} from '@kojo/kojo-core';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import {
  KOJO2_ANCHOR_CHARS,
  kojo2CompletionAt,
  kojo2EventNamesOf,
  type Kojo2CompletionCandidate,
  type Kojo2CompletionKind,
} from '../src/monaco/kojo2-completion';
import type { Kojo2Query } from '../src/monaco/kojo2-declarations';

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
