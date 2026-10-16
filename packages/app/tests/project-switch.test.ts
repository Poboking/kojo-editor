import { describe, expect, it } from 'vitest';
import {
  planProjectSwitch,
  resolveProjectSwitch,
  type ProjectSwitchDecision,
} from '../src/ui/project-switch';

/**
 * 切项目脏确认决策核心的判据（SAFE-1，2026-10-16）。
 *
 * 三条入口（recent 点击 / chooseAndOpen / 拖入新目录）收口到 openProject 换根守卫，
 * 守卫放行/拦截与确认三选一的分流表全部钉死在纯函数上；App 只做接线。
 * 路径判等走 pathKey（Windows 大小写/分隔符折叠），与全仓口径同尺。
 */

const DIRTY = new Set(['D:/旧项目/scene/1.erb']);

describe('planProjectSwitch（换根守卫）', () => {
  it('欢迎页首开（无项目在开）→ 放行：没有会被丢弃的旧项目', () => {
    expect(planProjectSwitch(null, 'D:/新项目', DIRTY)).toEqual({ kind: 'go' });
    expect(planProjectSwitch(null, 'D:/新项目', new Set())).toEqual({ kind: 'go' });
  });

  it('同根重开 → 放行：pathKey 折叠大小写与分隔符后判等', () => {
    expect(planProjectSwitch('D:/旧项目', 'D:\\旧项目', DIRTY)).toEqual({ kind: 'go' });
    expect(planProjectSwitch('D:/旧项目', 'D:/旧项目', DIRTY)).toEqual({ kind: 'go' });
    expect(planProjectSwitch('D:/旧项目', 'd:/旧项目', DIRTY)).toEqual({ kind: 'go' });
    expect(planProjectSwitch('D:/旧项目', 'D:/新项目', DIRTY)).toEqual({ kind: 'confirm', paths: DIRTY });
  });

  it('换根 + 无脏 → 放行（原行为不变）', () => {
    expect(planProjectSwitch('D:/旧项目', 'D:/新项目', new Set())).toEqual({ kind: 'go' });
  });

  it('换根 + 有脏 → 弹确认，脏集合原样带出（App 直接喂确认框）', () => {
    expect(planProjectSwitch('D:/旧项目', 'D:/新项目', DIRTY)).toEqual({ kind: 'confirm', paths: DIRTY });
  });

  it('keepView 重载与已确认续跑 → 放行（守卫不二次弹框）', () => {
    expect(planProjectSwitch('D:/旧项目', 'D:/旧项目', DIRTY, { keepView: true })).toEqual({ kind: 'go' });
    expect(planProjectSwitch('D:/旧项目', 'D:/新项目', DIRTY, { skipDirtyConfirm: true })).toEqual({ kind: 'go' });
  });
});

describe('resolveProjectSwitch（确认三选一）', () => {
  it('取消 = 留在原地（HK-2：Esc 落在"什么都没发生"那一格）', () => {
    expect(resolveProjectSwitch('cancel', false)).toEqual({ kind: 'stay' });
    expect(resolveProjectSwitch('cancel', true)).toEqual({ kind: 'stay' });
  });

  it('保存失败 = 留在原地（错误已显式呈现，绝不静默丢）', () => {
    expect(resolveProjectSwitch('save-then-go', false)).toEqual({ kind: 'stay' });
  });

  it('保存成功 / 明确丢弃 = 继续开目标根（journal 由调用方先走强制 discard 通道）', () => {
    expect(resolveProjectSwitch('save-then-go', true)).toEqual({ kind: 'proceed' });
    expect(resolveProjectSwitch('discard', true)).toEqual({ kind: 'proceed' });
  });

  it('分流表全谱：除 proceed 两格与 stay 三格外无第五种结果', () => {
    const table: Array<[ProjectSwitchDecision, boolean, string]> = [
      ['cancel', false, 'stay'],
      ['cancel', true, 'stay'],
      ['save-then-go', false, 'stay'],
      ['save-then-go', true, 'proceed'],
      ['discard', false, 'proceed'],
      ['discard', true, 'proceed'],
    ];
    for (const [decision, saveOk, kind] of table) {
      expect(resolveProjectSwitch(decision, saveOk)).toEqual({ kind });
    }
  });
});
