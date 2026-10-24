/**
 * LANG-OVERRIDE-MODEL · 糖投影 model 的语言覆盖跟随（批次十二）。
 *
 * 钉四件事（与池里源 model 的跟随同一条判据 `resolveModelLanguage`）：
 * 1. 同一路径多个组各一份糖 model（URI 按组隔离）**全部**重挂；
 * 2. 目标语言与现状相同 ⇒ 不调 `setModelLanguage`（幂等：重挂会重置 tokenization /
 *    折叠 / 装饰，白挂一次就是可见闪动）；
 * 3. 覆盖撤销后能重挂回 descriptor（糖投影的 descriptor = `KOJO_LANGUAGE_ID`）；
 * 4. 已 dispose 的投影 model 不碰（Effect 卸载 / 切文件后的悬空引用）。
 *
 * 本文件不加载真 Monaco：判据（偏好层）与重挂函数都是生产同一枚，模型给假件。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { retargetSugarModels, type SugarLanguageModelLike } from '../src/ui/editor-pane/pane-helpers';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  clearLanguageOverride,
  resolveModelLanguage,
  setLanguageOverride,
} from '../src/ui/language-mode-pref';

const SUGAR_PATH = 'C:\\kojo\\project\\口上\\事件.kojo';
/** 同一份文件的另一种写法（小写盘符 + 正斜杠）——偏好层按 `pathKey` 归一 */
const SUGAR_PATH_SLASH = 'c:/kojo/project/口上/事件.kojo';

/** 最小 localStorage 垫片（node 池没有 window；偏好模块的读取面就这一条） */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } as Storage;
}

interface FakeSugarModel extends SugarLanguageModelLike {
  languageId: string;
  disposed: boolean;
}

function fakeSugarModel(languageId: string): FakeSugarModel {
  const state: FakeSugarModel = {
    languageId,
    disposed: false,
    getLanguageId: () => state.languageId,
    isDisposed: () => state.disposed,
  };
  return state;
}

/** 生产接线同形的判据：糖投影的 descriptor 恒为 `KOJO_LANGUAGE_ID` */
function sugarLanguageOf(path: string): string {
  return resolveModelLanguage(path, KOJO_LANGUAGE_ID);
}

/** 生产接线同形的重挂：记录真正调过 `setModelLanguage` 的次数 */
function applySpy(): { calls: Array<{ model: FakeSugarModel; languageId: string }>; apply: (model: FakeSugarModel, languageId: string) => void } {
  const calls: Array<{ model: FakeSugarModel; languageId: string }> = [];
  return {
    calls,
    apply: (model, languageId) => {
      calls.push({ model, languageId });
      model.languageId = languageId;
    },
  };
}

beforeAll(() => {
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: memoryStorage() };
});

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  window.localStorage.clear();
});

describe('糖投影 model · 语言覆盖跟随', () => {
  it('① 同一路径多个组各一份 model ⇒ 全部重挂（覆盖写入另一种拼写也生效）', () => {
    setLanguageOverride(SUGAR_PATH_SLASH, 'json');
    const groupA = fakeSugarModel(KOJO_LANGUAGE_ID);
    const groupB = fakeSugarModel(KOJO_LANGUAGE_ID);
    const { calls, apply } = applySpy();

    expect(retargetSugarModels([groupA, groupB], () => sugarLanguageOf(SUGAR_PATH), apply)).toBe(2);
    expect(groupA.languageId).toBe('json');
    expect(groupB.languageId).toBe('json');
    expect(calls).toHaveLength(2);
  });

  it('② 同语言不调 setModelLanguage（幂等，返回 0）', () => {
    const model = fakeSugarModel(KOJO_LANGUAGE_ID);
    const { calls, apply } = applySpy();

    expect(retargetSugarModels([model], () => sugarLanguageOf(SUGAR_PATH), apply)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(model.languageId).toBe(KOJO_LANGUAGE_ID);
  });

  it('③ 覆盖 → 撤销，能重挂回 descriptor（来回都走同一枚判据）', () => {
    const model = fakeSugarModel(KOJO_LANGUAGE_ID);
    const { apply } = applySpy();

    setLanguageOverride(SUGAR_PATH, 'kojo2');
    expect(retargetSugarModels([model], () => sugarLanguageOf(SUGAR_PATH), apply)).toBe(1);
    expect(model.languageId).toBe('kojo2');

    clearLanguageOverride(SUGAR_PATH);
    expect(retargetSugarModels([model], () => sugarLanguageOf(SUGAR_PATH), apply)).toBe(1);
    expect(model.languageId).toBe(KOJO_LANGUAGE_ID);
  });

  it('④ 已 dispose 的投影 model 不碰（卸载后的悬空引用零动作）', () => {
    setLanguageOverride(SUGAR_PATH, 'json');
    const dead = fakeSugarModel(KOJO_LANGUAGE_ID);
    dead.disposed = true;
    const { calls, apply } = applySpy();

    expect(retargetSugarModels([dead], () => sugarLanguageOf(SUGAR_PATH), apply)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(dead.languageId).toBe(KOJO_LANGUAGE_ID);
  });
});
