/**
 * K2-INDENT-WIRE 的闸：**让结构层真正消费 `queries/v2/indents.scm`**。
 *
 * batch-8 之前：查询有真捕获、worker 会回三条腿、`kojo2IndentConfigWith` 能合并——但宿主
 * 从没把结果送进 `setLanguageConfiguration`。本批把那一步接上（挂点 = 语义着色 provider 的
 * 成功分支），本文件逐条钉住接线后的行为：
 *
 * 1. **注入形状**：只交 `onEnterRules` + `indentationRules` 两个属性（property 级合并），
 *    基底（`@原生` 栏头 / 行尾全角冒号）一条不撤，结构腿只加在后面；
 * 2. **只在变了才发**：key = `mergeIndentConfig` 的规则指纹；同一份规则第二次回复不重写
 *    语言配置，规则按**语言**累积（后开的文档只加不撤），旧的 disposable 换新时才撤；
 * 3. **失败零改动**：worker 不可用 / 超时 / 查询缺席 / 回复坏形 / 取客户端抛错 / 写配置抛错
 *    ⇒ 不写配置、**也不撤**已有配置，且不抛进 Monaco；
 * 4. **`@原生` 体内零规则**：真 wasm 上围栏体（含长成 `?` / `#` / `!` 形状的 ERB 行）不进
 *    规则，也不被结构腿命中；
 * 5. **flag / dispose**：flag 关零请求零配置；dispose 幂等且只撤自己写过的那一枚；
 * 6. **与 on-enter 判据同源**：整篇 2.0 夹具逐行对拍——"回车判据要更深" ⟺ "结构
 *    increase 规则命中" ⟺ "该行被 `indent.increase` 捕获"（同一锚点集，不另写词表）；
 * 7. **宿主挂点真接线**：`installKojo2SemanticTokensProvider` 在着色成功之后真的触发
 *    `indents` 请求并写配置；捕获失败时一个 `indents` 请求都不发。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import {
  KOJO2_INDENT_CONFIG_MAX_PATTERNS,
  createKojo2IndentConfigSync,
  installKojo2IndentConfigFromWorker,
  kojo2IndentConfigWith,
  type Kojo2IndentRulesSource,
} from '../src/monaco/kojo2-indent';
// B3i：回车判据已随判据整块进包叶子；本文件只在"结构规则与 on-enter 判据同源"那几组里
// 拿它当对照面（宿主不再有这一枚）。
import { kojo2IndentAfterLine } from '@kojo/kojo-lang/indent';
import {
  installKojo2SemanticTokensProvider,
  type Kojo2SemanticWorkerClient,
} from '../src/monaco/kojo2-semantic';
import { indentRulesFromCaptures } from '../src/monaco/tree-sitter/kojo2-worker';
import type { Kojo2Capture } from '../src/monaco/tree-sitter/kojo2-tokenizer';
import type {
  Kojo2CapturesReply,
  Kojo2IndentRules,
  Kojo2IndentsReply,
  Kojo2WorkerFailureReason,
  Kojo2WorkerResult,
} from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
  type Kojo2RuntimeDeps,
} from '../src/monaco/tree-sitter/kojo2-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/app/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_WASM = join(SYNTAX_ROOT, 'tree-sitter-kojo2.wasm');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');
const FIXTURE_TEXT = readFileSync(FULL_FIXTURE, 'utf8');

/** 生产资源的 Node 侧替身：直接读 workspace 内文件（不 fetch、不联网） */
function realRuntimeDeps(): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: GRAMMAR_WASM,
      highlightsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/highlights.scm'), 'utf8'),
      foldsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/folds.scm'), 'utf8'),
      indentsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/indents.scm'), 'utf8'),
    }),
  };
}

