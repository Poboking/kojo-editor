import { describe, expect, it } from 'vitest';
import { MAX_NOTICES, pushNotice, type NoticeItem } from '../src/ui/notice-queue';

/**
 * 通知淘汰规则单测（看板 HK-8 裁决批，2026-10-13）。
 *
 * 钉的是这一条：`kind:'error'` 没有 TTL，但它会被**同屏上限**挤掉——
 * §5.96 实机看到"常驻警告没了、作者随后按保存覆盖磁盘"，元凶就是这个不分 kind 丢最旧。
 * 规则改成先丢 info，于是"脏缓冲区撞上外部改动"那条要命的提示不会再被无关通知冲走。
 */

type N = NoticeItem & { tag: string };
const info = (tag: string): N => ({ kind: 'info', tag });
const err = (tag: string): N => ({ kind: 'error', tag });
const tags = (l: readonly N[]) => l.map((x) => x.tag);

describe('pushNotice', () => {
  it('没超限：原样追加，不动任何一条', () => {
    const out = pushNotice([info('a'), err('b')], info('c'));
    expect(tags(out)).toEqual(['a', 'b', 'c']);
  });

  it('溢出时先丢最旧的 info，一条 error 都不许少', () => {
    const list = [info('i1'), err('e1'), info('i2'), err('e2'), info('i3')] as N[];
    expect(list.length).toBe(MAX_NOTICES);
    const out = pushNotice(list, info('i4'));
    expect(out.length).toBe(MAX_NOTICES);
    expect(out.some((n) => n.kind === 'error')).toBe(true);
    expect(tags(out)).toEqual(['e1', 'i2', 'e2', 'i3', 'i4']);
  });

  it('★ 真实场景：那条"保存会覆盖磁盘内容"的 error，扛得住后续十条 info 刷屏', () => {
    let list = pushNotice([] as N[], err('脏缓冲区冲突'));
    for (let i = 0; i < 10; i++) list = pushNotice(list, info('无关' + i));
    expect(list.length).toBe(MAX_NOTICES);
    expect(list.filter((n) => n.kind === 'error').map((n) => n.tag)).toEqual(['脏缓冲区冲突']);
  });

  it('全是 error 又溢出：丢最旧那条 error，保证队列有界（循环报错不能堆无限）', () => {
    let list = [err('e1'), err('e2'), err('e3'), err('e4'), err('e5')] as N[];
    list = pushNotice(list, err('e6'));
    expect(list.length).toBe(MAX_NOTICES);
    expect(tags(list)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6']);
  });

  it('上限可注入（渲染层以外想要更宽就自己传，规则本身不变）', () => {
    // 前置条件与 NotificationCenter 一致：传入的队列本来就 ≤ max，所以每次只腾一个位
    const out = pushNotice([info('a'), err('b')], info('c'), 2);
    expect(out.length).toBe(2);
    expect(tags(out)).toEqual(['b', 'c']);
  });

  it('不改动传入的旧数组（React state 依赖引用不变性）', () => {
    const list = [info('a')] as N[];
    pushNotice(list, err('b'));
    expect(list).toEqual([info('a')]);
  });
});
