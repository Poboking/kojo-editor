/**
 * 调试会话「按工作树隔离」键的判据（2026-10-25 多 agent 并发反馈，PITFALLS 192）。
 *
 * 本机多 agent 并发时曾发生：A 树 `serve`，B 树 `status` 静默连到 A 的会话——
 * 「本树实测」量的是别人的代码。键的构造必须钉死三态：同树同键（共享）、
 * 跨树异键（互不可见）、显式命名覆盖（人工对齐 / 同树第二会话）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir, sessionKey } from '../debug-lib.mjs';

const TREE_A = 'D:\\DSH\\kojo-editor-用户反馈组';
const TREE_B = 'D:\\DSH\\kojo-editor-core';
const TREE_A_ALT_CASE = 'd:\\dsh\\KOJO-EDITOR-用户反馈组'; // Windows 大小写变体＝同一棵树

describe('调试会话 · 按工作树隔离的键', () => {
  afterEach(() => {
    delete process.env.KOJO_DEBUG_SESSION_NAME;
    delete process.env.KOJO_DEBUG_HOME;
  });

  it('同树（含大小写变体）⇒ 同键；跨树 ⇒ 异键', () => {
    expect(sessionKey(TREE_A)).toBe(sessionKey(TREE_A));
    expect(sessionKey(TREE_A)).toBe(sessionKey(TREE_A_ALT_CASE));
    expect(sessionKey(TREE_A)).not.toBe(sessionKey(TREE_B));
  });

  it('会话目录落在家目录的 sessions/<键>/ 下（结构隔离：session.json/沙盒/profile 全在房间里）', () => {
    process.env.KOJO_DEBUG_HOME = 'D:/tmp/kd';
    const dir = sessionDir(TREE_A).replaceAll('\\', '/');
    expect(dir.startsWith('D:/tmp/kd/sessions/')).toBe(true);
    expect(dir.endsWith(sessionKey(TREE_A))).toBe(true);
    expect(sessionDir(TREE_B)).not.toBe(sessionDir(TREE_A));
  });

  it('KOJO_DEBUG_SESSION_NAME 显式命名覆盖（同树第二会话 / 跨工具对齐）；非法字符折成连字符', () => {
    process.env.KOJO_DEBUG_SESSION_NAME = 'ui-audit';
    expect(sessionKey(TREE_A)).toBe('ui-audit');
    expect(sessionKey(TREE_B)).toBe('ui-audit'); // 显式命名是「加同一个房间」，跨树也同键
    process.env.KOJO_DEBUG_SESSION_NAME = 'a b/中文!..';
    expect(sessionKey(TREE_A)).toMatch(/^[\w.-]+$/);
  });
});
