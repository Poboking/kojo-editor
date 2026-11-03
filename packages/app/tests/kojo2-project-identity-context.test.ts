/**
 * M2-P1 宿主入口测试（只读生产代码）：
 * - 跨平台文件身份：win32 大小写/分隔符归一，POSIX 保留大小写；
 * - layerId / path / contentHash 各自在身份与变化检测中的正确分工；
 * - contentHash 与 plugin-api stableHash 同源；
 * - 文件级上下文：charNo 最长前缀，缺席 familySegment 与显式空串严格可区分。
 */
import { describe, expect, it } from 'vitest';
import { stableHash, type GameProject } from '@kojo/plugin-api';
import { kojo2ProjectFileIdentity } from '../src/ui/kojo2-project-file-identity';
import {
  charNoForProjectPath,
  kojo2FunctionNameContextForFile,
} from '../src/ui/kojo2-file-context';

describe('kojo2ProjectFileIdentity · 跨平台身份', () => {
  it('Windows 大小写/斜杠变体指向同一 fileId', () => {
    const first = kojo2ProjectFileIdentity('C:\\Game\\Kojo\\Event\\A.kojo2', '同样正文');
    const second = kojo2ProjectFileIdentity('c:/game/kojo/event/a.KOJO2', '同样正文');

    expect(first.pathKey).toBe(second.pathKey);
    expect(first.fileId).toBe(second.fileId);
    expect(first.path).toBe('C:\\Game\\Kojo\\Event\\A.kojo2');
    expect(second.path).toBe('c:/game/kojo/event/a.KOJO2');
  });

  it('POSIX 路径大小写是不同文件', () => {
    const upper = kojo2ProjectFileIdentity('/game/kojo/Event/A.kojo2', '同样正文');
    const lower = kojo2ProjectFileIdentity('/game/kojo/Event/a.kojo2', '同样正文');

    expect(upper.fileId).not.toBe(lower.fileId);
  });

  it('同一路径不同 layerId → 不同 fileId', () => {
    const base = kojo2ProjectFileIdentity('C:\\game\\kojo\\event.kojo2', '正文');
    const overlay = kojo2ProjectFileIdentity('C:\\game\\kojo\\event.kojo2', '正文', 'overlay');

    expect(base.layerId).toBeNull();
    expect(overlay.layerId).toBe('overlay');
    expect(base.fileId).not.toBe(overlay.fileId);
  });

  it('同内容不同路径 → 不同 fileId，但 contentHash 相同', () => {
    const first = kojo2ProjectFileIdentity('C:\\game\\kojo\\a.kojo2', '同内容');
    const second = kojo2ProjectFileIdentity('C:\\game\\kojo\\b.kojo2', '同内容');

    expect(first.fileId).not.toBe(second.fileId);
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('同路径内容变化 → fileId 不变，contentHash 变化', () => {
    const before = kojo2ProjectFileIdentity('C:\\game\\kojo\\a.kojo2', '旧内容');
    const after = kojo2ProjectFileIdentity('C:\\game\\kojo\\a.kojo2', '新内容');

    expect(before.fileId).toBe(after.fileId);
    expect(before.contentHash).not.toBe(after.contentHash);
  });

  it('contentHash 与 plugin-api stableHash 同源', () => {
    const text = '内容哈希必须来自 plugin-api';
    const identity = kojo2ProjectFileIdentity('/game/kojo/a.kojo2', text);

    expect(identity.contentHash).toBe(stableHash(text));
  });
});

describe('kojo2-file-context · 文件级上下文', () => {
  const project: GameProject = {
    rootDir: 'C:\\game',
    adapterId: 'fixture',
    kojoPaths: ['C:\\game\\kojo'],
    writablePaths: [],
    charaIndex: new Map([
      [1, { no: 1, name: '一号', kojoDir: 'C:\\game\\kojo' }],
      [2, { no: 2, name: '二号', kojoDir: 'C:\\game\\kojo\\灵梦' }],
    ]),
  };

  it('charNo 取 charaIndex 的最长目录前缀，并跨 win32 大小写/斜杠归一', () => {
    expect(charNoForProjectPath(project, 'c:/GAME/kojo/灵梦/event.kojo2')).toBe('2');
    expect(charNoForProjectPath(project, 'C:\\game\\kojo\\common\\event.kojo2')).toBe('1');
  });

  it('推不到 charNo 时保持缺席，不伪造空串', () => {
    expect(charNoForProjectPath(project, 'C:\\game\\other\\event.kojo2')).toBeUndefined();
    expect(charNoForProjectPath(null, 'C:\\game\\kojo\\灵梦\\event.kojo2')).toBeUndefined();

    const context = kojo2FunctionNameContextForFile(project, {
      path: 'C:\\game\\other\\event.kojo2',
    });
    expect(Object.prototype.hasOwnProperty.call(context, 'charNo')).toBe(false);
    expect(context).toEqual({});
  });

  it('familySegment resolver 返回 undefined → 保持缺席', () => {
    const context = kojo2FunctionNameContextForFile(
      project,
      { path: 'C:\\game\\kojo\\灵梦\\event.kojo2' },
      () => undefined,
    );

    expect(context.charNo).toBe('2');
    expect(Object.prototype.hasOwnProperty.call(context, 'familySegment')).toBe(false);
  });

  it('familySegment resolver 返回空串 → 保留显式空串 own property', () => {
    const context = kojo2FunctionNameContextForFile(
      project,
      { path: 'C:\\game\\kojo\\灵梦\\event.kojo2', layerId: 'overlay' },
      () => '',
    );

    expect(context.charNo).toBe('2');
    expect(Object.prototype.hasOwnProperty.call(context, 'familySegment')).toBe(true);
    expect(context.familySegment).toBe('');
  });
});