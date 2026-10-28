/**
 * B3e · 引用 / 改名的**取数腿**（`kojo-language-service-legs` 的四个新函数 + 快照取数）。
 *
 * 这一层只做三件事，一行语言知识都没有：
 * 1. **请求构造**：身份三格 / 全文 / 位置 / 新名 / 项目 + 项目文件快照（缺席就不出现）；
 * 2. **快照取数**（宿主事实）：从项目索引现取、排除请求文件自己、文件数 / 字节数上限
 *    ⇒ `complete: false`（如实降级，不静默少给）；
 * 3. **单答裁决**：`undefined` = 无人应答（继续问下一家）；空结果 = 作答（不再问）。
 *    抛错按贡献隔离（warn 带 id）。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import type { Kojo2ProjectIndex } from '../src/monaco/kojo2-project-index';
import {
  collectReferences,
  collectRename,
  editorRequestIdentityOf,
  projectFilesSnapshotOf,
  referencesRequestOf,
  renameRequestOf,
} from '../src/monaco/kojo-language-service-legs';

/** 只答 `kind` 的那一条贡献 */
function answerKind(
  id: string,
  kind: 'references' | 'rename',
  result: unknown,
): EditorLanguageServiceContribution {
  return {
    id,
    provide: (request) => (request.kind === kind ? result : undefined),
  } as EditorLanguageServiceContribution;
}

const IDENTITY = { path: 'D:/p/a.kojo2', languageId: 'kojo2', version: 3 };
const PROJECT = { adapterId: 'proj-a' } as never;

function fakeIndex(
  files: ReadonlyArray<{ path: string; text: string }>,
  options: { readonly throwOnFiles?: boolean; readonly missingText?: string } = {},
): Kojo2ProjectIndex {
  return {
    files: () => {
      if (options.throwOnFiles === true) throw new Error('桩：files 炸了');
      return files.map((file) => file.path);
    },
    getFile: (target: string) => {
      if (options.missingText === target) return undefined;
      return files.find((file) => file.path === target);
    },
  } as unknown as Kojo2ProjectIndex;
}

/* ============================== ① 请求构造 ============================== */

describe('referencesRequestOf：身份缺省键不出现 + 行数口径 + 快照两格', () => {
  it('身份三格齐全时逐格递；lineCount = 行数', () => {
    const request = referencesRequestOf(IDENTITY, 'a\nb\nc', 2, 1, PROJECT);
    expect(request).toMatchObject({
      kind: 'references',
      path: 'D:/p/a.kojo2',
      languageId: 'kojo2',
      version: 3,
      text: 'a\nb\nc',
      line: 2,
      column: 1,
      lineCount: 3,
    });
    expect(Object.hasOwn(request, 'projectFiles')).toBe(false);
    expect(Object.hasOwn(request, 'projectFilesComplete')).toBe(false);
  });

  it('身份缺 languageId / version ⇒ 那两格不出现（不补假值）', () => {
    const request = referencesRequestOf({ path: 'D:/p/a.kojo2' }, '', 1, 1, null);
    expect(Object.hasOwn(request, 'languageId')).toBe(false);
    expect(Object.hasOwn(request, 'version')).toBe(false);
    expect(request.lineCount).toBe(1);
  });

  it('快照在场 ⇒ projectFiles 与 projectFilesComplete 一起出现', () => {
    const request = referencesRequestOf(IDENTITY, 'x', 1, 1, null, {
      files: [{ path: 'D:/p/b.kojo2', text: 'b' }],
      complete: false,
    });
    expect(request.projectFiles).toEqual([{ path: 'D:/p/b.kojo2', text: 'b' }]);
    expect(request.projectFilesComplete).toBe(false);
  });
});

describe('renameRequestOf：与 references 同源形状、多带 newName', () => {
  it('newName 原样递；无快照 ⇒ 不出现 projectFiles', () => {
    const request = renameRequestOf(IDENTITY, 'x', 1, 5, '情绪', PROJECT);
    expect(request).toMatchObject({
      kind: 'rename',
      path: 'D:/p/a.kojo2',
      languageId: 'kojo2',
      version: 3,
      line: 1,
      column: 5,
      newName: '情绪',
      lineCount: 1,
    });
    expect(Object.hasOwn(request, 'projectFiles')).toBe(false);
  });

  it('快照在场 ⇒ 两格都出现（供给方做全或无判断）', () => {
    const request = renameRequestOf(IDENTITY, 'x', 1, 5, '情绪', null, {
      files: [],
      complete: true,
    });
    expect(request.projectFiles).toEqual([]);
    expect(request.projectFilesComplete).toBe(true);
  });
});

/* ============================== ② 项目文件快照 ============================== */