afterEach(async () => {
  await disposeKojo2TreeSitterRuntime();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ============================== 假 Monaco / 假 model ============================== */

interface ConfigWrite {
  readonly id: string;
  readonly config: Monaco.languages.LanguageConfiguration;
  disposed: boolean;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly writes: ConfigWrite[];
  readonly setLanguageConfiguration: ReturnType<typeof vi.fn>;
  /** 已撤的配置注册数（dispose 只该发生一次 / 每次换新配置一次） */
  readonly disposedCount: () => number;
}

/** 假 Monaco：只实现本层用到的两格（`IndentAction` + `setLanguageConfiguration`） */
function fakeMonaco(
  behavior: { readonly throwOnWrite?: (call: number) => boolean } = {},
): FakeMonaco {
  const writes: ConfigWrite[] = [];
  let disposedCount = 0;
  let attempts = 0;
  const setLanguageConfiguration = vi.fn(
    (id: string, config: Monaco.languages.LanguageConfiguration): Monaco.IDisposable => {
      attempts += 1;
      if (behavior.throwOnWrite?.(attempts) === true) {
        throw new Error('语言配置注册炸了');
      }
      const write: ConfigWrite = { id, config, disposed: false };
      writes.push(write);
      return {
        dispose() {
          if (write.disposed) return;
          write.disposed = true;
          disposedCount += 1;
        },
      };
    },
  );
  const monaco = {
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      setLanguageConfiguration,
    },
  };
  return {
    monaco: monaco as unknown as typeof Monaco,
    writes,
    setLanguageConfiguration,
    disposedCount: () => disposedCount,
  };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  setText(text: string, version?: number): void;
}

function fakeModel(
  initialText: string,
  initialVersion = 1,
  languageId = KOJO2_LANGUAGE_ID,
): FakeModel {
  let text = initialText;
  let version = initialVersion;
  let disposed = false;
  const model = {
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => disposed,
    getLanguageId: () => languageId,
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    getLineMaxColumn: (line: number) => (text.split(/\r\n|\r|\n/)[line - 1] ?? '').length + 1,
    uri: { fsPath: 'D:/proj/chara/灵梦/开场.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    setText(next, nextVersion) {
      text = next;
      version = nextVersion ?? version + 1;
    },
  };
}

/** 假 localStorage（`null` = 没存过 = flag 关；`'on'` = 开） */
function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set('kojo.ui.kojo2Cutover.v1', 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

/* ============================== 假 worker 客户端 ============================== */

interface IndentCall {
  readonly text: string;
  readonly version: number;
  readonly oldTreeId: string | undefined;
}

interface FakeIndentClient {
  readonly client: Kojo2IndentRulesSource;
  readonly calls: IndentCall[];
}

function fakeIndentClient(
  respond: (call: IndentCall) => Kojo2WorkerResult<Kojo2IndentsReply>,
): FakeIndentClient {
  const calls: IndentCall[] = [];
  return {
    calls,
    client: {
      async indents(text, version, oldTreeId) {
        const call = { text, version, oldTreeId };
        calls.push(call);
        return respond(call);
      },
    },
  };
}

/** 结构腿（与 worker 的 `indentRulesFromCaptures` 同形："行首锚 + 词形"） */
const TABLE_INCREASE = '^[ \\t\\u3000]*#[ \\t\\u3000]+对照表(?:[ \\t\\u3000]|$)';
const POOL_INCREASE = '^[ \\t\\u3000]*#[ \\t\\u3000]+池(?:[ \\t\\u3000]|$)';
const CALC_INCREASE = '^[ \\t\\u3000]*@算(?:[ \\t\\u3000]|$)';
const CONDITION_INCREASE = '^[ \\t\\u3000]*\\?';

const STRUCT_RULES: Kojo2IndentRules = {
  increasePatterns: [TABLE_INCREASE, CALC_INCREASE, CONDITION_INCREASE],
  enterPatterns: [TABLE_INCREASE, CALC_INCREASE, CONDITION_INCREASE],
  decreasePatterns: [],
};

function rulesReply(
  rules: Partial<Kojo2IndentRules>,
  version = 1,
): Kojo2WorkerResult<Kojo2IndentsReply> {
  return {
    ok: true,
    value: {
      ok: true,
      id: 1,
      type: 'indents',
      version,
      treeId: 'tree-1',
      rules: {
        increasePatterns: [],
        decreasePatterns: [],
        enterPatterns: [],
        ...rules,
      },
      incremental: false,
      reparsed: true,
      queryMs: 0,
      loadMs: 0,
    },
  };
}

function failure(
  reason: Kojo2WorkerFailureReason,
  message: string,
): Kojo2WorkerResult<Kojo2IndentsReply> {
  return { ok: false, reason, message };
}

/** 取最后一次写进语言配置的 `indentationRules`（测试断言用；无写入则抛） */
function lastIndentationRules(writes: readonly ConfigWrite[]): NonNullable<
  Monaco.languages.LanguageConfiguration['indentationRules']
> {
  const last = writes[writes.length - 1];
  if (last === undefined) throw new Error('没有写过语言配置');
  const rules = last.config.indentationRules;
  if (rules === undefined) throw new Error('语言配置里没有 indentationRules');
  return rules;
}

function lastOnEnterRules(
  writes: readonly ConfigWrite[],
): NonNullable<Monaco.languages.LanguageConfiguration['onEnterRules']> {
  const last = writes[writes.length - 1];
  if (last === undefined) throw new Error('没有写过语言配置');
  const rules = last.config.onEnterRules;
  if (rules === undefined) throw new Error('语言配置里没有 onEnterRules');
  return rules;
}

/* ============================== ① 注入形状 ============================== */

describe('① 注入形状：只交 onEnterRules + indentationRules（property 级合并）', () => {
  it('一次成功回复只写一次，语言 id = kojo2，且恰好两个属性', async () => {
    const fake = fakeMonaco();
    const { client } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 心情 依据 恋慕\n    0..1 -> 疏远\n');

    expect(await handle.request(model.model)).toBe(true);
    expect(fake.setLanguageConfiguration).toHaveBeenCalledTimes(1);
    expect(fake.writes).toHaveLength(1);
    const write = fake.writes[0]!;
    expect(write.id).toBe(KOJO2_LANGUAGE_ID);
    // 只交这两格：注释 / 括号 / autoClosingPairs / wordPattern 继续走语言注册那一份
    expect(Object.keys(write.config).sort()).toEqual(['indentationRules', 'onEnterRules']);
  });

  it('onEnterRules：基底两条（`@原生` 栏头 + 行尾全角冒号）+ 结构腿，全部是 Indent', async () => {
    const fake = fakeMonaco();
    const { client } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model);

    const rules = lastOnEnterRules(fake.writes);
    for (const rule of rules) expect(rule.beforeText).toBeInstanceOf(RegExp);
    for (const rule of rules) expect(rule.action.indentAction).toBe(1); // IndentAction.Indent
    expect(rules.some((rule) => rule.beforeText.test('@原生'))).toBe(true);
    expect(rules.some((rule) => rule.beforeText.test('选项：'))).toBe(true);
    // 结构腿（三条 increase = 三条 enter）都进了 onEnterRules
    expect(rules.some((rule) => rule.beforeText.test('# 对照表 别的 依据 心情'))).toBe(true);
    expect(rules.some((rule) => rule.beforeText.test('@算'))).toBe(true);
    expect(rules.some((rule) => rule.beforeText.test('? 任意条件'))).toBe(true);
    expect(rules).toHaveLength(2 + STRUCT_RULES.enterPatterns.length);
  });

  it('indentationRules：increase 基底 + 结构并联、decrease 永不自动回缩、不写基底没有的两格', async () => {
    const fake = fakeMonaco();
    const { client } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model);

    const rules = lastIndentationRules(fake.writes);
    // 基底两格一条不撤
    expect(rules.increaseIndentPattern.test('@原生')).toBe(true);
    expect(rules.increaseIndentPattern.test('选项：')).toBe(true);
    // 结构腿只加在后面
    expect(rules.increaseIndentPattern.test('# 对照表 别的 依据 心情')).toBe(true);
    expect(rules.increaseIndentPattern.test('@算')).toBe(true);
    expect(rules.increaseIndentPattern.test('? 任意条件')).toBe(true);
    // 不动手的行不被结构腿误伤（旁白 / 台词 / 裸调用）
    expect(rules.increaseIndentPattern.test('> 旁白')).toBe(false);
    expect(rules.increaseIndentPattern.test('灵梦：「台词」')).toBe(false);
    expect(rules.increaseIndentPattern.test('    CALL HPH_PRINT "w"')).toBe(false);
    // 2.0 没有收束记号：decrease 恒不命中
    expect(rules.decreaseIndentPattern.test('任何时候')).toBe(false);
    // 2.0 基底没有这两格 ⇒ 不许凭空写进"整对象替换"里
    expect('indentNextLinePattern' in rules).toBe(false);
    expect('unIndentedLinePattern' in rules).toBe(false);
  });

  it('与纯函数 kojo2IndentConfigWith 同源：写进配置的正则源码逐条相等', async () => {
    const fake = fakeMonaco();
    const { client } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model);

    const merged = kojo2IndentConfigWith(STRUCT_RULES);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    const rules = lastIndentationRules(fake.writes);
    expect(rules.increaseIndentPattern.source).toBe(merged.increaseIndentPattern.source);
    expect(rules.decreaseIndentPattern.source).toBe(merged.decreaseIndentPattern.source);
    const onEnter = lastOnEnterRules(fake.writes);
    expect(onEnter.map((rule) => rule.beforeText.source)).toEqual(
      merged.onEnterRules.map((rule) => rule.beforeText.source),
    );
  });

  it('换实参仍命中（规则只锚"首个词形"）：`# 对照表` / `# 池` / `@算` / `?` 四族', async () => {
    const fake = fakeMonaco();
    const { client } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    await handle.request(fakeModel('# 池 甲\n').model);
    const rules = lastIndentationRules(fake.writes);
    for (const line of ['# 对照表 别的名字 依据 其他表达式', '# 对照表 心情 依据 恋慕', '@算', '? 恋慕 >= 500', '? 否', '?否']) {
      expect(rules.increaseIndentPattern.test(line), `没有命中：${line}`).toBe(true);
    }
    for (const line of ['# 幕 开场', '# 设 数 整数', '@颜绘 笑顔', '! 早安问候', '> 旁白', '// 注释']) {
      expect(rules.increaseIndentPattern.test(line), `不该命中：${line}`).toBe(false);
    }
  });

  it('非法正则：丢掉那几条、其余照常写，且告警一次', async () => {
    const warn = vi.fn();
    const fake = fakeMonaco();
    const { client } = fakeIndentClient(() =>
      rulesReply({
        increasePatterns: [TABLE_INCREASE, '(['], // 第二条非法
        enterPatterns: [TABLE_INCREASE, '(['],
        decreasePatterns: [],
      }),
    );
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client, warn });
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(true);
    const rules = lastIndentationRules(fake.writes);
    // 坏正则被丢，好的那条照常进 increase
    expect(rules.increaseIndentPattern.test('# 对照表 甲 依据 乙')).toBe(true);
    expect(rules.increaseIndentPattern.test('@原生')).toBe(true); // 基底仍在
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('非法正则');
  });

  it('空规则回复 ⇒ 零配置；空文本 ⇒ 连请求都不发', async () => {
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply({}));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });

    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(false);
    expect(calls).toHaveLength(1); // 请求发了，但"三条腿全空"= 一个字都不写
    expect(fake.writes).toHaveLength(0);

    expect(await handle.request(fakeModel('   \n\n').model)).toBe(false);
    expect(calls).toHaveLength(1); // 空文本连请求都不发
    expect(fake.writes).toHaveLength(0);
  });
});

