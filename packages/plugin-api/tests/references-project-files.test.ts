/**
 * B3e · `EditorProjectFile` / `projectFiles` / `projectFilesComplete` 的契约闸。
 *
 * 契约是 additive 的：缺席 = 旧行为逐字不变。这里钉三件事：
 * 1. **形状**：两个请求成员带可选快照两格；`EditorReferencesResult.truncated` 可缺省；
 * 2. **缺席零改动**：不带新格的对象仍是合法请求（旧贡献方 / 旧测试零改动）；
 * 3. **桶导出**：`EditorProjectFile` 从 `@kojo/plugin-api` 桶里可拿（供方与宿主同一枚类型）。
 */
import { describe, expect, it } from 'vitest';
import type {
  EditorLanguageServiceResult,
  EditorProjectFile,
  EditorReferencesRequest,
  EditorReferencesResult,
  EditorRenameRequest,
  EditorRenameResult,
} from '@kojo/plugin-api';

const FILE: EditorProjectFile = { path: 'D:/p/a.kojo2', text: '# 表 心情 由 1' };

describe('EditorProjectFile：快照的两格（路径 + 文本）', () => {
  it('形状就是 path + text（不含语言 / 版本——那是请求身份的事）', () => {
    expect(Object.keys(FILE).sort()).toEqual(['path', 'text']);
  });

  it('只读：类型面不允许写回（编译期契约；运行时不是冻结对象）', () => {
    // @ts-expect-error —— 快照是只读事实，供方不许改（tsc 这一行必须报错）
    FILE.path = 'D:/p/b.kojo2';
    // 类型面已封死；这里把对象还原成契约值，免得改动泄漏到后续用例
    (FILE as { path: string }).path = 'D:/p/a.kojo2';
    expect(FILE.path).toBe('D:/p/a.kojo2');
  });
});

describe('references / rename 请求：两个新格都是可选', () => {
  it('不带快照 ⇒ 仍是合法请求（旧行为逐字不变）', () => {
    const references: EditorReferencesRequest = {
      kind: 'references',
      path: 'D:/p/a.kojo2',
      text: 'x',
      line: 1,
      column: 1,
      project: null,
    };
    const rename: EditorRenameRequest = {
      kind: 'rename',
      path: 'D:/p/a.kojo2',
      text: 'x',
      line: 1,
      column: 1,
      newName: 'y',
      project: null,
    };
    expect(Object.hasOwn(references, 'projectFiles')).toBe(false);
    expect(Object.hasOwn(rename, 'projectFilesComplete')).toBe(false);
  });

  it('带快照 + 完整性事实 ⇒ 两格都收下（不完整也能表达）', () => {
    const request: EditorReferencesRequest = {
      kind: 'references',
      path: 'D:/p/a.kojo2',
      text: 'x',
      line: 1,
      column: 1,
      project: null,
      projectFiles: [FILE],
      projectFilesComplete: false,
    };
    expect(request.projectFiles).toEqual([FILE]);
    expect(request.projectFilesComplete).toBe(false);
  });
});

describe('响应：additive 字段缺席即旧行为', () => {
  it('`truncated` 缺省合法（旧消费方看不见它照常工作）', () => {
    const result: EditorReferencesResult = { kind: 'references', locations: [] };
    expect(Object.hasOwn(result, 'truncated')).toBe(false);
    expect((result as EditorLanguageServiceResult).kind).toBe('references');
  });

  it('改名结果复用现有两格：edits + rejectReason（不新造成员）', () => {
    const rejected: EditorRenameResult = { kind: 'rename', edits: [], rejectReason: '新名非法' };
    expect(rejected.edits).toEqual([]);
    expect(rejected.rejectReason).toBe('新名非法');
  });
});
