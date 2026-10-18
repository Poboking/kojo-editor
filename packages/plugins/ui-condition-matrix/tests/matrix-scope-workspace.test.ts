/**
 * 「我的口上项目」→ 当前角色的归属（零 React / 零 IO）。
 *
 * 三条判据（meta / importedFrom / dirName）各钉正例与反例；优先级、去重、排序、
 * 缺省 charaDir、解析不到的 projectDir 单独成案——这些正是下拉里「多一条 /
 * 少一条 / 顺序乱跳」的直接来源。
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceArtifact, WorkspaceProject } from '@kojo/plugin-api';
import type { AuthorPack, WorkspaceMatrixPack } from '../src/matrix-scope';
import {
  WORKSPACE_PACK_PREFIX,
  collectWorkspaceMatrixPacks,
  workspacePackKey,
} from '../src/matrix-scope';

const CHARA_NO = 7;
const CHARA_DIR = 'C:\\game\\kojo\\K7';

/* ------------------------------ 假件 ------------------------------ */

function pack(dirName: string): AuthorPack {
  return {
    key: dirName,
    dirName,
    label: dirName || '（角色根目录）',
    dirPath: dirName ? `${CHARA_DIR}\\${dirName}` : CHARA_DIR,
    functionCount: 1,
    fileCount: 1,
    isRoot: dirName === '',
    isExternal: false,
  };
}

function artifact(
  id: string,
  name: string,
  dirName: string,
  meta: Record<string, unknown> = {},
): WorkspaceArtifact {
  return { id, name, dirName, meta, createdAt: 1 };
}

function project(id: string, name: string, artifacts: WorkspaceArtifact[]): WorkspaceProject {
  return { id, name, createdAt: 1, updatedAt: 1, artifacts, meta: {} };
}

const GAME_PACKS: readonly AuthorPack[] = [pack('我的口上'), pack(''), pack('OtherPack')];

const BASE_OPTS = {
  charaNo: CHARA_NO,
  charaDir: CHARA_DIR as string | undefined,
  gamePacks: GAME_PACKS,
  projectDir: (id: string): string | null => `C:\\ws\\${id}`,
};

function collect(
  projects: readonly WorkspaceProject[],
  overrides: Partial<typeof BASE_OPTS> = {},
): WorkspaceMatrixPack[] {
  return collectWorkspaceMatrixPacks({ ...BASE_OPTS, projects, ...overrides });
}

/* ------------------------------ 判据 ------------------------------ */

describe('collectWorkspaceMatrixPacks · 归属判据', () => {
  it('meta：角色号数值相等即归属（number / 数字字符串都认），键与 ref 形状正确', () => {
    const projects = [
      project('p1', 'Work', [
        artifact('a1', 'A-number', 'a-pack', { charaNo: 7 }),
        artifact('a2', 'B-string', 'b-pack', { charaNo: '7' }),
        artifact('a3', 'C-other', 'c-pack', { charaNo: '8' }),
        artifact('a4', 'D-nonnum', 'd-pack', { charaNo: '7x' }),
      ]),
    ];
    const packs = collect(projects);
    expect(packs.map((p) => [p.ref.artifactId, p.attribution])).toEqual([
      ['a1', 'meta'],
      ['a2', 'meta'],
    ]);

    const hit = packs[0]!;
    expect(WORKSPACE_PACK_PREFIX).toBe('ws:');
    expect(hit.key).toBe('ws:p1:a1');
    expect(hit.key).toBe(`${WORKSPACE_PACK_PREFIX}p1:a1`);
    expect(workspacePackKey('p1', 'a1')).toBe('ws:p1:a1');
    expect(hit.label).toBe('我的：A-number');
    expect(hit.ref).toEqual({
      projectId: 'p1',
      projectName: 'Work',
      artifactId: 'a1',
      artifactName: 'A-number',
      dirName: 'a-pack',
      rootPath: 'C:\\ws\\p1\\a-pack',
    });
  });

  it('source：importedFrom 位于角色目录之下即归属（大小写/分隔符折叠），目录外或空值不命中', () => {
    const projects = [
      project('p1', 'Work', [
        artifact('a1', 'A-under', 'a-pack', { importedFrom: 'c:/GAME/kojo/k7/旧包' }),
        artifact('a2', 'B-self', 'b-pack', { importedFrom: CHARA_DIR }),
        artifact('a3', 'C-outside', 'c-pack', { importedFrom: 'C:\\game\\kojo\\K8\\旧包' }),
        artifact('a4', 'D-empty', 'd-pack', { importedFrom: '' }),
        artifact('a5', 'E-nonstr', 'e-pack', { importedFrom: 42 }),
      ]),
    ];
    expect(collect(projects).map((p) => [p.ref.artifactId, p.attribution])).toEqual([
      ['a1', 'source'],
      ['a2', 'source'],
    ]);
  });

  it('source：charaDir 缺省时跳过该判据，meta / dirName 仍生效', () => {
    const projects = [
      project('p1', 'Work', [
        artifact('a1', 'A-meta', 'a-pack', { charaNo: 7 }),
        artifact('a2', 'B-source', 'b-pack', { importedFrom: `${CHARA_DIR}\\旧包` }),
        artifact('a3', 'C-dir', '我的口上'),
      ]),
    ];
    expect(collect(projects, { charaDir: undefined }).map((p) => p.ref.artifactId)).toEqual([
      'a1',
      'a3',
    ]);
  });

  it('dirName：与口上包目录名大小写折叠相等即归属；空 dirName 不参与匹配', () => {
    const projects = [
      project('p1', 'Work', [
        artifact('a1', 'A-case', 'MYPACK'),
        artifact('a2', 'B-empty', ''),
        artifact('a3', 'C-miss', 'MyPack2'),
      ]),
    ];
    const packs = collect(projects, { gamePacks: [pack('MyPack'), pack(''), pack('MyPack2X')] });
    expect(packs.map((p) => [p.ref.artifactId, p.attribution])).toEqual([['a1', 'dirName']]);
  });
});