/* ============================== ② 只在变了才发 · 按语言累积 ============================== */

describe('② 同 key 只发一次：规则指纹不变不重写语言配置', () => {
  it('交回的 treeId 原样带给 indents 请求（同一棵树再查一次，不重解）', async () => {
    const fake = fakeMonaco();
    let rules = STRUCT_RULES;
    const { client, calls } = fakeIndentClient(() => rulesReply(rules));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model, 'tree-7')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.oldTreeId).toBe('tree-7');
    // 不交树号也照常跑（worker 自己解一棵）——这是省一次 parse 的增量，不是正确性前提
    rules = {
      increasePatterns: [POOL_INCREASE],
      enterPatterns: [POOL_INCREASE],
      decreasePatterns: [],
    };
    expect(await handle.request(fakeModel('# 池 甲\n').model)).toBe(true);
    expect(calls[1]!.oldTreeId).toBeUndefined();
  });

  it('同一 model 同一版本重复 request ⇒ 只发一次 worker 请求、只写一次配置', async () => {
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 甲 依据 乙\n');

    expect(await handle.request(model.model)).toBe(true);
    expect(await handle.request(model.model)).toBe(false);
    expect(await handle.request(model.model)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);
  });

  it('新版本但规则相同（甚至回复顺序反了）⇒ 重新请求、不重写配置', async () => {
    const fake = fakeMonaco();
    let order: 'forward' | 'backward' = 'forward';
    const { client, calls } = fakeIndentClient(() =>
      rulesReply(
        order === 'forward'
          ? STRUCT_RULES
          : {
              increasePatterns: [...STRUCT_RULES.increasePatterns].reverse(),
              enterPatterns: [...STRUCT_RULES.enterPatterns].reverse(),
              decreasePatterns: [],
            },
      ),
    );
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 甲 依据 乙\n');

    expect(await handle.request(model.model)).toBe(true);
    order = 'backward';
    model.setText('# 对照表 甲 依据 乙（改）\n', 2);
    expect(await handle.request(model.model)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(fake.writes).toHaveLength(1);
  });

  it('新词形 ⇒ 第二次写配置，且并集同时含旧规则与新规则（一条都不撤）', async () => {
    const fake = fakeMonaco();
    let rules: Kojo2IndentRules = {
      increasePatterns: [TABLE_INCREASE],
      enterPatterns: [TABLE_INCREASE],
      decreasePatterns: [],
    };
    const { client } = fakeIndentClient(() => rulesReply(rules));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 甲 依据 乙\n');

    expect(await handle.request(model.model)).toBe(true);
    rules = {
      increasePatterns: [POOL_INCREASE],
      enterPatterns: [POOL_INCREASE],
      decreasePatterns: [],
    };
    model.setText('# 池 早安问候\n', 2);
    expect(await handle.request(model.model)).toBe(true);

    expect(fake.writes).toHaveLength(2);
    const merged = lastIndentationRules(fake.writes);
    expect(merged.increaseIndentPattern.test('# 对照表 旧的 依据 词形')).toBe(true);
    expect(merged.increaseIndentPattern.test('# 池 新的词形')).toBe(true);
    const onEnter = lastOnEnterRules(fake.writes);
    expect(onEnter.some((rule) => rule.beforeText.test('# 对照表 旧'))).toBe(true);
    expect(onEnter.some((rule) => rule.beforeText.test('# 池 新'))).toBe(true);
  });

  it('回复的规则变少（子集）⇒ 不重写、旧配置不被撤（失败方向 = 少动手）', async () => {
    const fake = fakeMonaco();
    let rules: Kojo2IndentRules = STRUCT_RULES;
    const { client } = fakeIndentClient(() => rulesReply(rules));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 甲 依据 乙\n');

    expect(await handle.request(model.model)).toBe(true);
    rules = { increasePatterns: [TABLE_INCREASE], enterPatterns: [TABLE_INCREASE], decreasePatterns: [] };
    model.setText('# 对照表 甲 依据 乙（改）\n', 2);
    expect(await handle.request(model.model)).toBe(false);
    expect(fake.writes).toHaveLength(1);
    expect(fake.disposedCount()).toBe(0);
  });

  it('换新配置时才撤旧的：dispose 只发生在第二枚写成功之后', async () => {
    const fake = fakeMonaco();
    let rules: Kojo2IndentRules = {
      increasePatterns: [TABLE_INCREASE],
      enterPatterns: [TABLE_INCREASE],
      decreasePatterns: [],
    };
    const { client } = fakeIndentClient(() => rulesReply(rules));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 甲 依据 乙\n');

    await handle.request(model.model);
    expect(fake.disposedCount()).toBe(0);
    rules = {
      increasePatterns: [POOL_INCREASE],
      enterPatterns: [POOL_INCREASE],
      decreasePatterns: [],
    };
    model.setText('# 池 甲\n', 2);
    await handle.request(model.model);

    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[0]!.disposed).toBe(true);
    expect(fake.writes[1]!.disposed).toBe(false);
    expect(fake.disposedCount()).toBe(1);
  });

  it('不同 model 累积同一份语言配置：后开的文档不会弄丢前一篇的块头词形', async () => {
    const fake = fakeMonaco();
    let doc = 1;
    const shared = fakeIndentClient(() =>
      doc === 1
        ? rulesReply({ increasePatterns: [TABLE_INCREASE], enterPatterns: [TABLE_INCREASE], decreasePatterns: [] })
        : rulesReply({ increasePatterns: [POOL_INCREASE], enterPatterns: [POOL_INCREASE], decreasePatterns: [] }),
    );
    const config = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => shared.client });
    await config.request(fakeModel('# 对照表 甲 依据 乙\n').model);
    doc = 2;
    await config.request(fakeModel('# 池 早安问候\n').model);
    expect(fake.writes).toHaveLength(2);
    const merged = lastIndentationRules(fake.writes);
    expect(merged.increaseIndentPattern.test('# 对照表 甲 依据 乙')).toBe(true);
    expect(merged.increaseIndentPattern.test('# 池 早安问候')).toBe(true);
  });
});

