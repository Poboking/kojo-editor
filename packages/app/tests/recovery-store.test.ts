/**
 * 崩溃恢复中转站 · 消费时机守门（2026-10 "app ate my work" 批）。
 *
 * 竞态本体在 EditorPane 切换 effect + model 池（见 `editor-model-pool-recovery-race.test.ts`），
 * 但它依赖的中转站原语必须先在这里钉死：**peek 不消费、drop 是唯一消费点、
 * setRecoveredContents 覆盖式全量重写**。这三条塌一条，"切换快了就丢恢复内容"就会复发。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecoveredContents,
  dropRecoveredContent,
  peekRecoveredContent,
  recoveredPaths,
  setRecoveredContents,
  takeRecoveredContent,
} from '../src/ui/recovery-store';

describe('recovery-store · peek/drop 消费时机', () => {
  beforeEach(() => {
    clearRecoveredContents();
  });

  it('peek 重复读不消费：cancelled 重跑仍领得到快照（修复成立的前提）', () => {
    setRecoveredContents([{ path: 'a.erb', text: 'draft', encoding: 'utf-8', eol: 'LF' }]);
    expect(peekRecoveredContent('a.erb')).toEqual({ text: 'draft', encoding: 'utf-8', eol: 'LF' });
    expect(peekRecoveredContent('a.erb')?.text).toBe('draft'); // 第二次 peek 仍在——不消费
    expect(recoveredPaths()).toEqual(['a.erb']);
  });

  it('drop 精确消费一次；对不存在路径 drop 不抛', () => {
    setRecoveredContents([{ path: 'a.erb', text: 'x', encoding: 'utf-8', eol: 'CRLF' }]);
    dropRecoveredContent('a.erb');
    expect(peekRecoveredContent('a.erb')).toBeNull();
    expect(() => dropRecoveredContent('a.erb')).not.toThrow();
    expect(recoveredPaths()).toEqual([]);
  });

  it('setRecoveredContents 覆盖式：旧残留不混进新批次', () => {
    setRecoveredContents([{ path: 'a.erb', text: 'x', encoding: 'utf-8', eol: 'LF' }]);
    setRecoveredContents([{ path: 'b.erb', text: 'y', encoding: 'utf-16le', eol: 'CRLF' }]);
    expect(recoveredPaths()).toEqual(['b.erb']);
    expect(peekRecoveredContent('a.erb')).toBeNull();
  });

  it('take 保持"取即删"旧语义（旧调用方零改动；新注入方必须走 peek/drop）', () => {
    setRecoveredContents([{ path: 'a.erb', text: 'z', encoding: 'utf-8', eol: 'LF' }]);
    expect(takeRecoveredContent('a.erb')?.text).toBe('z');
    expect(peekRecoveredContent('a.erb')).toBeNull();
    expect(takeRecoveredContent('a.erb')).toBeNull();
  });
});
