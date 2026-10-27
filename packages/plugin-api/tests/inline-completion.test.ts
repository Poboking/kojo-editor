/**
 * 内联补全（幽灵文本）候选源契约（`plugin-api/inline-completion.ts`）的钉（IC 批）。
 *
 * 四件事各用各的手段，别混着钉（分工口径同 `launcher-contract.test.ts` /
 * `language-service-kinds.test.ts`）：
 *
 * 1. **形状**用 `expectTypeOf`（编译期断言，`tsc --noEmit` 与 vitest 都能证伪）；
 * 2. **"不许存在的东西"**用源码文本反证——类型系统只能证明"我写的这行能编过"，
 *    证明不了"这两行没有一起存在"；
 * 3. **判别联穷尽**用一段真 switch：多一个 state 就编译不过，报错位置正好指到那份契约；
 * 4. **零值导出**用源码文本扫：这条纪律管的是**开机图**，测试跑不出来，只能扫源码。
 *
 * 为什么要给一个"只是形状"的契约写四把闸：最容易在实施中被顺手改掉的就是这三条——
 * 有人会把候选源塞进 `ui.editor.languageService`（同一能力两条路径）、
 * 有人会在契约里放一个"共享常量"（于是宿主与供方各读一份数字）、
 * 有人会给 `no-completion` 补一个 `candidates: []`（两种"没有"并存）。
 * 每一处改错的代价都是隐性的：表现是"有时候有字、有时候没字"，没人会想到去查契约。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { WellKnownServices } from '../src/services';
import type { RevealRange } from '../src/events';
import type { EditorCompletionItemKind } from '../src/slots';
import type {
  InlineCompletionCandidate,
  InlineCompletionOutcome,
  InlineCompletionRange,
  InlineCompletionRequest,
  InlineCompletionSourceContribution,
  InlineCompletionStage,
} from '../src/inline-completion';

const SRC = readFileSync(
  fileURLToPath(new URL('../src/inline-completion.ts', import.meta.url)),
  'utf8',
);
const SLOTS_SRC = readFileSync(fileURLToPath(new URL('../src/slots.ts', import.meta.url)), 'utf8');

/**
 * 剥掉注释之后的契约正文（**值导出与掏空两类判据只看正文**）。
 *
 * 为什么要剥：本契约的头注释里就写着"不许出现 `export const` / `export function` /
 * `export class`"——不剥注释，这条闸会把**说明纪律的那句话**当成违纪本身（实测首跑就红在
 * 这三枚字符串上）。反过来说，剥注释也**不会放过真的违纪**：注释以外的行才是导出声明，
 * 一行 `export const` 是剥不掉的。
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取某个 `export type Xxx =` 起、到下一个 `;` 止的文本 */
function unionBody(src: string, name: string): string {
  const head = `export type ${name} =`;
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`契约里找不到 ${name}`);
  const end = src.indexOf(';', start);
  if (end < 0) throw new Error(`${name} 的联合没有结尾分号`);
  return src.slice(start + head.length, end);
}

/** 联合里出现的成员名（按源码顺序） */
function membersOf(name: string): string[] {
  return [...unionBody(SLOTS_SRC, name).matchAll(/\|\s*(Editor\w+)/g)].map((m) => m[1] as string);
}

