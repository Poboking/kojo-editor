/**
 * Kojo 2.0 · model 语言重挂的判据闸（K2-CUTOVER-THEME）。
 *
 * 钉六件事：
 * 1. **判据单源**：`languageIdForKojo2Model` 就是建 model 与重挂共用的那一枚函数
 *    （flag 关 ⇒ 恒 `languageFor`，此时 `.kojo2` 的语言面照常是 `kojo2`；
 *    flag 开 ⇒ 路由；`blocked` ⇒ `plaintext`）；
 * 2. **幂等**：目标语言与 `getLanguageId()` 相同 ⇒ 一次 `setModelLanguage` 都不调，
 *    `stats.skipped` 如实记账；
 * 3. **防抖**：窗口内多次正文变化合并成一次重判（注入假调度器，不碰真时钟）；
 * 4. **翻转**：`.kojo` 在 `2.0-default` 下正文从 v1 写法规改成 2.0 写法（及反向）都重挂；
 * 5. **改扩展名**：`retarget` 立即重判，不等防抖；路径读回来是新路径；
 * 6. **flag 关零动作**：不订阅、不排定时器、不碰 model；运行中关掉同样零动作。
 *
 * 另有：同 model 重复 attach 不重复订阅、`onWillDispose` 自动解绑、失败不静默（只吵一次）、
 * `refreshAll` / `dispose` 的收尾语义。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang';
import { languageFor } from '../src/ui/editor-model-pool';
import { getKojo2CutoverController, resetKojo2CutoverController } from '../src/ui/kojo2-cutover';
import { isKojo2CutoverEnabled } from '../src/ui/kojo2-flag';
import {
  KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS,
  createKojo2ModelLanguageController,
  languageIdForKojo2Model,
  type Kojo2LanguageModelLike,
  type Kojo2ModelLanguageAttachOptions,
  type Kojo2ModelLanguageController,
  type Kojo2ModelLanguageDeps,
  type Kojo2ModelLanguageHandle,
} from '../src/ui/kojo2-model-language';

/* ============================== 假 model ============================== */

class FakeModel implements Kojo2LanguageModelLike {
  value: string;
  languageId: string;
  disposed = false;
  readonly contentListeners = new Set<() => void>();
  readonly disposeListeners = new Set<() => void>();

  constructor(value: string, languageId: string) {
    this.value = value;
    this.languageId = languageId;
  }

  getValue(): string {
    if (this.disposed) throw new Error('model disposed');
    return this.value;
  }

  getLanguageId(): string {
    return this.languageId;
  }

  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.contentListeners.add(listener);
    return { dispose: () => this.contentListeners.delete(listener) };
  }

  onWillDispose(listener: () => void): { dispose(): void } {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  /** 模拟一次正文变化（内容事件） */
  setText(next: string): void {
    this.value = next;
    for (const listener of [...this.contentListeners]) listener();
  }

  /** 模拟 Monaco 回收 model（先 onWillDispose，再置 disposed） */
  disposeModel(): void {
    for (const listener of [...this.disposeListeners]) listener();
    this.disposed = true;
  }
}

/* ============================== 假调度器 ============================== */

interface FakeScheduler {
  schedule: (run: () => void, delayMs: number) => () => void;
  runAll(): void;
  readonly size: () => number;
  readonly delays: number[];
}

function fakeScheduler(): FakeScheduler {
  let sequence = 0;
  const queue = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    schedule: (run, delayMs) => {
      const id = (sequence += 1);
      delays.push(delayMs);
      queue.set(id, run);
      return () => {
        queue.delete(id);
      };
    },
    runAll: () => {
      const jobs = [...queue.values()];
      queue.clear();
      for (const job of jobs) job();
    },
    size: () => queue.size,
    delays,
  };
}

/* ============================== 控制器 harness ============================== */

interface Harness {
  readonly controller: Kojo2ModelLanguageController;
  readonly schedule: FakeScheduler;
  readonly calls: { readonly model: FakeModel; readonly languageId: string }[];
  readonly warnings: string[];
  readonly attach: (
    model: FakeModel,
    path: string,
    options?: Kojo2ModelLanguageAttachOptions,
  ) => Kojo2ModelLanguageHandle;
}

