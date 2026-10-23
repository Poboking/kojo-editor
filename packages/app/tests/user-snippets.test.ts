import { beforeEach, describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  USER_SNIPPETS_KEY,
  UserSnippetError,
  addUserSnippet,
  createUserSnippetStore,
  loadUserSnippets,
  normalizeUserSnippet,
  removeUserSnippet,
  saveUserSnippets,
  snippetsForLanguage,
  updateUserSnippet,
  type UserSnippet,
  type UserSnippetKv,
} from '../src/ui/user-snippets';
import {
  createUserSnippetProvider,
  toMonacoSnippetText,
} from '../src/monaco/user-snippet-completion';

/**
 * S10 · 用户自定义代码片段：存储往返、坏 JSON 可见报错、语言过滤、片段转 Monaco snippet。
 *
 * KV 替身走 JSON 往返（真实后端就是 `{appData}/store/_global/user-snippets-v1.json`），
 * 别让引用共享假通过；坏 JSON 那一格必须经 `entry()` 报 corrupt——kernel 的 `get()`
 * 会把坏 JSON 投影成 `undefined`，只有显式三态能把"坏了"与"没写过"分开。
 */

/** 内存 KV：set 走 JSON 往返；raw 给用例断言落盘键与内容 */
function memoryKv(): UserSnippetKv & { raw(): string | undefined } {
  const m = new Map<string, string>();
  return {
    async get(key) {
      const s = m.get(key);
      return s === undefined ? undefined : JSON.parse(s);
    },
    async set(key, value) {
      m.set(key, JSON.stringify(value));
    },
    raw: () => m.get(USER_SNIPPETS_KEY),
  };
}

const RANGE: Monaco.IRange = { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 4 };

const snippet = (over: Partial<UserSnippet> = {}): UserSnippet => ({
  language: 'erb',
  prefix: 'IF块',
  name: '条件块',
  body: 'IF ${1:条件}\n$2\nENDIF$0',
  ...over,
});

/** 抛出的判别码（同步 CRUD 用例统一从这拿；没抛 = 用例判红） */
function problemOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof UserSnippetError ? err.problem : `非 UserSnippetError：${String(err)}`;
  }
  return '没有抛错';
}

const input = (over: Partial<Record<'language' | 'prefix' | 'name' | 'body' | 'description', string>> = {}) => ({
  language: 'erb',
  prefix: 'IF块',
  name: '条件块',
  body: 'IF ${1:条件}\nENDIF',
  ...over,
});

let kv: ReturnType<typeof memoryKv>;

beforeEach(() => {
  kv = memoryKv();
});

/* ============================== 存储往返 ============================== */

describe('存储往返', () => {
  it('save → load 等值（真实后端是 JSON 文件，序列化不可丢信息）', async () => {
    const list = [snippet(), snippet({ language: 'kojo2', prefix: '时机块', name: '时机块', body: '时机 ${1:分野}' })];
    await saveUserSnippets(kv, list);
    expect(await loadUserSnippets(kv)).toEqual({ snippets: list, error: null });
    expect(kv.raw()).toContain('"v":1');
    expect(kv.raw()).toContain('"language":"kojo2"');
  });

  it('首次运行（键不存在）⇒ 空表且无错', async () => {
    expect(await loadUserSnippets(kv)).toEqual({ snippets: [], error: null });
  });

  it('store 的增 / 改 / 删都落盘（下一次 load 读得到新状态）', async () => {
    const store = createUserSnippetStore(kv);
    await store.add(input());
    await store.add(input({ language: 'kojo2', prefix: '随机块', name: '随机' }));
    expect((await store.load()).snippets.map((s) => s.prefix)).toEqual(['IF块', '随机块']);

    await store.update({ language: 'erb', prefix: 'IF块' }, { prefix: 'IF', name: '条件' });
    expect((await store.load()).snippets.map((s) => s.prefix)).toEqual(['IF', '随机块']);

    await store.remove({ language: 'erb', prefix: 'IF' });
    expect((await store.load()).snippets.map((s) => s.prefix)).toEqual(['随机块']);
  });
});

/* ============================== 坏 JSON / 坏结构（可见报错） ============================== */

