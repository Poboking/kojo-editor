import { describe, expect, it } from 'vitest';
import { createCascadeWatermarks } from '../src/cascade-watermarks';

/** 假时钟 + 记录表：不依赖 performance.now，也不依赖探针本体 */
function harness() {
  let t = 0;
  const log: { name: string; ms: number }[] = [];
  const w = createCascadeWatermarks(
    (name, ms) => log.push({ name, ms }),
    () => t,
  );
  return { at: (ms: number) => (t = ms), log, w };
}

describe('cascade 水位计时', () => {
  it('起点之前不该记账（启动期插件自己的首次运行不是"用户等了多久"）', () => {
    const h = harness();
    h.at(500);
    h.w.mark('index', 'cascade.projectOpened→index可用');
    h.w.mark('conditions', 'cascade.projectOpened→条件可用');
    expect(h.log).toEqual([]);
  });

  it('三个水位都相对同一个 project.opened 起点', () => {
    const h = harness();
    h.at(1000);
    h.w.projectOpened();
    h.at(1623);
    h.w.mark('index', 'index可用');
    h.at(2175);
    h.w.mark('conditions', '条件可用');
    h.at(2178);
    h.w.mark('lint', '校验有结果');
    expect(h.log).toEqual([
      { name: 'index可用', ms: 623 },
      { name: '条件可用', ms: 1175 },
      { name: '校验有结果', ms: 1178 },
    ]);
  });

  it('同一段每轮只记首次达成（快照覆盖写、规则重跑不该再计入）', () => {
    const h = harness();
    h.at(0);
    h.w.projectOpened();
    h.at(100);
    h.w.mark('index', 'index可用');
    h.at(9000);
    h.w.mark('index', 'index可用'); // 后续 kojo.functionChanged（例如增量重扫）再来一次
    expect(h.log).toEqual([{ name: 'index可用', ms: 100 }]);
  });

  it('新一轮 projectOpened 重置资格并重算起点（交替开项目可逐次对比冷热）', () => {
    const h = harness();
    h.at(0);
    h.w.projectOpened();
    h.at(2300);
    h.w.mark('index', 'index可用');

    h.at(10000);
    h.w.projectOpened(); // 第二次打开（走快照）
    h.at(10620);
    h.w.mark('index', 'index可用');
    h.at(11180);
    h.w.mark('conditions', '条件可用');

    expect(h.log).toEqual([
      { name: 'index可用', ms: 2300 },
      { name: 'index可用', ms: 620 },
      { name: '条件可用', ms: 1180 },
    ]);
  });

  it('各段彼此独立：某段永远没达成不影响其它段记录', () => {
    const h = harness();
    h.at(0);
    h.w.projectOpened();
    h.at(50);
    h.w.mark('index', 'index可用');
    h.at(60);
    h.w.mark('lint', '校验有结果');
    expect(h.log.map((l) => l.name)).toEqual(['index可用', '校验有结果']);
  });
});