interface HarnessOptions {
  readonly enabled?: () => boolean;
  readonly resolveLanguage?: (path: string, text: string) => string;
  readonly setModelLanguage?: Kojo2ModelLanguageDeps['setModelLanguage'];
  readonly debounceMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const schedule = fakeScheduler();
  const calls: Harness['calls'] = [];
  const warnings: string[] = [];
  const controller = createKojo2ModelLanguageController({
    isEnabled: options.enabled ?? (() => true),
    resolveLanguage: options.resolveLanguage ?? languageIdForKojo2Model,
    setModelLanguage:
      options.setModelLanguage ??
      ((model, languageId) => {
        calls.push({ model: model as FakeModel, languageId });
        (model as FakeModel).languageId = languageId;
      }),
    schedule: schedule.schedule,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    warn: (message) => warnings.push(message),
  });
  return {
    controller,
    schedule,
    calls,
    warnings,
    attach: (model, path, options) => controller.attach(model, path, options),
  };
}

/** 按正文判 v1 / 2.0（模拟 `2.0-default` 阶段的路由；不碰真指纹，专测重挂机制） */
function flavorResolver(_path: string, text: string): string {
  return text.includes('2.0') ? KOJO2_LANGUAGE_ID : 'kojo-sugar';
}

const KOJO_PATH = 'C:/作者工作区/事件.kojo';
const KOJO2_PATH = `C:/作者工作区/事件${KOJO2_SOURCE_EXTENSION}`;

afterEach(() => {
  vi.unstubAllGlobals();
  resetKojo2CutoverController();
});

/* ============================== flag 假体 ============================== */

interface FlagFake {
  readonly store: Map<string, string>;
  on(): void;
  off(): void;
}

