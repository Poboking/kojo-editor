/**
 * LANG-OVERRIDE-MODEL · 语言模式覆盖进入 model 池的判据闸。
 *
 * 钉五件事（与批次十 S1 的状态栏那格衔接）：
 * 1. 有覆盖 ⇒ **建 model 时**就挂覆盖语言（不再靠状态栏 effect 的事后补课）；
 * 2. 无覆盖 ⇒ 走 descriptor（`.erb` ⇒ erb）；
 * 3. 覆盖变更 ⇒ **已存在**的 model 跟随（偏好层广播 + 池 `retargetLanguage`，不经 React 重渲染）；
 * 4. 撤销覆盖（`null`）⇒ 回到 descriptor；
 * 5. 同一路径多份 model（大小写 / 分隔符不同拼写各成一条记录）**全部**跟随。
 *
 * 本文件不加载真 Monaco：建 model / 重挂全部注入假件。判据本身（`resolveModelLanguage`）
 * 是生产同一枚函数——装配层 `editor-model-pool-instance.ts` 只是把它的描述符那一格换成
 * `languageIdForKojo2Model`，优先级一格不变。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  createEditorModelPool,
  languageFor,
  type EditorModelPool,
} from '../src/ui/editor-model-pool';
import {
  clearLanguageOverride,
  resolveModelLanguage,
  setLanguageOverride,
  subscribeLanguageOverride,
} from '../src/ui/language-mode-pref';

const ERB_PATH = 'C:\\kojo\\project\\口上\\角色.erb';
/** 同一份文件的另一种写法（小写盘符 + 正斜杠）——`pathKey` 归一后是同一条 */
const ERB_PATH_SLASH = 'c:/kojo/project/口上/角色.erb';
const OTHER_PATH = 'C:\\kojo\\project\\口上\\其他.erb';

/** 最小 localStorage 垫片（node 池没有 window；偏好模块的读取面就这一条） */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } as Storage;
}

interface FakeRecord {
  readonly model: Monaco.editor.ITextModel;
  readonly text: string;
  languageId: string;
  disposed: boolean;
}

/**
 * 假池：`createModel` 与生产同形（语言走单一判据），`setModelLanguage` 只改假件的语言 id。
 */
function harness(): { pool: EditorModelPool; records: FakeRecord[] } {
  const records: FakeRecord[] = [];
  const pool = createEditorModelPool({
    readText: async (_kernel, path) => ({ text: `正文:${path}`, encoding: 'utf-8', eol: 'LF' }),
    createModel: (path, text) => {
      const record = {
        languageId: resolveModelLanguage(path, languageFor(path)),
        text,
        disposed: false,
      } as { languageId: string; text: string; disposed: boolean; model?: Monaco.editor.ITextModel };
      const model = {
        dispose: () => {
          record.disposed = true;
        },
        getValue: () => record.text,
        getLanguageId: () => record.languageId,
        getValueLength: () => record.text.length,
      } as unknown as Monaco.editor.ITextModel;
      record.model = model;
      records.push(record as FakeRecord);
      return model;
    },
    setModelLanguage: (model, languageId) => {
      const record = records.find((candidate) => candidate.model === model);
      if (record !== undefined) record.languageId = languageId;
    },
  });
  return { pool, records };
}

/** 生产装配同形的跟随接线（`editor-model-pool-instance.ts` 里那条订阅的纯逻辑版） */
function bindFollow(pool: EditorModelPool): () => void {
  return subscribeLanguageOverride((filePath) => {
    pool.retargetLanguage(filePath, (model) => resolveModelLanguage(filePath, languageFor(filePath)));
  });
}

const kernel = {} as never;
const disposers: Array<() => void> = [];

beforeAll(() => {
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: memoryStorage() };
});

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe('model 语言覆盖 · 建 model 时生效', () => {
  it('① 有覆盖 ⇒ 建 model 直接挂覆盖语言（不等状态栏 effect）', async () => {
    setLanguageOverride(ERB_PATH, 'json');
    const h = harness();
    const entry = await h.pool.acquire(kernel, ERB_PATH);
    expect(entry.model.getLanguageId()).toBe('json');
  });

  it('② 无覆盖 ⇒ 走 descriptor（.erb ⇒ erb；另一份文件互不串）', async () => {
    setLanguageOverride(ERB_PATH, 'json');
    const h = harness();
    const other = await h.pool.acquire(kernel, OTHER_PATH);
    expect(other.model.getLanguageId()).toBe(languageFor(OTHER_PATH));
  });
});

describe('model 语言覆盖 · 已存在 model 跟随', () => {
  it('③ 切覆盖 ⇒ 已存在 model 跟随；同一覆盖重复写幂等不重挂', async () => {
    const h = harness();
    const entry = await h.pool.acquire(kernel, ERB_PATH);
    expect(entry.model.getLanguageId()).toBe(languageFor(ERB_PATH));

    disposers.push(bindFollow(h.pool));
    setLanguageOverride(ERB_PATH, 'json');
    expect(entry.model.getLanguageId()).toBe('json');

    // 同语言再判：幂等（重挂会重置 tokenization / 装饰，白挂一次就是可见闪动）
    expect(h.pool.retargetLanguage(ERB_PATH, () => 'json')).toBe(0);
  });

  it('④ 撤销覆盖（null）⇒ 回到 descriptor', async () => {
    setLanguageOverride(ERB_PATH, 'json');
    const h = harness();
    const entry = await h.pool.acquire(kernel, ERB_PATH);
    expect(entry.model.getLanguageId()).toBe('json');

    disposers.push(bindFollow(h.pool));
    clearLanguageOverride(ERB_PATH);
    expect(entry.model.getLanguageId()).toBe(languageFor(ERB_PATH));
  });

  it('⑤ 同一路径多份 model（两种拼写）全部跟随', async () => {
    const h = harness();
    const first = await h.pool.acquire(kernel, ERB_PATH);
    const second = await h.pool.acquire(kernel, ERB_PATH_SLASH);
    expect(first.model).not.toBe(second.model);
    expect(h.records).toHaveLength(2);

    disposers.push(bindFollow(h.pool));
    setLanguageOverride(ERB_PATH_SLASH, 'kojo2');
    expect(first.model.getLanguageId()).toBe('kojo2');
    expect(second.model.getLanguageId()).toBe('kojo2');
    expect(h.pool.retargetLanguage(ERB_PATH_SLASH, () => 'kojo2')).toBe(0);
  });

  it('未注入 setModelLanguage ⇒ 覆盖变更不假装改过（返回 0）', async () => {
    const records: FakeRecord[] = [];
    const pool = createEditorModelPool({
      readText: async () => ({ text: 'x', encoding: 'utf-8', eol: 'LF' }),
      createModel: (path, text) => {
        const record = {
          languageId: resolveModelLanguage(path, languageFor(path)),
          text,
          disposed: false,
        } as { languageId: string; text: string; disposed: boolean; model?: Monaco.editor.ITextModel };
        const model = {
          dispose: () => {
            record.disposed = true;
          },
          getValue: () => record.text,
          getLanguageId: () => record.languageId,
        } as unknown as Monaco.editor.ITextModel;
        record.model = model;
        records.push(record as FakeRecord);
        return model;
      },
    });
    const entry = await pool.acquire(kernel, ERB_PATH);
    setLanguageOverride(ERB_PATH, 'json');
    expect(pool.retargetLanguage(ERB_PATH, () => 'json')).toBe(0);
    expect(entry.model.getLanguageId()).toBe(languageFor(ERB_PATH));
  });
});
