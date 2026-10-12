import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { affectsKojoTree, createEventCoalescer, decideExternalChange, matchOpenedPath } from '../src/ui/external-change';

/**
 * 外部写盘后的 model 重载决策单测（2026-10-12 审阅补丁，修 B1）。
 *
 * 该决策是「💡 升糖写盘后不丢数据」的关键分支：判错任一条都会造成**静默数据
 * 丢失**（要么丢用户的未保存修改，要么被随后的 Ctrl+S 用旧文本覆盖磁盘）。
 */
describe('decideExternalChange —— 外部写盘后的重载决策', () => {
  it('磁盘与 model 相同（自身保存回声）→ noop（不重置撤销栈/光标）', () => {
    expect(decideExternalChange('同一份内容', '同一份内容', false)).toBe('noop');
    expect(decideExternalChange('同一份内容', '同一份内容', true)).toBe('noop');
  });

  it('磁盘变了、model 干净 → reload（可安全用磁盘内容替换）', () => {
    expect(decideExternalChange('旧内容', '升糖后的新内容', false)).toBe('reload');
  });

  it('磁盘变了、model 脏 → conflict（绝不静默覆盖用户的未保存修改）', () => {
    expect(decideExternalChange('含未保存修改', '升糖后的新内容', true)).toBe('conflict');
  });

  it('状态与内容无关：脏判定只看是否相对基线有改动', () => {
    // 同为「磁盘 != model」，dirty 决定走向：干净=重载，脏=交给用户
    expect(decideExternalChange('a', 'b', false)).toBe('reload');
    expect(decideExternalChange('a', 'b', true)).toBe('conflict');
  });

  it('空文本也算内容：空 model 对非空磁盘 → 非 noop', () => {
    expect(decideExternalChange('', '', false)).toBe('noop');
    expect(decideExternalChange('', 'x', false)).toBe('reload');
    expect(decideExternalChange('x', '', true)).toBe('conflict');
  });
});

const KOJO_ROOT = 'C:/Game/eratw/ERB/口上・メッセージ関連/個人口上';

describe('affectsKojoTree —— 文件树该不该为这次外部改动重列（HK-5）', () => {
  it('口上域内的改动 → 是（含角色目录更深一层）', () => {
    expect(affectsKojoTree(`${KOJO_ROOT}/001 博丽灵梦/我的包/事件.ERB`, [KOJO_ROOT])).toBe(true);
  });

  it('口上域外的改动 → 否（监视根是整个项目，存档与图片缓存同一条总线上）', () => {
    expect(affectsKojoTree('C:/Game/eratw/sav/save00.dat', [KOJO_ROOT])).toBe(false);
    expect(affectsKojoTree('C:/Game/eratw/EX/图片.png', [KOJO_ROOT])).toBe(false);
  });

  it('前缀长得像但不是子目录 → 否（不能拿字符串前缀当路径判据）', () => {
    expect(affectsKojoTree(`${KOJO_ROOT}备份/001 博丽灵梦/x.ERB`, [KOJO_ROOT])).toBe(false);
  });

  it('根目录本身也算（改动直接落在口上域根上）', () => {
    expect(affectsKojoTree(KOJO_ROOT, [KOJO_ROOT])).toBe(true);
  });

  it('Windows 实况：反斜杠与大小写都归一，判据不因此漏刷', () => {
    const winRoot = 'C:\\Game\\eratw\\ERB\\口上・メッセージ関連\\個人口上';
    expect(affectsKojoTree('C:/game/ERATW/erb/口上・メッセージ関連/個人口上/001 灵梦/a.ERB', [winRoot])).toBe(true);
  });

  it('kojoPaths 为空（非口上项目）→ 一律不刷，不拿整棵项目树乱重列', () => {
    expect(affectsKojoTree(`${KOJO_ROOT}/a.ERB`, [])).toBe(false);
  });
});

describe('createEventCoalescer —— 外部改动合批（HK-5）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('一条事件 → 窗口到点重列一次', () => {
    const fired: number[] = [];
    const c = createEventCoalescer(() => fired.push(1), 400);
    c.push();
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(fired).toHaveLength(1);
    c.dispose();
  });

  it('窗口内十条也只重列一次（一次原子写就有临时文件 + rename 两条）', () => {
    const fired: number[] = [];
    const c = createEventCoalescer(() => fired.push(1), 400);
    for (let i = 0; i < 10; i++) c.push();
    vi.advanceTimersByTime(400);
    expect(fired).toHaveLength(1);
    c.dispose();
  });

  it('后续事件**不重置**窗口：持续写入也必须落地（§5.84 的饿死坑）', () => {
    const fired: number[] = [];
    const c = createEventCoalescer(() => fired.push(1), 400);
    c.push(); // 首条起算
    vi.advanceTimersByTime(200);
    c.push(); // 若这里重置窗口，400ms 后仍不到期 ⇒ 永远不刷
    vi.advanceTimersByTime(200);
    expect(fired).toHaveLength(1);
    c.dispose();
  });

  it('落地之后可以再来一轮（第二波外部改动不该被吞）', () => {
    const fired: number[] = [];
    const c = createEventCoalescer(() => fired.push(1), 400);
    c.push();
    vi.advanceTimersByTime(400);
    c.push();
    vi.advanceTimersByTime(400);
    expect(fired).toHaveLength(2);
    c.dispose();
  });

  it('dispose 清掉未决窗口（卸载后不再 setState，也不留活句柄）', () => {
    const fired: number[] = [];
    const c = createEventCoalescer(() => fired.push(1), 400);
    c.push();
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([]);
  });
});

describe('matchOpenedPath —— 外部改动该不该认成"这个文件正打开着"（HK-7）', () => {
  it('形态一致自然认得；宿主用的那个键原样带回（消息里要显示作者认识的那条路径）', () => {
    const keys = ['C:/game/ERB/口上/001 灵梦/M_KOJO_K1.ERB'];
    expect(matchOpenedPath(keys, keys[0]!)).toBe(keys[0]);
  });

  it('Windows 实况：事件里是反斜杠、宿主键是正斜杠（或反之）仍认得同一个文件', () => {
    const hostKey = 'C:/game/ERB/口上/001 灵梦/M_KOJO_K1.ERB';
    const eventPath = 'C:\\game\\ERB\\口上\\001 灵梦\\M_KOJO_K1.ERB';
    expect(matchOpenedPath([hostKey], eventPath)).toBe(hostKey);
    expect(matchOpenedPath([eventPath], hostKey)).toBe(eventPath);
  });

  it('大小写不同也认得（盘上同一路径的两种写法）', () => {
    expect(matchOpenedPath(['C:/Game/ERB/口上/A.ERB'], 'c:/game/erb/口上/a.ERB')).toBe('C:/Game/ERB/口上/A.ERB');
  });

  it('没打开过的文件 → null（与编辑器无关，不该弹任何东西）', () => {
    expect(matchOpenedPath(['C:/game/a.ERB'], 'C:/game/b.ERB')).toBeNull();
    expect(matchOpenedPath([] as string[], 'C:/game/a.ERB')).toBeNull();
  });

  it('名字像但不是同一个文件 → null（判等是整段路径相等，不是前缀）', () => {
    const keys = ['C:/game/口上A.ERB', 'C:/game/口上/子/深.ERB'];
    expect(matchOpenedPath(keys, 'C:/game/口上A.ERB.bak')).toBeNull();
    expect(matchOpenedPath(keys, 'C:/game/口上')).toBeNull();
    expect(matchOpenedPath(keys, 'C:/game/口上/子.ERB')).toBeNull();
  });
});