function stubFlag(on: boolean): FlagFake {
  const store = new Map<string, string>();
  if (on) store.set('kojo.ui.kojo2Cutover.v1', 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
  return {
    store,
    on: () => store.set('kojo.ui.kojo2Cutover.v1', 'on'),
    off: () => store.delete('kojo.ui.kojo2Cutover.v1'),
  };
}

/* ============================== 判据单源 ============================== */

describe('languageIdForKojo2Model：建 model 与重挂共用的唯一判据', () => {
  it('flag 关 ⇒ 恒等于 languageFor；`.kojo2` 的语言面照常认出 2.0', () => {
    stubFlag(false);
    for (const path of [KOJO_PATH, KOJO2_PATH, 'C:/x/a.json', 'C:/x/readme.txt']) {
      expect(languageIdForKojo2Model(path, '# 机 指令 310\n灵梦：「你好。」')).toBe(languageFor(path));
    }
    // K2-SURFACE-DEFAULT：`.kojo2` 的 descriptor 无条件登记 ⇒ flag 关也是 kojo2（切流语义另管）
    expect(languageIdForKojo2Model(KOJO2_PATH, '> 旁白')).toBe(KOJO2_LANGUAGE_ID);
  });

  it('flag 开 + dual：`.kojo2` 挂 2.0，`.kojo` 仍按 v1（开关不许抢老扩展名）', () => {
    stubFlag(true);
    getKojo2CutoverController().setStage('dual');
    expect(languageIdForKojo2Model(KOJO2_PATH, '> 旁白')).toBe(KOJO2_LANGUAGE_ID);
    expect(languageIdForKojo2Model(KOJO_PATH, '#DIM X, 1')).toBe('kojo-sugar');
  });

  it('flag 开 + v1-only：`.kojo2` 落 plaintext（不打不开，也不塞给 v1 词法）', () => {
    stubFlag(true);
    expect(getKojo2CutoverController().getStage()).toBe('v1-only');
    expect(languageIdForKojo2Model(KOJO2_PATH, '> 旁白')).toBe('plaintext');
  });

  it('flag 开 + 2.0-default：`.kojo` 由正文指纹定解析器（同一路径两种结论）', () => {
    stubFlag(true);
    getKojo2CutoverController().setStage('2.0-default');
    expect(languageIdForKojo2Model(KOJO_PATH, '# 角色 灵梦\n> 她别过头。\n')).toBe(KOJO2_LANGUAGE_ID);
    expect(languageIdForKojo2Model(KOJO_PATH, '#DIM X, 1\n$X = 2\n')).toBe('kojo-sugar');
  });

  it('非 kojo 文件即使 flag 开也走 languageFor（路由不接管别人的文件）', () => {
    stubFlag(true);
    getKojo2CutoverController().setStage('dual');
    expect(languageIdForKojo2Model('C:/x/settings.json', '{}')).toBe(languageFor('C:/x/settings.json'));
    expect(languageIdForKojo2Model('C:/x/readme.txt', '2.0')).toBe('plaintext');
  });
});

/* ============================== attach / 幂等 / 防抖 ============================== */

describe('attach：flag 关零动作、flag 开只挂监听', () => {
  it('flag 关 ⇒ 不订阅、不排定时器、不碰 model；retarget / refresh 也零动作', () => {
    stubFlag(false);
    const fake = harness({ enabled: isKojo2CutoverEnabled });
    const model = new FakeModel('> 旁白', 'plaintext');
    const handle = fake.attach(model, KOJO2_PATH);
    expect(model.contentListeners.size).toBe(0);
    expect(fake.controller.stats().attached).toBe(0);

    model.setText('> 改了一句');
    handle.retarget(KOJO_PATH);
    handle.refresh();
    expect(fake.schedule.size()).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(fake.controller.stats().remounts).toBe(0);
  });

  it('attach 时语言已正确 ⇒ 零重挂（幂等），只记一次 skipped', () => {
    const fake = harness();
    const model = new FakeModel('#DIM X, 1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    expect(fake.calls).toEqual([]);
    expect(fake.controller.stats()).toMatchObject({ attached: 1, remounts: 0, skipped: 1, pending: 0 });
  });

  it('attach 时语言不对 ⇒ 立即纠正一次（建 model 判据与重挂判据同一枚）', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('> 2.0 旁白', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    expect(fake.calls).toEqual([{ model, languageId: KOJO2_LANGUAGE_ID }]);
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);
    expect(fake.controller.stats().remounts).toBe(1);
  });

  it('attach 带上建 model 时用过的语言（一致）⇒ 不再重扫正文，只记一次 skipped', () => {
    let resolves = 0;
    const fake = harness({
      resolveLanguage: () => {
        resolves += 1;
        return KOJO2_LANGUAGE_ID;
      },
    });
    const model = new FakeModel('大文件…', KOJO2_LANGUAGE_ID);
    fake.attach(model, KOJO_PATH, { languageId: KOJO2_LANGUAGE_ID });
    expect(resolves).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(fake.controller.stats()).toMatchObject({ attached: 1, skipped: 1, remounts: 0 });
  });

  it('attach 带上建 model 时的语言但不一致 ⇒ 仍立刻对齐一次（兜底别的调用方判错）', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('这行是 2.0', 'plaintext'); // model 实际不是声称的 v1
    fake.attach(model, KOJO_PATH, { languageId: 'kojo-sugar' });
    expect(fake.calls).toEqual([{ model, languageId: KOJO2_LANGUAGE_ID }]);
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);
  });

  it('同一 model 二次 attach ⇒ 同一手柄、不重复订阅（listener 仍只有一条）', () => {
    const fake = harness();
    const model = new FakeModel('#DIM X, 1', 'kojo-sugar');
    const first = fake.attach(model, KOJO_PATH);
    const second = fake.attach(model, KOJO_PATH);
    expect(second).toBe(first);
    expect(model.contentListeners.size).toBe(1);
    expect(fake.controller.stats().attached).toBe(1);
  });
});

describe('防抖：窗口内多次变化合并成一次重判', () => {
  it('默认窗口 = 300ms，注入的调度器收到同一个值', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    model.setText('改成 2.0');
    expect(fake.schedule.delays).toEqual([KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS]);
  });

  it('连续 3 次正文变化只排 1 个定时器，到点只重挂一次', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    model.setText('a');
    model.setText('b');
    model.setText('2.0');
    expect(fake.schedule.size()).toBe(1);
    expect(fake.controller.stats().pending).toBe(1);

    fake.schedule.runAll();
    expect(fake.calls).toEqual([{ model, languageId: KOJO2_LANGUAGE_ID }]);
    expect(fake.controller.stats()).toMatchObject({ pending: 0, remounts: 1 });
  });

  it('到点后语言没变 ⇒ 一次 setModelLanguage 都不调（同语言不重挂）', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('v1 一', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    model.setText('v1 二');
    fake.schedule.runAll();
    expect(fake.calls).toEqual([]);
    expect(fake.controller.stats().remounts).toBe(0);
    // attach 一次 + 到点一次 = 两次"判完不需要挂"
    expect(fake.controller.stats().skipped).toBe(2);
  });

  it('正文翻转 v1 → 2.0 → v1：两次都重挂，语言跟着正文走', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);

    model.setText('这行是 2.0');
    fake.schedule.runAll();
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);

    model.setText('又改回 v1');
    fake.schedule.runAll();
    expect(model.getLanguageId()).toBe('kojo-sugar');
    expect(fake.controller.stats().remounts).toBe(2);
  });

  it('flag 运行中被关掉 ⇒ 已排队的回调到点只做 no-op，不碰 model', () => {
    const flagOn = { value: true };
    const fake = harness({ enabled: () => flagOn.value });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);

    model.setText('2.0');
    expect(fake.schedule.size()).toBe(1);
    flagOn.value = false;
    fake.schedule.runAll();
    expect(fake.calls).toEqual([]);
    expect(model.getLanguageId()).toBe('kojo-sugar');
  });

  it('flag 运行中被关掉后新的内容变化 ⇒ 连定时器都不排', () => {
    const flagOn = { value: true };
    const fake = harness({ enabled: () => flagOn.value });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    flagOn.value = false;

    model.setText('2.0');
    expect(fake.schedule.size()).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});

