/**
 * 替换执行器的 **live model 查找**（`search-replace-exec.ts` 缺省通道）单测。
 *
 * 钉死 HK-7 那条路径判等纪律在替换面的落点：Monaco 的注册表按 **URI 字符串精确匹配**，
 * 而 `Uri.file` 只归一分隔符、**保留盘符大小写**——检索索引里的路径写法与标签建立时那份
 * 不一致时，精确取会判"没开"，于是**开着且脏的标签被当成关闭文件**：读磁盘副本、写盘，
 * 绕开 live buffer，随后与缓冲区相撞。缺省通道因此必须回落到全仓统一的 `pathKey` 口径。
 *
 * monaco 运行时不进 node（本池 environment = node），故 `../src/monaco/entry` 用 `vi.mock`
 * 桩掉——桩的形状照真实 vscode-uri：`fsPath` 折盘符大小写并把 `/` 换成 `\`，
 * `toString()` 保留原拼写（这正是两种写法 URI 不相等的原因）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplaceRequest } from '../src/ui/search-store';

interface FakeModel {
  readonly uri: { scheme: string; fsPath: string; toString(): string };
  readonly lines: string[];
  readonly applied: unknown[][];
  getLineCount(): number;
  getLineContent(n: number): string;
  applyEdits(edits: unknown[]): void;
}

const stub = vi.hoisted(() => {
  const models: FakeModel[] = [];
  /** 真实 `Uri.file` 的同形桩：分隔符归一 + fsPath 折盘符大小写，toString 保留原拼写 */
  const fileUri = (p: string) => {
    const slashed = p.replace(/\\/g, '/');
    const withLeading = slashed.startsWith('/') ? slashed : `/${slashed}`;
    const backslashed = withLeading.replace(/\//g, '\\');
    return {
      scheme: 'file',
      fsPath: backslashed.replace(/^\\([A-Za-z]:)/, (_m, d: string) => `\\${d.toLowerCase()}`),
      toString: () => `file://${withLeading}`,
    };
  };
  const createModel = (creationPath: string, lines: string[]): FakeModel => {
    const model: FakeModel = {
      uri: fileUri(creationPath),
      lines,
      applied: [],
      getLineCount: () => model.lines.length,
      getLineContent: (n: number) => model.lines[n - 1] ?? '',
      applyEdits: (edits: unknown[]) => {
        model.applied.push(edits);
      },
    };
    models.push(model);
    return model;
  };
  return { models, fileUri, createModel };
});

vi.mock('../src/monaco/entry', () => ({
  Uri: { file: (p: string) => stub.fileUri(p) },
  editor: {
    getModel: (uri: { toString(): string }) => stub.models.find((m) => m.uri.toString() === uri.toString()),
    getModels: () => stub.models,
  },
}));

// 动态 import：保证上面两块的桩先就位（本模块在 import 期就会碰 monaco 运行时的话，静态 import 会炸）
const { createFileReplaceRunner, pickModelByPathKey } = await import('../src/ui/search-replace-exec');

/** 脏标签：用 `d:\...`（小写盘符）建的 model */
const TAB_PATH = 'd:\\p\\erb\\a.ERB';
/** 检索索引给的同一文件：`D:\...`（大写盘符 + 目录大小写不同）⇒ 两份 URI 字符串 */
const INDEX_PATH = 'D:\\p\\ERB\\a.ERB';

function requestOf(path: string, preview: string, start: number, end: number): ReplaceRequest {
  return {
    query: 'OLD',
    options: { isRegex: false, caseSensitive: false, wholeWord: false },
    replaceText: 'NEW',
    mode: { kind: 'all' },
    files: [{ path, matches: [{ line: 1, column: start + 1, preview, start, end }] }],
  };
}

beforeEach(() => {
  stub.models.length = 0;
});

describe('pickModelByPathKey · 全仓路径判等口径', () => {
  it('盘符大小写/分隔符不同也能找回那份 model（同一文件的两种写法是一份正文）', () => {
    const model = { uri: { scheme: 'file', fsPath: 'd:\\p\\erb\\a.ERB' } };
    expect(pickModelByPathKey([model], INDEX_PATH)).toBe(model);
    expect(pickModelByPathKey([model], 'D:/p/ERB/a.ERB')).toBe(model);
  });

  it('非 `file:` scheme 的派生 model 一律不当命中（糖视图正文不是真文件正文）', () => {
    const sugar = { uri: { scheme: 'inmemory', fsPath: '/sugar/a.kojo' } };
    expect(pickModelByPathKey([sugar], 'a.kojo')).toBeUndefined();
  });

  it('确实是另一个文件 ⇒ undefined（不误认领别人的 buffer）', () => {
    const other = { uri: { scheme: 'file', fsPath: 'd:\\p\\erb\\b.ERB' } };
    expect(pickModelByPathKey([other], INDEX_PATH)).toBeUndefined();
  });
});

describe('createFileReplaceRunner · 缺省 model 通道', () => {
  it('脏且已开的标签即使拼写不同也认得：只改 live model，一次盘写都不发', async () => {
    const open = stub.createModel(TAB_PATH, ['CALL OLD']);
    const writes: string[] = [];
    const reads: string[] = [];
    const runner = createFileReplaceRunner({
      io: {
        isWritable: () => true,
        readText: async (p: string) => {
          reads.push(p);
          return { text: 'CALL OLD' }; // 磁盘副本：缓冲区在着就不许读它
        },
        writeText: async (p: string) => {
          writes.push(p);
        },
      },
    });
    const out = await runner(requestOf(INDEX_PATH, 'CALL OLD', 5, 8));
    expect(out.applied).toBe(1);
    expect(out.filesChanged).toBe(1);
    expect(out.errors).toEqual([]);
    expect(open.applied).toHaveLength(1); // 落在 live model 上
    expect(writes).toEqual([]); // 绝不绕开缓冲区写盘
    expect(reads).toEqual([]);
  });

  it('同一文件的两种写法在结果清单里只算一份（去重按 pathKey）', async () => {
    stub.createModel(TAB_PATH, ['CALL OLD']);
    const writes: string[] = [];
    const runner = createFileReplaceRunner({
      io: {
        isWritable: () => true,
        readText: async () => ({ text: 'CALL OLD' }),
        writeText: async (p: string) => {
          writes.push(p);
        },
      },
    });
    const req = requestOf(INDEX_PATH, 'CALL OLD', 5, 8);
    const out = await runner({
      ...req,
      files: [...req.files, { path: TAB_PATH, matches: [{ line: 1, column: 6, preview: 'CALL OLD', start: 5, end: 8 }] }],
    });
    expect(out.filesChanged).toBe(1);
    expect(writes).toEqual([]);
  });

  it('没开的文件照旧走内核 io（读改写），改动没有少干活', async () => {
    const writes: Array<{ path: string; text: string }> = [];
    const runner = createFileReplaceRunner({
      io: {
        isWritable: () => true,
        readText: async () => ({ text: 'CALL OLD\nCALL OLD\n' }),
        writeText: async (path: string, text: string) => {
          writes.push({ path, text });
        },
      },
    });
    const out = await runner(requestOf('D:\\p\\ERB\\closed.ERB', 'CALL OLD', 5, 8));
    expect(out.applied).toBe(2); // 全部替换扫每一行，检索结果只是预览
    expect(out.filesChanged).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe('CALL NEW\nCALL NEW\n');
  });
});
