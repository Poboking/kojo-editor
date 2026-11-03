/**
 * Kojo 2.0 项目问题 → 问题面板翻译单测（`kojo2-project-problems.ts`）。
 *
 * 钉四件事：
 * 1. 项目级条目落虚拟 bucket `kojo2:build`（行 1、无 span），消息前缀通道标签；
 * 2. 带路径条目保留真实 path，消息里带 `shortPath:line`；`column` → 零宽 span；
 * 3. 严重级 / 诊断码 / 来源标签原样；五个通道各有标签；
 * 4. publish 后 `snapshot()` 查得到，且与 `kojo2:project` 那一簇**互不覆盖**；clear 只清本 bucket。
 *
 * `problem-store` 是模块级全局：每个用例后 `clearProjectScan()` 清账（不碰编辑器实时簇）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearProjectScan,
  setProjectScanProblems,
  snapshot,
  type EditorProblem,
} from '../src/ui/problem-store';
import {
  KOJO2_BUILD_PROBLEM_PATH,
  clearKojo2ProjectProblems,
  publishKojo2ProjectProblems,
  toEditorProblems,
} from '../src/ui/kojo2-project-problems';
import type {
  Kojo2ProjectProblem,
  Kojo2ProjectProblemChannel,
} from '../src/ui/kojo2-project-service-contract';

function problem(overrides: Partial<Kojo2ProjectProblem> = {}): Kojo2ProjectProblem {
  return {
    channel: 'build',
    code: 'core/project/parse-failed',
    severity: 'error',
    message: '文件无法解析',
    path: null,
    line: null,
    column: null,
    fileId: null,
    canonicalId: null,
    functionName: null,
    candidateTheaterIds: [],
    ...overrides,
  };
}

const find = (items: readonly EditorProblem[], needle: string): EditorProblem | undefined =>
  items.find((item) => item.message.includes(needle));

afterEach(() => {
  // 全局注册表：清掉整项目扫描簇（本测试只写这一簇），不留跨用例幽灵诊断。
  clearProjectScan();
});

describe('toEditorProblems · 项目级落点与通道标签', () => {
  it('项目级条目落 kojo2:build、行 1、无 span，消息带通道标签', () => {
    const [editor] = toEditorProblems([problem({ channel: 'build', message: '构建失败' })]);
    expect(editor).toBeDefined();
    expect(editor?.path).toBe(KOJO2_BUILD_PROBLEM_PATH);
    expect(editor?.line).toBe(1);
    expect(editor?.span).toBeUndefined();
    expect(editor?.severity).toBe('error');
    expect(editor?.code).toBe('core/project/parse-failed');
    expect(editor?.source).toBe('Kojo 2.0');
    expect(editor?.message).toBe('[构建] 构建失败');
  });

  it('五个通道各有人话标签', () => {
    const channels: Kojo2ProjectProblemChannel[] = [
      'build',
      'dispatch',
      'dispatch-backend',
      'assembly',
      'runtime',
    ];
    const labels = toEditorProblems(
      channels.map((channel) => problem({ channel, message: `来自 ${channel}` })),
    ).map((editor) => editor.message.split(' ')[0]);
    expect(labels).toEqual(['[构建]', '[调度]', '[调度渲染]', '[组装]', '[运行时]']);
  });

  it('warning 严重级原样保留', () => {
    const [editor] = toEditorProblems([problem({ severity: 'warning', message: 'legacy 跳过' })]);
    expect(editor?.severity).toBe('warning');
  });
});

describe('toEditorProblems · 带文件路径的条目', () => {
  it('保留真实 path，消息里带 shortPath:line；column → 零宽 span', () => {
    const [editor] = toEditorProblems([
      problem({
        channel: 'dispatch',
        message: '同特异性歧义',
        path: 'D:/game/口上/灵梦/01-初见.kojo2',
        line: 7,
        column: 3,
        code: 'dispatch/ambiguous-branches',
      }),
    ]);
    expect(editor?.path).toBe('D:/game/口上/灵梦/01-初见.kojo2');
    expect(editor?.line).toBe(7);
    expect(editor?.span).toEqual({ columnStart: 3, columnEnd: 4 });
    expect(editor?.message).toContain('01-初见.kojo2:7');
    expect(editor?.message.startsWith('[调度] ')).toBe(true);
    expect(editor?.code).toBe('dispatch/ambiguous-branches');
  });

  it('column 缺失 → 只有行级信息（span 缺席，不编造列）', () => {
    const [editor] = toEditorProblems([
      problem({
        channel: 'assembly',
        path: 'D:/game/口上/灵梦/01-初见.kojo2',
        line: 12,
        column: null,
        message: 'legacy 缺文件',
      }),
    ]);
    expect(editor?.span).toBeUndefined();
    expect(editor?.line).toBe(12);
  });

  it('line 缺失但 path 有值 → 行兜底 1，仍保留真实路径', () => {
    const [editor] = toEditorProblems([
      problem({ path: 'D:/game/口上/a.kojo2', line: null, message: '无行号' }),
    ]);
    expect(editor?.path).toBe('D:/game/口上/a.kojo2');
    expect(editor?.line).toBe(1);
  });
});

describe('publish / clear · 问题面板账本', () => {
  it('publish 后 snapshot 查得到（项目级按 bucket 分组、文件条目按自己的 path 分组）', () => {
    publishKojo2ProjectProblems([
      problem({ channel: 'build', message: '项目级错误' }),
      problem({
        channel: 'dispatch',
        path: 'D:/game/口上/a.kojo2',
        line: 4,
        message: '文件级错误',
      }),
    ]);
    const items = snapshot();
    expect(items).toHaveLength(2);
    expect(find(items, '项目级错误')?.path).toBe(KOJO2_BUILD_PROBLEM_PATH);
    expect(find(items, '文件级错误')?.path).toBe('D:/game/口上/a.kojo2');
  });

  it('整份替换语义：第二次 publish 空数组即销账（不留幽灵组）', () => {
    publishKojo2ProjectProblems([problem({ message: '第一条' })]);
    expect(snapshot()).toHaveLength(1);
    publishKojo2ProjectProblems([]);
    expect(snapshot()).toHaveLength(0);
  });

  it('与 kojo2:project 那一簇互不覆盖；clear 只清本 bucket', () => {
    const other: EditorProblem = {
      path: 'kojo2:project',
      line: 1,
      severity: 'warning',
      message: '存储期问题（另一簇）',
    };
    setProjectScanProblems('kojo2:project', [other]);
    publishKojo2ProjectProblems([problem({ message: '构建问题' })]);
    expect(snapshot()).toHaveLength(2);

    clearKojo2ProjectProblems();
    const left = snapshot();
    expect(left).toHaveLength(1);
    expect(left[0]?.message).toBe('存储期问题（另一簇）');
    expect(left[0]?.path).toBe('kojo2:project');
  });
});
