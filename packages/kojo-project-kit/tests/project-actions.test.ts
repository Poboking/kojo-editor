import { describe, expect, it } from 'vitest';
import {
  projectNameProblem,
  sameRootProjectNames,
  suggestDuplicateName,
} from '../src/project-actions';

/** 项目行动作的纯函数半边：名称校验、副本命名、同根名单（2026-11-02 重命名 / 复制批） */

const project = (id: string, name: string) => ({
  id,
  name,
  createdAt: 0,
  updatedAt: 0,
  artifacts: [],
  meta: {},
});

describe('projectNameProblem · 名称校验', () => {
  it('空名 / 仅空白拒绝（中文原因）', () => {
    expect(projectNameProblem('', [])).toMatch(/不能为空/);
    expect(projectNameProblem('   ', [])).toMatch(/不能为空/);
  });

  it('与既有项目重名拒绝，并点名冲突名', () => {
    expect(projectNameProblem('甲作品', ['甲作品', '乙作品'])).toContain('甲作品');
    expect(projectNameProblem('甲作品', ['甲作品', '乙作品'])).toMatch(/同名项目/);
  });

  it('可用名返回 null（前后空白按 trim 后判定）', () => {
    expect(projectNameProblem('  新名  ', ['旧名'])).toBeNull();
  });
});

describe('suggestDuplicateName · 副本命名建议', () => {
  it('缺省「<原名> 副本」', () => {
    expect(suggestDuplicateName('甲作品', [])).toBe('甲作品 副本');
  });

  it('已占用则顺延编号，跳过已被占用的「副本 2」', () => {
    expect(suggestDuplicateName('甲作品', ['甲作品 副本'])).toBe('甲作品 副本 2');
    expect(suggestDuplicateName('甲作品', ['甲作品 副本', '甲作品 副本 2'])).toBe('甲作品 副本 3');
  });

  it('原名不同不互相影响', () => {
    expect(suggestDuplicateName('乙作品', ['甲作品 副本'])).toBe('乙作品 副本');
  });
});

describe('sameRootProjectNames · 同根名单', () => {
  const dirOf = (id: string): string => `D:/workspace/self/${id}`;

  it('只收同一父目录下的其它项目，排除自己', () => {
    const names = sameRootProjectNames(
      [project('p1', '甲'), project('p2', '乙'), project('p3', '丙')],
      'p1',
      dirOf,
    );
    expect(names).toEqual(['乙', '丙']);
  });

  it('不同落点根的项目不混入（分隔符 / 大小写差异折平后比较）', () => {
    const dirs: Record<string, string> = {
      p1: 'D:/workspace/a/p1',
      p2: 'D:\\WORKSPACE\\A\\p2',
      p3: 'D:/workspace/b/p3',
    };
    const names = sameRootProjectNames(
      [project('p1', '甲'), project('p2', '乙'), project('p3', '丙')],
      'p1',
      (id) => dirs[id]!,
    );
    expect(names).toEqual(['乙']);
  });

  it('目录路径取不到时返回空名单（不抛）', () => {
    const names = sameRootProjectNames(
      [project('p1', '甲'), project('p2', '乙')],
      'p1',
      () => {
        throw new Error('no dir');
      },
    );
    expect(names).toEqual([]);
  });
});