describe('坏 JSON 可见报错（不静默）', () => {
  it('kernel entry 报 corrupt ⇒ error 说明损坏，绝不假装首启空表', async () => {
    const corruptKv: UserSnippetKv = {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error('不该写坏文件');
      },
      async entry() {
        return { state: 'corrupt', detail: 'Unexpected token } in JSON at position 12' };
      },
    };
    const result = await loadUserSnippets(corruptKv);
    expect(result.snippets).toEqual([]);
    expect(result.error).toContain('损坏');
    expect(result.error).toContain('Unexpected token');
  });

  it('版本不认 / 结构不是对象 / snippets 不是数组 ⇒ 各有可见 error', async () => {
    await kv.set(USER_SNIPPETS_KEY, { v: 2, snippets: [] });
    expect((await loadUserSnippets(kv)).error).toContain('版本不受支持');

    await kv.set(USER_SNIPPETS_KEY, 'not a document');
    expect((await loadUserSnippets(kv)).error).toContain('结构不对');

    await kv.set(USER_SNIPPETS_KEY, { v: 1, snippets: 'nope' });
    expect((await loadUserSnippets(kv)).error).toContain('不是数组');
  });

  it('单条不合法 ⇒ 跳过并报数，好条目照留', async () => {
    await kv.set(USER_SNIPPETS_KEY, {
      v: 1,
      snippets: [snippet(), { language: 'erb', prefix: '带 空格', name: '坏', body: 'x' }, { prefix: '缺语言' }],
    });
    const result = await loadUserSnippets(kv);
    expect(result.snippets).toEqual([snippet()]);
    expect(result.error).toContain('跳过 2 条');
    expect(result.error).toContain('第 2 条');
  });

  it('坏文件时 store 的写操作 fail-closed（不许从空表覆盖坏数据）', async () => {
    const corruptKv: UserSnippetKv = {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error('不该覆盖');
      },
      async entry() {
        return { state: 'corrupt', detail: 'bad json' };
      },
    };
    const store = createUserSnippetStore(corruptKv);
    await expect(store.add(input())).rejects.toBeInstanceOf(UserSnippetError);
    await expect(store.add(input())).rejects.toMatchObject({ problem: 'corrupt-store' });
  });

  it('读不动（entry 抛错）⇒ 可见 error，不抛穿', async () => {
    const brokenKv: UserSnippetKv = {
      async get() {
        throw new Error('disk gone');
      },
      async set() {},
    };
    const result = await loadUserSnippets(brokenKv);
    expect(result.error).toContain('读取失败');
    expect(result.error).toContain('disk gone');
  });
});

/* ============================== CRUD 校验（重名 / 非法前缀） ============================== */

describe('CRUD 校验（可见报错）', () => {
  it('同语言重名（大小写不敏感）⇒ duplicate-prefix', () => {
    const list = [snippet({ prefix: 'FOO' })];
    expect(() => addUserSnippet(list, input({ prefix: 'foo' }))).toThrow(UserSnippetError);
    expect(problemOf(() => addUserSnippet(list, input({ prefix: 'foo' })))).toBe('duplicate-prefix');
    try {
      addUserSnippet(list, input({ prefix: 'foo' }));
    } catch (err) {
      expect((err as UserSnippetError).message).toContain('foo');
    }
  });

  it('跨语言同前缀允许（分组各自独立）', () => {
    const list = [snippet({ language: 'erb', prefix: '块' })];
    const next = addUserSnippet(list, input({ language: 'kojo2', prefix: '块' }));
    expect(next).toHaveLength(2);
  });

  it('非法前缀（空 / 带空格 / 标点开头）⇒ invalid-prefix，逐字报出原值', () => {
    for (const prefix of ['', '   ', '带 空格', '-开头的', 'a\tb']) {
      expect(problemOf(() => normalizeUserSnippet(input({ prefix })))).toBe('invalid-prefix');
      expect(() => normalizeUserSnippet(input({ prefix }))).toThrow(prefix === '' ? '不能' : prefix);
    }
  });

  it('空名字 / 空正文 ⇒ 各自的判别码', () => {
    expect(problemOf(() => normalizeUserSnippet(input({ name: ' ' })))).toBe('empty-name');
    expect(problemOf(() => normalizeUserSnippet(input({ body: ' \n ' })))).toBe('empty-body');
  });

  it('改 / 删不存在的片段 ⇒ not-found', () => {
    expect(problemOf(() => updateUserSnippet([], { language: 'erb', prefix: '无' }, { name: 'x' }))).toBe('not-found');
    expect(problemOf(() => removeUserSnippet([], { language: 'erb', prefix: '无' }))).toBe('not-found');
  });

  it('改成已有前缀 ⇒ duplicate-prefix，且原列表不变', () => {
    const list = [snippet({ prefix: 'A' }), snippet({ prefix: 'B' })];
    expect(problemOf(() => updateUserSnippet(list, { language: 'erb', prefix: 'B' }, { prefix: 'a' }))).toBe(
      'duplicate-prefix',
    );
    expect(list.map((s) => s.prefix)).toEqual(['A', 'B']);
  });

  it('save 前复验：重复前缀的整份列表写不进盘', async () => {
    await expect(saveUserSnippets(kv, [snippet(), snippet()])).rejects.toMatchObject({
      problem: 'duplicate-prefix',
    });
    expect(kv.raw()).toBeUndefined();
  });
});