describe('改路径 / 改扩展名：立即重判，不等防抖', () => {
  it('retarget 到 `.kojo2` ⇒ 立刻挂 2.0，路径读回新值，旧防抖被取消', () => {
    const fake = harness({
      resolveLanguage: (path, text) =>
        path.endsWith(KOJO2_SOURCE_EXTENSION) || text.includes('2.0')
          ? KOJO2_LANGUAGE_ID
          : 'kojo-sugar',
    });
    const model = new FakeModel('v1 内容', 'kojo-sugar');
    const handle = fake.attach(model, KOJO_PATH);
    expect(handle.path).toBe(KOJO_PATH);

    model.setText('随便改改'); // 先挂一个待执行的防抖
    expect(fake.schedule.size()).toBe(1);
    handle.retarget(KOJO2_PATH);
    expect(handle.path).toBe(KOJO2_PATH);
    expect(fake.schedule.size()).toBe(0); // 显式改路径：旧窗口作废
    expect(fake.calls).toEqual([{ model, languageId: KOJO2_LANGUAGE_ID }]);
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);
  });

  it('retarget 到同语言路径 ⇒ 只更新路径，不重挂（幂等）', () => {
    const fake = harness();
    const model = new FakeModel('v1', 'kojo-sugar');
    const handle = fake.attach(model, KOJO_PATH);
    handle.retarget('C:/作者工作区/另一个.kojo');
    expect(handle.path).toBe('C:/作者工作区/另一个.kojo');
    expect(fake.calls).toEqual([]);
    expect(fake.controller.stats().skipped).toBe(2);
  });

  it('refresh 立即重判：正文已翻转但防抖未到点也立刻重挂，然后取消排队', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('v1', 'kojo-sugar');
    const handle = fake.attach(model, KOJO_PATH);
    model.setText('2.0');
    expect(fake.schedule.size()).toBe(1);

    handle.refresh();
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);
    expect(fake.schedule.size()).toBe(0);
    expect(fake.calls.length).toBe(1);
  });

  it('controller.retarget(model, path)：不持手柄也能改路径；未挂载的 model 返回 false', () => {
    const fake = harness({
      resolveLanguage: (path) =>
        path.endsWith(KOJO2_SOURCE_EXTENSION) ? KOJO2_LANGUAGE_ID : 'kojo-sugar',
    });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    expect(fake.controller.retarget(model, KOJO2_PATH)).toBe(true);
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);

    const stranger = new FakeModel('v1', 'kojo-sugar');
    expect(fake.controller.retarget(stranger, KOJO2_PATH)).toBe(false);
    expect(stranger.getLanguageId()).toBe('kojo-sugar');
  });
});

