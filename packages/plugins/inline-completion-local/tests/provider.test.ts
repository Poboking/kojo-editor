import type { ErbIndex, ErbIndexState, InlineCompletionOutcome, InlineCompletionRequest } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { LOCAL_SOURCE_ID, LOCAL_SOURCE_ORDER, createLocalContribution, localInlineCompletion } from '../src/provider';
import type { LocalProviderDeps } from '../src/provider';
import { OPEN_PROJECT, emptyIndex, fakeIndex, requestAt } from './fixtures';

/**
 * 本地候选源的三态 + 弃权 + 自证闸（B 线 · IC 批）。
 *
 * 这一份测试是**验收的核心**：它钉的不是"函数返回值长什么样"，而是契约里那四条
 * 一旦破掉就只表现为"有时候有字、有时候没字"的纪律——
 * 1. 弃权 / `no-completion` / `failed` / `candidates` 四支各自在什么事实上出现；
 * 2. `'candidates'` 必须逐字回带 `request.version`（不等的批宿主会丢弃并出声）；
 * 3. **多匹配就不给**（"宁可漏报不可错报"的机器判据）；
 * 4. 时间预算用尽 / 被叫停 ⇒ 不抛错、不给没有依据的批。
 *
 * 判别联的收窄一律走 `candidatesOf` / `failedOf` 那两把"要么给出这一支、要么直接把
 * 实际值印进报错"的钥匙 —— 不写 `expect(o!.state).toBe(...)` + `if (...) return` 那种
 * 早退：早退会让"断言根本没跑到"看起来像绿。
 */

const INDEX = fakeIndex({
  functions: ['M_KOJO_MESSAGE_COM_K1_30', 'M_KOJO_SYSTEM_EAT', '增加羁绊', 'AEGI_H'],
  dims: [
    ['GOOD_NAME', 'DIM'],
    ['GOOD_OTHER', 'DIMS'],
    ['次数', 'DIM'],
  ],
});

function depsFor(index: ErbIndex | null, extra: Partial<LocalProviderDeps> = {}): LocalProviderDeps {
  return { currentIndex: () => index, ...extra };
}

const run = (request: InlineCompletionRequest, index: ErbIndex | null = INDEX, extra: Partial<LocalProviderDeps> = {}) =>
  localInlineCompletion(request, depsFor(index, extra));

const stateOf = (outcome: InlineCompletionOutcome | undefined): string =>
  outcome === undefined ? 'abstain' : outcome.state;