/* ============================== 语言过滤 ============================== */

describe('语言过滤', () => {
  const list = [
    snippet({ language: 'erb', prefix: 'ERB块' }),
    snippet({ language: 'kojo2', prefix: '糖块' }),
  ];

  it('snippetsForLanguage 只出该语言；未知语言 = 空表', () => {
    expect(snippetsForLanguage(list, 'erb').map((s) => s.prefix)).toEqual(['ERB块']);
    expect(snippetsForLanguage(list, 'kojo2').map((s) => s.prefix)).toEqual(['糖块']);
    expect(snippetsForLanguage(list, 'json')).toEqual([]);
  });

  it('provider 只给声明的语言出候选（未声明的语言零候选）', () => {
    const { monaco } = stubMonaco();
    const provider = createUserSnippetProvider(['erb']);
    provider.setSnippets(list);
    expect(provider.buildItems(monaco, 'erb', RANGE)).toHaveLength(1);
    expect(provider.buildItems(monaco, 'kojo2', RANGE)).toEqual([]);
  });
});

/* ============================== 片段 → Monaco snippet ============================== */

describe('片段转 Monaco snippet', () => {
  it('`$1` / `${1:name}` 原样保留（占位符跳转交给 Monaco，不重新编号）', () => {
    const body = 'IF ${1:条件}\n  $2\nENDIF$0';
    expect(toMonacoSnippetText(body)).toBe(body);
  });

  it('CRLF / CR 归一成 LF（其余字符一个不动）', () => {
    expect(toMonacoSnippetText('a\r\nb\rc$1')).toBe('a\nb\nc$1');
  });

  it('候选：label = 前缀、detail = 名字、插入规则 InsertAsSnippet、range 原样', () => {
    const { monaco } = stubMonaco();
    const provider = createUserSnippetProvider(['erb']);
    provider.setSnippets([snippet()]);
    const [item] = provider.buildItems(monaco, 'erb', RANGE);
    expect(item?.label).toBe('IF块');
    expect(item?.detail).toBe('条件块');
    expect(item?.insertText).toBe('IF ${1:条件}\n$2\nENDIF$0');
    expect(item?.insertTextRules).toBe(4); // InsertAsSnippet
    expect(item?.kind).toBe(15); // CompletionItemKind.Snippet
    expect(item?.range).toEqual(RANGE);
    expect(item?.sortText).toContain('IF块');
  });
});

/* ============================== 接线 ============================== */

describe('install（供组长接线）', () => {
  it('每个声明语言注册一个 provider，并按当前词范围出货', () => {
    const { monaco, registered } = stubMonaco();
    const provider = createUserSnippetProvider(['erb', 'kojo2']);
    provider.setSnippets([snippet({ language: 'erb', prefix: 'IF块' }), snippet({ language: 'kojo2', prefix: '糖块' })]);
    const disposables = provider.install(monaco);
    expect(disposables).toHaveLength(2);
    expect(registered.map((r) => r.languageId)).toEqual(['erb', 'kojo2']);

    const erb = registered[0]!;
    const model = {
      getWordUntilPosition: () => ({ word: 'IF', startColumn: 3, endColumn: 5 }),
    } as unknown as Monaco.editor.ITextModel;
    const position = { lineNumber: 2, column: 5 } as unknown as Monaco.Position;
    const result = erb.provider.provideCompletionItems(
      model,
      position,
      {} as Monaco.languages.CompletionContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.CompletionList;
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.range).toEqual({
      startLineNumber: 2,
      endLineNumber: 2,
      startColumn: 3,
      endColumn: 5,
    });
  });
});

/* ============================== 桩 ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Snippet: 15 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}
