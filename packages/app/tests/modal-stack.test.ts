import { afterEach, describe, expect, it } from 'vitest';
import { closeTopModal, modalDepth, pushModal } from '../src/ui/modal-stack';

/**
 * 宿主模态栈（HK-2，2026-10-13）。
 *
 * 验的是"Esc 退一层"这个直觉能不能兑现：五家对话框此前**都没有 Esc**，
 * 而若各家自己监听键盘，叠着开时一次 Esc 会同时关掉所有层。
 *
 * 注：`useModalEscape` 这个钩子本身不在这里测——它只有四行（ref 取最新 handler +
 * 挂载入栈 / 卸载出栈），而 `renderToString` 不跑 effect、本仓也没有 DOM 测试环境。
 * 真正需要钉的次序语义全在下面这几条里。
 */

afterEach(() => {
  // 栈是模块级单例：每条用例结束时必须是空的，否则上一条的残留会伪装成下一条的通过。
  // （这里只断言、不"帮忙清空"——closer 不会自己出栈，硬清会写成死循环。）
  expect(modalDepth()).toBe(0);
});

describe('modal-stack', () => {
  it('空栈不消费 Esc（该把按键交回给下一层：向导 / 设置 / 写作模式）', () => {
    expect(modalDepth()).toBe(0);
    expect(closeTopModal()).toBe(false);
  });

  it('一层时调用它的 closer，并报告已消费', () => {
    let closed = 0;
    const un = pushModal(() => {
      closed += 1;
    });
    expect(closeTopModal()).toBe(true);
    expect(closed).toBe(1);
    un();
  });

  it('叠两层时一次 Esc **只关最上面那一个**（LIFO，不是一锅端）', () => {
    const order: string[] = [];
    const unBottom = pushModal(() => order.push('bottom'));
    const unTop = pushModal(() => order.push('top'));

    closeTopModal();
    expect(order).toEqual(['top']);
    // closer 不负责出栈——生产里是"决定 → 父组件 setState → 该模态卸载 → effect 清理出栈"，
    // 这里显式注销就是在扮演那一步卸载（不这么做，第二次 Esc 还会打到同一层）。
    unTop();

    closeTopModal();
    expect(order).toEqual(['top', 'bottom']);
    unBottom();
    expect(closeTopModal()).toBe(false); // 两层都关完了，第三次 Esc 不该再消费
  });

  it('closer 自己不出栈（关不关由组件卸载决定）；注销后栈如实回退一层', () => {
    const seen: number[] = [];
    const un1 = pushModal(() => seen.push(1));
    const un2 = pushModal(() => seen.push(2));
    expect(modalDepth()).toBe(2);
    closeTopModal();
    expect(modalDepth()).toBe(2); // 还没卸载，栈深不变
    un2();
    expect(modalDepth()).toBe(1);
    closeTopModal();
    expect(seen).toEqual([2, 1]);
    un1();
  });

  it('注销幂等：React 严格模式下 effect 跑两遍，不会把别人的格子删掉', () => {
    const seen: string[] = [];
    const unA = pushModal(() => seen.push('A'));
    const unB = pushModal(() => seen.push('B'));
    unB();
    unB(); // 第二次注销不该动到 A
    expect(modalDepth()).toBe(1);
    closeTopModal();
    expect(seen).toEqual(['A']);
    unA();
  });

  it('中间那层单独注销（父组件条件渲染掉了它）后，栈序仍正确', () => {
    const seen: string[] = [];
    const unA = pushModal(() => seen.push('A'));
    const unB = pushModal(() => seen.push('B'));
    const unC = pushModal(() => seen.push('C'));
    unB();
    closeTopModal(); // C
    unC();
    closeTopModal(); // A（B 已经不在了，不该被跳过成别的）
    unA();
    expect(seen).toEqual(['C', 'A']);
    expect(closeTopModal()).toBe(false);
  });
});