describe('内联补全契约的入口形状', () => {
  it('候选源的入口是槽 `completion.source`，且挂进了 SlotMap', () => {
    // 槽名 + 贡献类型都在 SlotMap 里出现才算"入口在册"（只写 interface 不挂表 = 没人问得到）
    expect(SLOTS_SRC).toContain("'completion.source': InlineCompletionSourceContribution;");
  });

  it('服务键面**没有**第二条候选源入口（`completion.*` / `*inline*` 一个都不许有）', () => {
    // 服务键是 1:1 的（`kernel/src/container.ts`：同键二次 provide 抛 ServiceConflictError），
    // 塞一家进来 = 第二家永远注册不上；槽才是多贡献者那条路。两条入口并存迟早漂。
    const keys = Object.values(WellKnownServices) as string[];
    expect(keys.filter((k) => k.startsWith('completion'))).toEqual([]);
    expect(keys.filter((k) => /inline/i.test(k))).toEqual([]);
    // 反空匹配自证：这张表确实在扫（今天 12 枚键），别把"没扫到"当成"没有第二条入口"
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  it('`ui.editor.languageService` 的判别成员里**没有**内联补全（同一能力不许两条路径）', () => {
    const requests = membersOf('EditorLanguageServiceRequest');
    const results = membersOf('EditorLanguageServiceResult');
    expect(requests.filter((n) => /inline/i.test(n))).toEqual([]);
    expect(results.filter((n) => /inline/i.test(n))).toEqual([]);
    // 反空匹配自证 + 请求/响应仍逐项对齐（判据取自源码文本，口径同 language-service-kinds）
    const stem = (name: string): string => name.replace(/(Request|Result)$/, '');
    expect(requests.length).toBeGreaterThanOrEqual(8);
    expect(requests.map(stem)).toEqual(results.map(stem));
  });
});

describe('内联补全契约的零值导出纪律（开机图）', () => {
  const valueExports = [
    /export\s+const\b/g,
    /export\s+(async\s+)?function\b/g,
    /export\s+class\b/g,
    /export\s+enum\b/g,
    /export\s+let\b/g,
    /export\s+var\b/g,
    /export\s+default\b/g,
  ];

  it('契约里没有任何值导出（桶只许 `export type`，否则整模块进开机图）', () => {
    const hits = valueExports.flatMap((re) => CODE.match(re) ?? []);
    expect(hits).toEqual([]);
  });

  it('这条闸扫的是一份**有内容**的契约（防止文件被掏空后"零命中"变绿灯）', () => {
    const exported = [...CODE.matchAll(/^export\s+(?:interface|type)\s+(\w+)/gm)].map((m) => m[1] as string);
    // 逐枚点名：契约的形状面就是这九个名字，少一个说明被顺手删了
    for (const name of [
      'InlineCompletionRange',
      'InlineCompletionTriggerKind',
      'InlineCompletionRequest',
      'InlineCompletionItemKind',
      'InlineCompletionCandidate',
      'InlineCompletionStage',
      'InlineCompletionFailure',
      'InlineCompletionOutcome',
      'InlineCompletionSourceContribution',
    ]) {
      expect(exported, `契约缺类型 ${name}`).toContain(name);
    }
    expect(exported.length).toBeGreaterThanOrEqual(9);
  });

  it('契约里不埋共享常量（候选上限 / 超时 / 窗宽都归宿主，只有一个截断点）', () => {
    // 判据是"正文里一个数字都不许出现"，不是"常量名里不许有 MAX"——后者有洞：
    // 变异实测 `export const INLINE_MAX_CANDIDATES = 8` 时名字闸**没红**（`\bMAX` 在
    // `INLINE_MAX_…` 里前面是 `_`（词字符），根本没有词边界），只有值导出那条拦住了它。
    // 数字本身才是这件事的判据：一份纯类型的契约里出现数字，只能是有人把策略写进了协议。
    const digits = [...CODE.matchAll(/[0-9]/g)].map((m) => m[0]);
    expect(digits).toEqual([]);
    // 反空匹配自证：剥注释后正文确实非空（否则"零数字"是掏空文件白送的绿灯）
    expect(CODE.trim().length).toBeGreaterThan(500);
  });
});

describe('内联补全请求的字段纪律', () => {
  it('坐标与 `RevealRange` 逐字同构（一整套模型坐标，不给第二套词汇）', () => {
    expectTypeOf<InlineCompletionRange>().toEqualTypeOf<RevealRange>();
  });

  it('候选类别直接复用弹窗那张表（两张词表必漂出"弹窗认、幽灵文本不认"）', () => {
    expectTypeOf<InlineCompletionCandidate['kind']>().toEqualTypeOf<
      EditorCompletionItemKind | undefined
    >();
  });

  it('请求**不带整篇全文**（幽灵文本触发频率高一到两个数量级，逐键复制整篇是性能陷阱）', () => {
    expectTypeOf<'text' extends keyof InlineCompletionRequest ? Has : Missing>().toEqualTypeOf<never>();
    // 反过来证：窗口字段确实在（不是把 `text` 改名糊过去）
    expectTypeOf<
      'contextBefore' extends keyof InlineCompletionRequest ? Has : Missing
    >().toEqualTypeOf<'has'>();
    expectTypeOf<
      'contextAfter' extends keyof InlineCompletionRequest ? Has : Missing
    >().toEqualTypeOf<'has'>();
  });

  it('`version` / `languageId` / `timeoutMs` 是**必填**（可选 = 供方可拿不到版本，过期判据就断了）', () => {
    expectTypeOf<InlineCompletionRequest['version']>().toEqualTypeOf<number>();
    expectTypeOf<InlineCompletionRequest['languageId']>().toEqualTypeOf<string>();
    expectTypeOf<InlineCompletionRequest['timeoutMs']>().toEqualTypeOf<number>();
    // 取消位是 additive：可选，缺省 = 旧行为逐字不变（口径同 ConventionRunOptions.signal）
    expectTypeOf<Required<InlineCompletionRequest>['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<InlineCompletionRequest['signal']>().toEqualTypeOf<AbortSignal | undefined>();
  });

  it('宿主不切词：递进来的都是原始字面，契约里没有词边界概念', () => {
    const rawLiterals = ['lineText', 'prefix', 'suffix', 'contextBefore', 'contextAfter'] as const;
    for (const key of rawLiterals) {
      expectTypeOf<InlineCompletionRequest[typeof key]>().toEqualTypeOf<string>();
    }
    // 词边界属于供方的语言知识，一旦进契约，宿主就得替所有语言做一次判定
    expect(SRC).not.toMatch(/currentWord|wordBoundary|wordPrefix|tokenText/);
  });
});

describe('内联补全结果的三态 + 弃权', () => {
  it('`no-completion` 分支是**光**的：没有 candidates 字段可填，"没有"只有一种写法', () => {
    type NoCompletion = Extract<InlineCompletionOutcome, { state: 'no-completion' }>;
    expectTypeOf<NoCompletion>().toEqualTypeOf<{ readonly state: 'no-completion' }>();
  });

  it('`candidates` 分支必须回带 `version`（自证按哪一版文本算的；不等即宿主丢弃并出声）', () => {
    type Ready = Extract<InlineCompletionOutcome, { state: 'candidates' }>;
    expectTypeOf<Ready['version']>().toEqualTypeOf<number>();
    expectTypeOf<Ready['candidates']>().toEqualTypeOf<readonly InlineCompletionCandidate[]>();
  });

  it('`failed` 分支三段一次给全：哪一段 + 为什么 + 人话 `note`（宿主只显示 note）', () => {
    type Failed = Extract<InlineCompletionOutcome, { state: 'failed' }>;
    expectTypeOf<Failed['stage']>().toEqualTypeOf<InlineCompletionStage>();
    expectTypeOf<Failed['reason']>().toEqualTypeOf<string>();
    expectTypeOf<Failed['note']>().toEqualTypeOf<string>();
    // note 不是可选：可选就会长出"各家自己决定要不要给作者一句话"
    expectTypeOf<'note' extends keyof Failed ? Has : Missing>().toEqualTypeOf<'has'>();
    // `partial` 只属于 candidates 分支：失败态不许声称"我这次没跑完"（那是弃权的事）
    expectTypeOf<'partial' extends keyof Failed ? Has : Missing>().toEqualTypeOf<never>();
    expectTypeOf<
      'partial' extends keyof Extract<InlineCompletionOutcome, { state: 'candidates' }> ? Has : Missing
    >().toEqualTypeOf<'has'>();
  });

  it('判别联穷尽（新增一个 state 而不改这段 switch ⇒ 编译期就红）', () => {
    const describeOutcome = (o: InlineCompletionOutcome): string => {
      switch (o.state) {
        case 'candidates':
          return `c${o.candidates.length}`;
        case 'no-completion':
          return 'none';
        case 'failed':
          return `${o.stage}:${o.note}`;
        default: {
          // 这一行的存在就是判据：走到这里说明联合多出了一支
          const exhausted: never = o;
          return String(exhausted);
        }
      }
    };
    expect(
      describeOutcome({
        state: 'candidates',
        version: 7,
        candidates: [
          {
            sourceId: 'fixture',
            range: { startLine: 3, startColumn: 9, endLine: 3, endColumn: 9 },
            insertText: 'fixture-insert',
          },
        ],
      }),
    ).toBe('c1');
    expect(describeOutcome({ state: 'no-completion' })).toBe('none');
    expect(
      describeOutcome({ state: 'failed', stage: 'transport', reason: 'r', note: '没成功，可重试' }),
    ).toBe('transport:没成功，可重试');
  });

  it('弃权是 `undefined`（不是第四个 state）：不服务 = 不记账', () => {
    expectTypeOf<InlineCompletionSourceContribution['provideInline']>().toEqualTypeOf<
      (request: InlineCompletionRequest) => Promise<InlineCompletionOutcome | undefined>
    >();
  });
});

/* ---- 类型层的"字段在 / 不在"记号（配合 expectTypeOf 钉"某字段不存在"） ----
 * 为什么不直接写 `not.toHaveProperty`：`expectTypeOf` 的属性断言对**可选**字段与
 * 不存在的字段给不出区分，而这里要的正是"这个 key 根本不在联合的这一支里"。
 * 记号取两个字面量（`'has'` / `never`），条件类型假侧直接落 `never`，红的时候
 * 报错会指着那条断言而不是指着编译器。
 */
type Has = 'has';
type Missing = never;