describe('projectFilesSnapshotOf：排除自身 / 文件数与字节上限 / 读不到如实降级', () => {
  it('索引缺席 ⇒ undefined（请求里就不出现快照）', () => {
    expect(projectFilesSnapshotOf(null, 'D:/p/a.kojo2')).toBeUndefined();
    expect(projectFilesSnapshotOf(undefined, 'D:/p/a.kojo2')).toBeUndefined();
  });

  it('按归一键排除请求文件自己（大小写 / 分隔符写法不同也排除）', () => {
    const index = fakeIndex([
      { path: 'D:/p/a.kojo2', text: 'self' },
      { path: 'd:\\p\\other.kojo2', text: 'other' },
    ]);
    const snapshot = projectFilesSnapshotOf(index, 'D:\\P\\A.KOJO2');
    expect(snapshot?.files).toEqual([{ path: 'd:\\p\\other.kojo2', text: 'other' }]);
    expect(snapshot?.complete).toBe(true);
  });

  it('文件数超上限 ⇒ 截到上限、complete = false', () => {
    const index = fakeIndex([
      { path: 'D:/p/a.kojo2', text: 'self' },
      { path: 'D:/p/b.kojo2', text: 'b' },
      { path: 'D:/p/c.kojo2', text: 'c' },
    ]);
    const snapshot = projectFilesSnapshotOf(index, 'D:/p/a.kojo2', { maxFiles: 1 });
    expect(snapshot?.files.map((file) => file.path)).toEqual(['D:/p/b.kojo2']);
    expect(snapshot?.complete).toBe(false);
  });

  it('字节数超上限 ⇒ 不出这一份（后续更大的也不再试）、complete = false', () => {
    const index = fakeIndex([
      { path: 'D:/p/b.kojo2', text: '0123456789' },
      { path: 'D:/p/c.kojo2', text: 'c' },
    ]);
    const snapshot = projectFilesSnapshotOf(index, '', { maxBytes: 4 });
    expect(snapshot?.files).toEqual([]);
    expect(snapshot?.complete).toBe(false);
  });

  it('getFile 读不到 ⇒ 跳过该份并 complete = false（索引说有却读不到 ≠ 没有）', () => {
    const index = fakeIndex(
      [
        { path: 'D:/p/b.kojo2', text: 'b' },
        { path: 'D:/p/c.kojo2', text: 'c' },
      ],
      { missingText: 'D:/p/b.kojo2' },
    );
    const snapshot = projectFilesSnapshotOf(index, '');
    expect(snapshot?.files.map((file) => file.path)).toEqual(['D:/p/c.kojo2']);
    expect(snapshot?.complete).toBe(false);
  });

  it('索引 files() 抛错 ⇒ 空快照 + complete = false（不把异常甩给 provider）', () => {
    const snapshot = projectFilesSnapshotOf(fakeIndex([], { throwOnFiles: true }), '');
    expect(snapshot).toEqual({ files: [], complete: false });
  });
});

/* ============================== ③ 单答裁决 ============================== */

const REFERENCES_REQUEST: EditorLanguageServiceRequest = {
  kind: 'references',
  path: 'D:/p/a.kojo2',
  text: 'x',
  line: 1,
  column: 1,
  project: null,
};

const RENAME_REQUEST: EditorLanguageServiceRequest = {
  kind: 'rename',
  path: 'D:/p/a.kojo2',
  text: 'x',
  line: 1,
  column: 1,
  newName: 'y',
  project: null,
};

describe('collectReferences / collectRename：弃权跳过、空结果作答、抛错隔离', () => {
  it('弃权（undefined / 其它 kind）⇒ 问下一家', () => {
    const first: EditorLanguageServiceContribution = {
      id: 'hover-only',
      provide: () => ({ kind: 'hover', contents: '无关' }),
    } as EditorLanguageServiceContribution;
    const second = answerKind('real', 'references', { kind: 'references', locations: [] });
    expect(collectReferences([first, second], REFERENCES_REQUEST)).toEqual({
      kind: 'references',
      locations: [],
    });
  });

  it('空结果是作答：第一家给空表就停（不再问下一家）', () => {
    const secondProvide = vi.fn(() => ({ kind: 'references', locations: [] }));
    const contributions = [
      answerKind('first', 'references', { kind: 'references', locations: [] }),
      { id: 'second', provide: secondProvide } as unknown as EditorLanguageServiceContribution,
    ];
    expect(collectReferences(contributions, REFERENCES_REQUEST)).toEqual({
      kind: 'references',
      locations: [],
    });
    expect(secondProvide).not.toHaveBeenCalled();
  });

  it('无人应答 ⇒ undefined（宿主保留"插件没装"的可见退化）', () => {
    expect(collectReferences([], REFERENCES_REQUEST)).toBeUndefined();
    expect(collectRename([], RENAME_REQUEST)).toBeUndefined();
  });

  it('rename 同一条纪律：第一家作答即停，rejectReason 原样交回', () => {
    const result = { kind: 'rename', edits: [], rejectReason: '新名非法' };
    const secondProvide = vi.fn(() => ({ kind: 'rename', edits: [] }));
    const contributions = [
      answerKind('first', 'rename', result),
      { id: 'second', provide: secondProvide } as unknown as EditorLanguageServiceContribution,
    ];
    expect(collectRename(contributions, RENAME_REQUEST)).toEqual(result);
    expect(secondProvide).not.toHaveBeenCalled();
  });

  it('一家抛错只让这家缺席（warn 带 id），下一家照问', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom: EditorLanguageServiceContribution = {
      id: 'boom',
      provide: () => {
        throw new Error('炸了');
      },
    } as unknown as EditorLanguageServiceContribution;
    const good = answerKind('good', 'references', {
      kind: 'references',
      locations: [{ filePath: 'D:/p/a.kojo2', line: 1, kind: 'mention' }],
    });
    const result = collectReferences([boom, good], REFERENCES_REQUEST);
    expect(result?.locations).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('boom');
    warn.mockRestore();
  });
});

/* ============================== ④ 身份三格（同源） ============================== */

describe('editorRequestIdentityOf：能取到才出现', () => {
  it('uri 的 fsPath / languageId / version 原样取；桩 model 缺格就不出现', () => {
    const model = {
      uri: { fsPath: 'D:/p/a.kojo2' },
      getLanguageId: () => '',
      getVersionId: () => Number.NaN,
    } as unknown as Parameters<typeof editorRequestIdentityOf>[0];
    expect(editorRequestIdentityOf(model)).toEqual({ path: 'D:/p/a.kojo2' });
  });
});
