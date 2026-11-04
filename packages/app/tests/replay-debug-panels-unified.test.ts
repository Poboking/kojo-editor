/**
 * 「口上调试」两个面板的统一判据（2026-11-04 UI 打磨批）。
 *
 * 为什么钉成静态串：这两件事都是**跨插件的形态约定**——面板之间不许 import，
 * 统一只能靠"同名的契约事件 + 同一套外壳类名"。运行期验收要"开项目 + 有存档 +
 * 两块面板都点一遍"，等于没有判据；而它们全部是源码里可数的几行，钉住就会红。
 *
 * 钉的是口径不是像素：
 *  ① 两面板互相给路（`ui.panel.reveal` 指向对方的贡献 id）——这是"割裂感"的直接来源；
 *  ② 同一套外壳类（`.dbg-head`）——两套皮肤是"粗糙"的直接来源；
 *  ③ 存档联动双向（回放既广播也跟随 `kojo.snapshotSelected`）；
 *  ④ 写盘视觉同族（注入面板的写入按钮走 `danger`，不是 `primary`）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REPLAY = 'packages/plugins/ui-state-replay/src/index.ts';
const INJECTOR = 'packages/plugins/ui-snapshot-injector/src/injector-panel.ts';
const PENDING = 'packages/plugins/ui-snapshot-injector/src/pending-box.ts';
const FRAME = 'packages/plugins/ui-snapshot-injector/src/panel-frame.ts';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('口上调试 · 两面板互相给路', () => {
  it('回放面板的跳转指向注入面板的贡献 id', () => {
    const src = read(REPLAY);
    expect(src).toContain("ctx.bus.emit('ui.panel.reveal', { id: 'snapshot-injector'");
  });

  it('注入面板的跳转指向回放面板的贡献 id', () => {
    const src = read(INJECTOR);
    expect(src).toContain("ctx.bus.emit('ui.panel.reveal', { id: 'state-replay'");
  });

  it('两面板标题成对（说动作，不说实现名）', () => {
    expect(read(REPLAY)).toContain("title: '看这段会怎样'");
    expect(read('packages/plugins/ui-snapshot-injector/src/index.ts')).toContain("title: '改这个状态'");
  });
});

describe('口上调试 · 同一套外壳', () => {
  it('两面板都有面板头（.dbg-head）', () => {
    expect(read(REPLAY)).toContain("'dbg-head'");
    expect(read(INJECTOR)).toContain("'dbg-head'");
  });

  it('注入面板的档位行用同一个字段标签类', () => {
    expect(read(FRAME)).toContain("'dbg-field-label'");
  });
});

describe('口上调试 · 存档联动', () => {
  it('回放面板既广播也跟随（同一份"当前档"）', () => {
    const src = read(REPLAY);
    expect(src).toContain("ctx.bus.on('kojo.snapshotSelected'");
    expect(src).toContain("ctx.bus.emit('kojo.snapshotSelected'");
  });

  it('注入面板在既有通道上跟随', () => {
    expect(read(INJECTOR)).toContain("ctx.bus.on('kojo.snapshotSelected'");
  });
});

describe('口上调试 · 写盘视觉同族', () => {
  it('注入面板的写入按钮是 danger（与回放面板的"写入存档"一致），不再是 primary', () => {
    const src = read(PENDING);
    expect(src).toContain("className: 'danger'");
    expect(src).not.toContain("className: 'primary'");
  });

  it('写入动作吸底（滚到哪儿都能看见"这一下会写盘"）', () => {
    expect(read(PENDING)).toContain('dbg-action-bar');
  });
});