/* ------------------------------ 优先级 / 去重 / 排序 ------------------------------ */

describe('collectWorkspaceMatrixPacks · 优先级与顺序', () => {
  it('优先级 meta > source > dirName，同一 artifact 只出现一次', () => {
    const projects = [
      project('p1', 'Work', [
        artifact('a1', 'A-all', '我的口上', {
          charaNo: 7,
          importedFrom: `${CHARA_DIR}\\旧包`,
        }),
        artifact('a2', 'B-source', '我的口上', {
          charaNo: 8,
          importedFrom: `${CHARA_DIR}\\旧包`,
        }),
        artifact('a3', 'C-dir', '我的口上', { charaNo: '8' }),
        artifact('a4', 'D-none', '别的包', { charaNo: 8 }),
      ]),
    ];
    const packs = collect(projects);
    expect(packs.map((p) => [p.ref.artifactId, p.attribution])).toEqual([
      ['a1', 'meta'],
      ['a2', 'source'],
      ['a3', 'dirName'],
    ]);
    expect(new Set(packs.map((p) => p.key)).size).toBe(packs.length);
  });

  it('排序按 projectName / artifactName；同名保持输入顺序（稳定）', () => {
    const projects = [
      project('p2', 'Beta', [
        artifact('b1', 'B-pack', 'x', { charaNo: 7 }),
        artifact('b0', 'A-pack', 'y', { charaNo: 7 }),
      ]),
      project('p1', 'Alpha', [
        artifact('a2', 'Same', 'z', { charaNo: 7 }),
        artifact('a1', 'Same', 'w', { charaNo: 7 }),
        artifact('a0', 'A-pack', 'v', { charaNo: 7 }),
      ]),
    ];
    expect(collect(projects).map((p) => p.ref.artifactId)).toEqual([
      'a0', // Alpha / A-pack
      'a2', // Alpha / Same（输入序在前）
      'a1', // Alpha / Same
      'b0', // Beta / A-pack
      'b1', // Beta / B-pack
    ]);
  });

  it('空 dirName 与 projectDir 解析不到（null 或抛错）的项目都跳过', () => {
    const projects = [
      project('p1', 'Alpha', [
        artifact('a1', 'A-empty', '', { charaNo: 7 }),
        artifact('a2', 'B-ok', 'a-pack', { charaNo: 7 }),
      ]),
      project('ghost', 'Ghost', [artifact('g1', 'G-null', 'g-pack', { charaNo: 7 })]),
      project('boom', 'Boom', [artifact('m1', 'M-throw', 'm-pack', { charaNo: 7 })]),
    ];
    const packs = collect(projects, {
      projectDir: (id) => {
        if (id === 'ghost') return null;
        if (id === 'boom') throw new Error('项目目录不可用');
        return `C:\\ws\\${id}`;
      },
    });
    expect(packs.map((p) => p.ref.artifactId)).toEqual(['a2']);
  });
});