function candidatesOf(outcome: InlineCompletionOutcome | undefined) {
  if (outcome === undefined || outcome.state !== 'candidates') {
    throw new Error(`期望 candidates，实际 ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function failedOf(outcome: InlineCompletionOutcome | undefined) {
  if (outcome === undefined || outcome.state !== 'failed') {
    throw new Error(`期望 failed，实际 ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe('candidates：唯一命中才给', () => {
  it('形状①行首 @：前缀在函数名录里只匹配一个 ⇒ 给整名，并逐字回带 version', () => {
    const outcome = candidatesOf(run(requestAt('@M_KOJO_SYSTEM_E', '', { version: 41 })).outcome);
    // **自证**：回带的版本必须等于请求里的版本，不是"当前最大版本"之类的二次推导
    expect(outcome.version).toBe(41);
    expect(outcome.partial).toBeUndefined();
    expect(outcome.candidates).toHaveLength(1);
    const candidate = outcome.candidates[0]!;
    expect(candidate.insertText).toBe('M_KOJO_SYSTEM_EAT');
    expect(candidate.sourceId).toBe(LOCAL_SOURCE_ID);
    expect(candidate.kind).toBe('function');
    // 区间 = 整枚名字槽（1 基列、结束列不含）
    expect(candidate.range).toEqual({ startLine: 1, startColumn: 2, endLine: 1, endColumn: 17 });
    // `note` 在本包就生成好，宿主原文显示
    expect(candidate.note).toContain('只匹配到');
    expect(candidate.note).toContain('M_KOJO_SYSTEM_E');
  });

  it('形状②调用位：中文函数名同样命中（大小写不敏感靠归一化）', () => {
    const outcome = candidatesOf(run(requestAt('CALL 增加', '羁绊', { version: 3 })).outcome);
    expect(outcome.candidates[0]!.insertText).toBe('增加羁绊');
  });

  it('形状③声明位：查的是 #DIM 名录，不是函数名录', () => {
    // GOOD_NAME / GOOD_OTHER 两条都以 `GOOD_` 开头 ⇒ 声明位同样吃"多匹配就不给"的闸
    expect(stateOf(run(requestAt('#DIM GOOD_', 'NAME')).outcome)).toBe('no-completion');
    const unique = candidatesOf(run(requestAt('#DIM GOOD_OTHER', '', { version: 8 })).outcome);
    expect(unique.candidates[0]!.insertText).toBe('GOOD_OTHER');
    expect(unique.candidates[0]!.kind).toBe('variable');
    expect(unique.version).toBe(8);
  });

  it('已打字面**就是**那个唯一名字时照给（接受键 = 无变化的空动作，不是"没候选"）', () => {
    const outcome = candidatesOf(run(requestAt('@AEGI_H', '')).outcome);
    expect(outcome.candidates[0]!.insertText).toBe('AEGI_H');
  });

  it('只信 prefix/suffix，不信 lineText（宿主递的三段不是同一次采样时以两段为准）', () => {
    const request = requestAt('@M_KOJO_SYSTEM_E', '', { lineText: '这是一条被宿主拼歪了的整行' });
    expect(stateOf(run(request).outcome)).toBe('candidates');
  });
});

describe('精度闸：多匹配就不给（宁可漏报不可错报）', () => {
  it('前缀命中两条 ⇒ no-completion（而不是"挑一条看起来更像的"）', () => {
    const trace = run(requestAt('@M_KOJO_', '', { version: 9 }));
    expect(stateOf(trace.outcome)).toBe('no-completion');
    expect(trace.shape).toBe('definition');
    expect(trace.hits).toBe(2);
  });

  it('前缀一条都不命中 ⇒ 同样是 no-completion（看过、确认没有）', () => {
    const trace = run(requestAt('@NO_SUCH_NAME_AT_ALL', ''));
    expect(stateOf(trace.outcome)).toBe('no-completion');
    expect(trace.hits).toBe(0);
  });

  it('空索引 ⇒ 三条形状都不给候选，但**不失败**（名录在场、只是没命中）', () => {
    expect(stateOf(run(requestAt('@AEGI_H', ''), emptyIndex()).outcome)).toBe('no-completion');
  });

  it('名录里同名多定义不影响判据（按名字数，不按定义数）', () => {
    const multi = fakeIndex({
      functions: [],
      byNameExtras: new Map([
        [
          '同名函数',
          [
            { name: '同名函数', normalizedName: '同名函数', filePath: 'D:/a.erb', startLine: 1, endLine: 2 },
            { name: '同名函数', normalizedName: '同名函数', filePath: 'D:/b.erb', startLine: 1, endLine: 2 },
          ],
        ],
      ]),
    });
    const outcome = candidatesOf(run(requestAt('@同名', '', { version: 2 }), multi).outcome);
    expect(outcome.candidates[0]!.insertText).toBe('同名函数');
  });
});

describe('弃权（undefined = 不服务，不记账）', () => {
  it('语言不归我 ⇒ 立刻 undefined，且不碰名录（一次 currentIndex 都不许调）', () => {
    let touched = 0;
    const outcome = localInlineCompletion(requestAt('@AEGI_H', '', { languageId: 'typescript' }), {
      currentIndex: () => {
        touched++;
        return INDEX;
      },
    }).outcome;
    expect(outcome).toBeUndefined();
    expect(touched).toBe(0);
  });

  it('位置不是名字槽 ⇒ undefined（散文行 / 实参位 / 注释行）', () => {
    for (const text of ['她走了过来', 'PRINT "x"', 'IF ABL:1 > 3', ';@AEGI_H', 'A = 1']) {
      expect(stateOf(run(requestAt(text, '')).outcome), text).toBe('abstain');
    }
  });

  it('槽刚起头、一个字都没打 ⇒ undefined（空槽的"唯一"没有依据）', () => {
    expect(stateOf(run(requestAt('@', 'AEGI_H')).outcome)).toBe('abstain');
    expect(stateOf(run(requestAt('CALL ', '')).outcome)).toBe('abstain');
  });

  it('声明形状可被关掉（命中率对照用），关掉后该位置退回弃权', () => {
    const outcome = localInlineCompletion(requestAt('#DIM GOOD_OTHER', ''), depsFor(INDEX), {
      enableDeclarationShape: false,
    }).outcome;
    expect(outcome).toBeUndefined();
  });

  it('minTypedLength 抬高时，短前缀一律弃权（不给"M_"开头的一整片名字当候选）', () => {
    expect(localInlineCompletion(requestAt('@M', ''), depsFor(INDEX), { minTypedLength: 3 }).outcome).toBeUndefined();
  });
});

describe('failed：依赖缺席要说话，不许静默', () => {
  it('没开项目 ⇒ stage=context，note 三段齐全（哪段没成 / 为什么 / 可重试）', () => {
    const failed = failedOf(localInlineCompletion(requestAt('@AEGI_H', '', { project: null }), depsFor(null)).outcome);
    expect(failed.stage).toBe('context');
    expect(failed.reason).toBe('no-project');
    expect(failed.note).toContain('没有打开任何项目');
    expect(failed.note).toContain('重试');
  });

  it('项目开着但名录提供方不在场 ⇒ 另一句话（stage=fetch，说的是"提供方缺席"）', () => {
    const failed = failedOf(run(requestAt('@AEGI_H', ''), null, { serviceAvailable: () => false }).outcome);
    expect(failed.stage).toBe('fetch');
    expect(failed.reason).toBe('parser-absent');
    expect(failed.note).toContain('不在场');
  });

  it('名录还在建 ⇒ 把阶段与进度读数写进 note（读得出"为什么现在没有"）', () => {
    const state = { phase: 'scanning', filesScanned: 1234, functions: 0 } as unknown as ErbIndexState;
    const failed = failedOf(
      run(requestAt('@AEGI_H', ''), null, { serviceAvailable: () => true, indexState: () => state }).outcome,
    );
    expect(failed.reason).toBe('index-scanning');
    expect(failed.note).toContain('scanning');
    expect(failed.note).toContain('1234');
  });

  it('三态不许混：failed 的 note 里绝不出现"没有候选"那种确认口径', () => {
    const failed = failedOf(run(requestAt('@AEGI_H', ''), null).outcome);
    expect(failed.note).not.toContain('没有匹配的候选');
  });
});

describe('时间预算与取消：不抛错、不给没依据的批', () => {
  it('signal 已置位 ⇒ no-completion（被叫停的一次调用没有观众）', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await createLocalContribution(depsFor(INDEX)).provideInline(
      requestAt('@AEGI_H', '', { signal: controller.signal }),
    );
    expect(outcome).toEqual({ state: 'no-completion' });
  });

  it('timeoutMs 非正值 ⇒ no-completion（预算已由宿主裁掉）', () => {
    expect(run(requestAt('@AEGI_H', '', { timeoutMs: 0 })).outcome).toEqual({ state: 'no-completion' });
    expect(run(requestAt('@AEGI_H', '', { timeoutMs: Number.NaN })).outcome).toEqual({ state: 'no-completion' });
  });

  it('预算在"数完名录之后"才用尽 ⇒ 也不给批（唯一性判据不允许半成品）', () => {
    // 时钟刻意做成"第一次查 0（还在预算内）、第二次查 10（已过 5ms 预算）"，
    // 才能把**算完之后那一道复验**单独跑出来：只测前置闸的话，
    // "结果算出来了但没有观众"这一档就永远是空匹配。
    let first = true;
    const trace = localInlineCompletion(
      requestAt('@AEGI_H', '', { timeoutMs: 5 }),
      {
        currentIndex: () => INDEX,
        now: () => {
          const value = first ? 0 : 10;
          first = false;
          return value;
        },
      },
      {},
      0,
    );
    expect(stateOf(trace.outcome)).toBe('no-completion');
    expect(trace.shape).toBe('definition');
  });

  it('提供方的 currentIndex 抛错 ⇒ 不冒泡成 reject，走 failed（接线炸了也不许把错抛给宿主）', async () => {
    const deps: LocalProviderDeps = {
      currentIndex: () => {
        throw new Error('服务已经停用');
      },
    };
    const failed = failedOf(await createLocalContribution(deps).provideInline(requestAt('@AEGI_H', '')));
    expect(failed.reason).toBe('parser-absent');
    expect(failed.note).toContain('不在场');
  });

  it('provideInline 是异步的且从不因为"没有结果"而 reject', async () => {
    const contribution = createLocalContribution(depsFor(INDEX));
    await expect(contribution.provideInline(requestAt('@ZZZ_NOT_THERE', ''))).resolves.toEqual({
      state: 'no-completion',
    });
    await expect(
      contribution.provideInline(requestAt('PRINT X', '', { languageId: 'plaintext' })),
    ).resolves.toBeUndefined();
  });
});

describe('贡献的形状面（契约自证的另一半）', () => {
  it('id / order / title 齐备且稳定（order 是"本地先、模型后"的那一枚）', () => {
    const contribution = createLocalContribution(depsFor(INDEX));
    expect(contribution.id).toBe('local-name-slot');
    expect(contribution.order).toBe(LOCAL_SOURCE_ORDER);
    expect(LOCAL_SOURCE_ORDER).toBeLessThan(20);
    expect(contribution.title.length).toBeGreaterThan(0);
    expect(contribution.title).toBe('本地名录候选（唯一命中才给）');
  });

  it('给出的候选**只有一条**，且第 0 条就是接受键拿到的那条（本包不做多候选池）', () => {
    const outcome = candidatesOf(run(requestAt('@M_KOJO_SYSTEM_E', '', { version: 1 })).outcome);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]!.displayText).toBeUndefined();
  });

  it('project 只在"缺席"时参与判据（开着的工程不需要读它任何一个字段）', () => {
    expect(OPEN_PROJECT).not.toBeNull();
    expect(stateOf(run(requestAt('@AEGI_H', '')).outcome)).toBe('candidates');
  });
});