/* ============================== ③ 失败零改动 ============================== */

describe('③ 失败零改动：不写配置、不撤已有配置、不抛', () => {
  it('worker 四类失败理由 ⇒ 零配置，每个 reason 只 warn 一次', async () => {
    const reasons: readonly Kojo2WorkerFailureReason[] = [
      'unavailable',
      'timeout',
      'query-unavailable',
      'parse-failed',
    ];
    for (const reason of reasons) {
      const warn = vi.fn();
      const fake = fakeMonaco();
      const { client } = fakeIndentClient(() => failure(reason, `假失败：${reason}`));
      const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client, warn });
      const model = fakeModel('# 对照表 甲 依据 乙\n');

      expect(await handle.request(model.model), reason).toBe(false);
      model.setText('# 对照表 甲 依据 乙（改）\n', 2);
      expect(await handle.request(model.model), reason).toBe(false);
      expect(fake.writes, reason).toHaveLength(0);
      expect(warn, reason).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(reason);
      handle.dispose();
    }
  });

  it('取 worker 客户端抛错 ⇒ 零配置、不抛、warn 一次', async () => {
    const warn = vi.fn();
    const fake = fakeMonaco();
    const handle = createKojo2IndentConfigSync(fake.monaco, {
      getClient: async () => {
        throw new Error('装载炸了');
      },
      warn,
    });
    await expect(handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).resolves.toBe(false);
    expect(fake.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('装载炸了');
  });

  it('客户端为 null / 没有 indents 方法 ⇒ 零请求零配置（不是发一条空规则）', async () => {
    const fake = fakeMonaco();
    const nullHandle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => null });
    expect(await nullHandle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(false);

    const capturesOnly = createKojo2IndentConfigSync(fake.monaco, {
      getClient: async () => ({}),
    });
    expect(await capturesOnly.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it('已有配置之后失败 ⇒ 旧配置继续生效（不撤、不重写）', async () => {
    const fake = fakeMonaco();
    let ok = true;
    const { client } = fakeIndentClient(() =>
      ok
        ? rulesReply(STRUCT_RULES)
        : failure('unavailable', 'worker 没了'),
    );
    const handle = createKojo2IndentConfigSync(fake.monaco, {
      getClient: async () => client,
      warn: () => undefined,
    });
    const model = fakeModel('# 对照表 甲 依据 乙\n');
    await handle.request(model.model);
    expect(fake.writes).toHaveLength(1);

    ok = false;
    model.setText('# 对照表 甲 依据 乙（改）\n', 2);
    expect(await handle.request(model.model)).toBe(false);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.disposed).toBe(false);
    expect(fake.disposedCount()).toBe(0);
  });

  it('setLanguageConfiguration 抛错 ⇒ false、不抛；下一次同规则会重试并写成功', async () => {
    const warn = vi.fn();
    const fake = fakeMonaco({ throwOnWrite: (call) => call === 1 });
    const { client } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client, warn });

    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(false);
    expect(fake.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('语言配置');

    // appliedKey 没更新 ⇒ 同样的规则换一篇文档还会再试一次（这次成功）
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(true);
    expect(fake.writes).toHaveLength(1);
  });

  it('回复形状不符（type 不是 indents / 空对象）⇒ 零配置零抛', async () => {
    const fake = fakeMonaco();
    const wrongType = fakeIndentClient(
      () =>
        ({
          ok: true,
          value: { ok: true, type: 'captures', rules: STRUCT_RULES },
        }) as unknown as Kojo2WorkerResult<Kojo2IndentsReply>,
    );
    const handle = createKojo2IndentConfigSync(fake.monaco, {
      getClient: async () => wrongType.client,
      warn: () => undefined,
    });
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(false);

    const junk = fakeIndentClient(
      () => ({}) as unknown as Kojo2WorkerResult<Kojo2IndentsReply>,
    );
    const handle2 = createKojo2IndentConfigSync(fake.monaco, {
      getClient: async () => junk.client,
      warn: () => undefined,
    });
    expect(await handle2.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it('model.getValue 抛错（模型已释放）⇒ false、零配置、不抛', async () => {
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const broken = {
      getValue: () => {
        throw new Error('model disposed');
      },
      getVersionId: () => 1,
      isDisposed: () => false,
      getLanguageId: () => KOJO2_LANGUAGE_ID,
    } as unknown as Monaco.editor.ITextModel;
    expect(await handle.request(broken)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
  });
});

/* ============================== 真 wasm：规则投影 ============================== */

interface RealIndentsData {
  readonly captures: readonly Kojo2Capture[];
  readonly rules: Kojo2IndentRules;
  /** `@原生` 围栏体的 0 基行区间（from = 栏头下一行） */
  readonly nativeRanges: readonly { readonly from: number; readonly to: number }[];
}

/** 真 wasm + 真 `queries/v2/indents.scm`：捕获 + worker 的规则投影（同一条装载链） */
async function realIndentsData(text: string): Promise<RealIndentsData> {
  const loaded = await getKojo2TreeSitterRuntime(realRuntimeDeps());
  if (!loaded.ok) throw new Error(`运行时装载失败：${loaded.reason} ${loaded.message}`);
  expect(loaded.runtime.queryStatus('indents').ok).toBe(true);
  const parsed = loaded.runtime.parse(text);
  if (!parsed.ok) throw new Error(`解析失败：${parsed.reason} ${parsed.message}`);
  const captured = loaded.runtime.queryCaptures(parsed.rootNode, 'indents');
  if (!captured.ok) throw new Error(`indents 查询失败：${captured.reason} ${captured.message}`);
  const nativeRanges: { from: number; to: number }[] = [];
  const walk = (node: SyntaxNode): void => {
    if (node.type === 'native_body') {
      // `native_body` 起点是栏头行末的零宽 `indent` 记号 ⇒ 体内从下一行起
      nativeRanges.push({ from: node.startPosition.row + 1, to: node.endPosition.row });
    }
    for (const child of node.children) walk(child);
  };
  walk(parsed.rootNode);
  parsed.tree.delete();
  return {
    captures: captured.captures,
    rules: indentRulesFromCaptures(captured.captures, text),
    nativeRanges,
  };
}

/** 只含 `@原生` 围栏（体内故意放长得像块头的 ERB 行） */
const NATIVE_ONLY_TEXT = [
  '@原生',
  '    ; 逃生舱：底层 ERB 代码',
  '    CALL HPH_PRINT "w"',
  '    ? 不是条件',
  '    ! 也不是触发',
  '    # 也不是表头',
  '    [插槽] 只是普通字符',
  '',
].join('\n');

describe('④ `@原生` 体内零规则（真 wasm + 真查询）', () => {
  it('围栏体的每一行都不被任何结构规则命中（含长成 `?` / `!` / `#` 形状的 ERB 行）', async () => {
    const { rules, nativeRanges } = await realIndentsData(NATIVE_ONLY_TEXT);
    expect(nativeRanges.length).toBeGreaterThan(0);
    const bodyLines = NATIVE_ONLY_TEXT.split(/\r\n|\r|\n/).slice(1).filter((line) => line.length > 0);
    const patterns = rules.increasePatterns.map((source) => new RegExp(source));
    expect(patterns.length).toBeGreaterThan(0); // 反空匹配自证：栏头自己有一条
    for (const line of bodyLines) {
      for (const pattern of patterns) {
        expect(pattern.test(line), `围栏体内被结构规则命中：${line}`).toBe(false);
      }
    }
  });

  it('围栏头本身仍 +1：base 与结构腿都对 `@原生` 命中，回车判据给 4 空格', async () => {
    const fake = fakeMonaco();
    const { rules } = await realIndentsData(NATIVE_ONLY_TEXT);
    const { client } = fakeIndentClient(() => rulesReply(rules));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    expect(await handle.request(fakeModel(NATIVE_ONLY_TEXT).model)).toBe(true);

    expect(kojo2IndentAfterLine(NATIVE_ONLY_TEXT, 1)).toBe('    ');
    const indentation = lastIndentationRules(fake.writes);
    expect(indentation.increaseIndentPattern.test('@原生')).toBe(true);
    const onEnter = lastOnEnterRules(fake.writes);
    expect(onEnter.some((rule) => rule.beforeText.test('@原生'))).toBe(true);
  });

  it('真夹具 full.kojo2：`@原生` 整块（122..129）零结构规则命中', async () => {
    const { rules, nativeRanges } = await realIndentsData(FIXTURE_TEXT);
    const lines = FIXTURE_TEXT.split(/\r\n|\r|\n/);
    const patterns = rules.increasePatterns.map((source) => new RegExp(source));
    expect(nativeRanges.length).toBeGreaterThan(0);
    let checked = 0;
    for (const range of nativeRanges) {
      for (let row = range.from; row <= range.to; row += 1) {
        const line = lines[row];
        if (line === undefined || line.length === 0) continue;
        checked += 1;
        for (const pattern of patterns) {
          expect(pattern.test(line), `第 ${row + 1} 行（围栏体内）被规则命中：${line}`).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(3); // 反空匹配自证
  });
});

/* ============================== ⑤ flag / dispose ============================== */

describe('⑤ flag / dispose / 健壮性', () => {
  it('flag 关 ⇒ 缩进照挂（语言面不读切流开关）：install 仍零请求，首次 request 才拉规则并写配置', async () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = installKojo2IndentConfigFromWorker(fake.monaco, { getClient: async () => client });
    expect(calls).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(true);
    handle.dispose();
  });

  it('flag 开 ⇒ 惰性：install 之后零请求，第一次 request 才拉规则并写配置', async () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = installKojo2IndentConfigFromWorker(fake.monaco, { getClient: async () => client });
    expect(calls).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);
  });

  it('dispose 幂等：只撤一次自己写过的配置，之后不再请求 / 不再写', async () => {
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    const model = fakeModel('# 对照表 甲 依据 乙\n');
    await handle.request(model.model);
    expect(fake.writes).toHaveLength(1);
    expect(fake.disposedCount()).toBe(0);

    handle.dispose();
    handle.dispose();
    handle.dispose();
    expect(fake.disposedCount()).toBe(1);
    expect(fake.writes[0]!.disposed).toBe(true);

    model.setText('# 池 甲\n', 2);
    expect(await handle.request(model.model)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);
  });

  it('只认 kojo2：别的语言 id 零请求零配置', async () => {
    const fake = fakeMonaco();
    const { client, calls } = fakeIndentClient(() => rulesReply(STRUCT_RULES));
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n', 1, 'erb').model)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
  });

  it('三条腿各自封顶：病态文档不许把语言配置撑爆', async () => {
    const fake = fakeMonaco();
    const many = Array.from({ length: KOJO2_INDENT_CONFIG_MAX_PATTERNS + 40 }, (_, index) =>
      `^[ \\t\\u3000]*@词${index}(?:[ \\t\\u3000]|$)`,
    );
    const { client } = fakeIndentClient(() =>
      rulesReply({ increasePatterns: many, enterPatterns: many, decreasePatterns: [] }),
    );
    const handle = createKojo2IndentConfigSync(fake.monaco, { getClient: async () => client });
    expect(await handle.request(fakeModel('# 对照表 甲 依据 乙\n').model)).toBe(true);
    // onEnterRules = 基底 2 + enter 腿封顶条数
    expect(lastOnEnterRules(fake.writes)).toHaveLength(2 + KOJO2_INDENT_CONFIG_MAX_PATTERNS);
  });
});

/* ============================== ⑥ 与 on-enter 判据一致 ============================== */

/** 规则源码 → 锚点字符（`\\?` 归一成 `?`） */
function anchorOfPattern(source: string): string {
  const stripped = source.replace(/^\^\[ \\t\\u3000\]\*/, '');
  return stripped.startsWith('\\') ? stripped.slice(1, 2) : stripped.slice(0, 1);
}

describe('⑥ 与 on-enter 判据同源（同一锚点集）', () => {
  it('真夹具逐行对拍：回车判据"要更深" ⟺ 结构 increase 命中 ⟺ 该行被 `indent.increase` 捕获', async () => {
    const { rules, captures } = await realIndentsData(FIXTURE_TEXT);
    const lines = FIXTURE_TEXT.split(/\r\n|\r|\n/);
    const structIncrease = rules.increasePatterns.map((source) => new RegExp(source));
    expect(structIncrease.length).toBeGreaterThan(5); // 反空匹配自证

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      const next = kojo2IndentAfterLine(FIXTURE_TEXT, index + 1);
      // 判据只会给"更深"或"同级"两种答案；这里只比"更深"这一档
      const deeper = next !== null && next.length > leading;
      const structural = structIncrease.some((pattern) => pattern.test(line));
      const capturedIncrease = captures.some(
        (capture) => capture.name === 'indent.increase' && capture.startPosition.row === index,
      );
      expect(deeper, `第 ${index + 1} 行「${line}」：回车判据与结构规则不一致`).toBe(structural);
      expect(structural, `第 ${index + 1} 行「${line}」：结构规则与 indents 捕获不一致`).toBe(
        capturedIncrease,
      );
    }
  });

  it('结构腿的锚点集 = `#` / `@` / `?`（与回车判据认的开体家族同一批）', async () => {
    const { rules } = await realIndentsData(FIXTURE_TEXT);
    const anchors = new Set(rules.increasePatterns.map(anchorOfPattern));
    expect(anchors).toEqual(new Set(['#', '@', '?']));
    // `!` 不在里面：裸调用行与触发块头同形（§7.2 判不准），与 on-enter 的"`!` 永不 +1"一致
    expect(anchors.has('!')).toBe(false);
    // `decrease` 恒空：2.0 没有收束记号，与 on-enter 的"Enter 上不许 Outdent"一致
    expect(rules.decreasePatterns).toEqual([]);
    expect(rules.enterPatterns).toEqual(rules.increasePatterns);
  });

  it('`? 任意条件` 与 `? 否` / `?否` 同一条规则（锚点只看行首字符）', async () => {
    const { rules } = await realIndentsData(FIXTURE_TEXT);
    const patterns = rules.increasePatterns.map((source) => new RegExp(source));
    const hits = (line: string): boolean => patterns.some((pattern) => pattern.test(line));
    for (const line of ['? 任意条件', '? 否', '?否', '    ? 缩进里的条件']) {
      expect(hits(line), `没有命中：${line}`).toBe(true);
    }
    // 与回车判据同口径：条件行一律再深一级（含缩进更深的那种）
    for (const [line, expected] of [
      ['? 任意条件', '    '],
      ['    ? 缩进里的条件', '        '],
    ] as const) {
      expect(kojo2IndentAfterLine(`${line}\n`, 1)).toBe(expected);
    }
  });
});

/* ============================== ⑦ 宿主挂点：kojo2-semantic ============================== */

interface SemanticWireFake {
  readonly monaco: typeof Monaco;
  readonly writes: ConfigWrite[];
  readonly disposedCount: () => number;
  readonly registrations: {
    readonly id: string;
    readonly provider: Monaco.languages.DocumentSemanticTokensProvider;
  }[];
}

function fakeSemanticMonaco(): SemanticWireFake {
  const config = fakeMonaco();
  const registrations: SemanticWireFake['registrations'] = [];
  const monaco = {
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      setLanguageConfiguration: config.setLanguageConfiguration,
      registerDocumentSemanticTokensProvider: (
        id: string,
        provider: Monaco.languages.DocumentSemanticTokensProvider,
      ): Monaco.IDisposable => {
        registrations.push({ id, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return {
    monaco: monaco as unknown as typeof Monaco,
    writes: config.writes,
    disposedCount: config.disposedCount,
    registrations,
  };
}

function capturesReply(version = 1): Kojo2WorkerResult<Kojo2CapturesReply> {
  return {
    ok: true,
    value: {
      ok: true,
      id: 1,
      type: 'captures',
      version,
      treeId: 'tree-1',
      captures: [],
      incremental: false,
      reparsed: true,
      queryMs: 0,
      loadMs: 0,
    },
  };
}

describe('⑦ 宿主挂点：语义着色成功之后才触发 indents', () => {
  it('flag 开：着色成功 ⇒ 一次 indents 请求 + 一次语言配置；dispose 撤掉那枚配置', async () => {
    stubFlag(true);
    const fake = fakeSemanticMonaco();
    const capturesCalls: string[] = [];
    const indentCalls: IndentCall[] = [];
    const client: Kojo2SemanticWorkerClient & Kojo2IndentRulesSource = {
      async captures(text) {
        capturesCalls.push(text);
        return capturesReply();
      },
      async indents(text, version, oldTreeId) {
        indentCalls.push({ text, version, oldTreeId });
        return rulesReply(STRUCT_RULES);
      },
    };
    const handle = installKojo2SemanticTokensProvider(fake.monaco, {
      getClient: async () => client,
      warn: () => undefined,
    });
    expect(fake.registrations).toHaveLength(1);
    const provider = fake.registrations[0]!.provider;

    const model = fakeModel('# 对照表 心情 依据 恋慕\n');
    await provider.provideDocumentSemanticTokens(model.model, null, {} as never);
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(capturesCalls).toHaveLength(1);
    expect(indentCalls).toHaveLength(1);
    expect(indentCalls[0]!.version).toBe(1);
    // 交回语义那一轮的 treeId：indents 查询直接查那棵树，不重解
    expect(indentCalls[0]!.oldTreeId).toBe('tree-1');
    expect(lastIndentationRules(fake.writes).increaseIndentPattern.test('# 对照表 别的 依据 心情')).toBe(
      true,
    );

    handle.dispose();
    handle.dispose();
    expect(fake.disposedCount()).toBe(1);
  });

  it('着色失败（worker 不可用）⇒ 一个 indents 请求都不发、零配置（失败方向 = 零改动）', async () => {
    stubFlag(true);
    const fake = fakeSemanticMonaco();
    const indentCalls: IndentCall[] = [];
    const client: Kojo2SemanticWorkerClient & Kojo2IndentRulesSource = {
      async captures() {
        return { ok: false, reason: 'unavailable', message: 'wasm 缺失' };
      },
      async indents(text, version, oldTreeId) {
        indentCalls.push({ text, version, oldTreeId });
        return rulesReply(STRUCT_RULES);
      },
    };
    const handle = installKojo2SemanticTokensProvider(fake.monaco, {
      getClient: async () => client,
      warn: () => undefined,
    });
    const provider = fake.registrations[0]!.provider;
    const model = fakeModel('# 对照表 心情 依据 恋慕\n');
    await provider.provideDocumentSemanticTokens(model.model, null, {} as never);
    // 给挂点留足微任务时间：确认它真的没被调
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(indentCalls).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    handle.dispose();
  });

  it('flag 关 ⇒ 语义照挂（语言面）：注册一枚 provider、零配置写入', () => {
    stubFlag(false);
    const fake = fakeSemanticMonaco();
    const handle = installKojo2SemanticTokensProvider(fake.monaco, {
      getClient: async () => ({ captures: async () => capturesReply() }),
      warn: () => undefined,
    });
    expect(fake.registrations.length).toBeGreaterThan(0);
    expect(fake.writes).toHaveLength(0);
    handle.dispose();
  });
});