describe('解绑与收尾：不拖住 model、不碰引用计数', () => {
  it('detach 取消排队回调；之后内容变化零动作', () => {
    const fake = harness({ resolveLanguage: flavorResolver });
    const model = new FakeModel('v1', 'kojo-sugar');
    const handle = fake.attach(model, KOJO_PATH);
    model.setText('2.0');
    expect(fake.schedule.size()).toBe(1);

    handle.detach();
    expect(fake.schedule.size()).toBe(0);
    expect(fake.controller.stats().attached).toBe(0);
    expect(model.contentListeners.size).toBe(0);

    model.setText('又一句 2.0');
    fake.schedule.runAll();
    expect(fake.calls).toEqual([]);
  });

  it('detach 可重复调用（不抛、不重复记账）', () => {
    const fake = harness();
    const model = new FakeModel('v1', 'kojo-sugar');
    const handle = fake.attach(model, KOJO_PATH);
    handle.detach();
    expect(() => handle.detach()).not.toThrow();
    expect(fake.controller.stats().attached).toBe(0);
  });

  it('model 被回收（onWillDispose）⇒ 自动解绑，不让本表拖住已销毁的 model', () => {
    const fake = harness();
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    expect(fake.controller.stats().attached).toBe(1);

    model.disposeModel();
    expect(fake.controller.stats().attached).toBe(0);
    expect(model.contentListeners.size).toBe(0);
  });

  it('dispose() 解绑全部；之后的 attach 返回 no-op 手柄（不订阅）', () => {
    const fake = harness();
    const a = new FakeModel('v1', 'kojo-sugar');
    const b = new FakeModel('v1', 'kojo-sugar');
    fake.attach(a, KOJO_PATH);
    fake.attach(b, KOJO_PATH);
    expect(fake.controller.stats().attached).toBe(2);

    fake.controller.dispose();
    expect(fake.controller.stats().attached).toBe(0);
    expect(a.contentListeners.size).toBe(0);

    const c = new FakeModel('v1', 'kojo-sugar');
    fake.attach(c, KOJO_PATH);
    expect(c.contentListeners.size).toBe(0);
    expect(fake.controller.stats().attached).toBe(0);
  });
});

describe('refreshAll：阶段 / override 变化后全部重判', () => {
  it('只重挂真正需要换语言的那一份（其余幂等跳过）', () => {
    let stage: 'v1-only' | 'dual' = 'v1-only';
    const fake = harness({
      resolveLanguage: (path, text) => {
        if (path.endsWith(KOJO2_SOURCE_EXTENSION)) {
          return stage === 'v1-only' ? 'plaintext' : KOJO2_LANGUAGE_ID;
        }
        return text.includes('2.0') ? KOJO2_LANGUAGE_ID : 'kojo-sugar';
      },
    });
    const v1Model = new FakeModel('v1', 'kojo-sugar');
    const blockedModel = new FakeModel('> 旁白', 'plaintext'); // v1-only 阶段建成的
    fake.attach(v1Model, KOJO_PATH);
    fake.attach(blockedModel, KOJO2_PATH);
    expect(fake.calls).toEqual([]); // attach 首判：两份都与各自路由一致

    stage = 'dual'; // 切到双轨：`.kojo2` 从 plaintext 挂回 2.0
    fake.controller.refreshAll();
    expect(fake.calls).toEqual([{ model: blockedModel, languageId: KOJO2_LANGUAGE_ID }]);
    expect(fake.controller.stats().remounts).toBe(1);
  });
});

describe('失败不静默：判据 / setModelLanguage 出错只吵一次', () => {
  it('判据抛错 ⇒ warn 一次、不调 setModelLanguage；连续两次也只吵一次', () => {
    let explode = true;
    const fake = harness({
      resolveLanguage: () => {
        if (explode) throw new Error('路由炸了');
        return KOJO2_LANGUAGE_ID;
      },
    });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    model.setText('再来一次');
    fake.schedule.runAll();
    expect(fake.calls).toEqual([]);
    expect(fake.warnings.length).toBe(1);
    expect(fake.warnings[0]).toContain('路由炸了');

    explode = false;
    model.setText('好了');
    fake.schedule.runAll();
    expect(model.getLanguageId()).toBe(KOJO2_LANGUAGE_ID);
    expect(fake.warnings.length).toBe(1);
  });

  it('setModelLanguage 抛错 ⇒ warn 一次、remounts 不涨、语言保持原样', () => {
    const fake = harness({
      resolveLanguage: () => KOJO2_LANGUAGE_ID,
      setModelLanguage: () => {
        throw new Error('monaco 拒绝');
      },
    });
    const model = new FakeModel('v1', 'kojo-sugar');
    fake.attach(model, KOJO_PATH);
    model.setText('2.0');
    fake.schedule.runAll();
    expect(model.getLanguageId()).toBe('kojo-sugar');
    expect(fake.controller.stats().remounts).toBe(0);
    expect(fake.warnings.length).toBe(1);
    expect(fake.warnings[0]).toContain('monaco 拒绝');
  });
});

describe('阅读型断言：默认防抖窗口是个正数', () => {
  it('KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS ∈ (0, 1000]（逐键重判太贵，停手一秒内必须落地）', () => {
    expect(KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(KOJO2_LANGUAGE_REMOUNT_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });
});
