/**
 * SPLIT-1 · model 池单测：引用计数（同文件多组共享一份 model，归零才 dispose）、
 * 并发 acquire 共享同一次读盘、失败不悬挂、基线随文件存续 / 随最后释放清理。
 * monaco 与内核 io 全部注入假件——纯逻辑闭环，不加载真 Monaco。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installAvailabilityGate } from '../src/monaco/language-registry';
import { JSON_LANGUAGE_ID, registerJsonLanguage } from '../src/monaco/json-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { createEditorModelPool, languageFor, type PoolDeps } from '../src/ui/editor-model-pool';

interface FakeModel {
  value: string;
  disposed: boolean;
}

function harness(files: Record<string, string>) {
  const models: FakeModel[] = [];
  const deps: PoolDeps = {
    readText: vi.fn(async (_kernel: unknown, path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return { text: files[path]!, encoding: 'utf-8', eol: 'LF' };
    }),
    createModel: vi.fn((path: string, text: string) => {
      const m: FakeModel = { value: `${path}::${text}`, disposed: false };
      const fake = m as unknown as import('../src/monaco/entry').editor.ITextModel & { dispose(): void };
      fake.dispose = () => {
        m.disposed = true;
      };
      models.push(m);
      return fake;
    }),
  };
  const pool = createEditorModelPool(deps);
  return { pool, models, deps };
}

describe('model 池 · 引用计数', () => {
  it('同文件二次 acquire：共享同一份 model、只建一次', async () => {
    const h = harness({ 'a.erb': 'hello' });
    const e1 = await h.pool.acquire({} as never, 'a.erb');
    const e2 = await h.pool.acquire({} as never, 'a.erb');
    expect(e1.model).toBe(e2.model);
    expect(h.models).toHaveLength(1);
    expect(h.pool.refCount('a.erb')).toBe(2);
  });

  it('归零才 dispose：释放一份还剩一份时 model 活着', async () => {
    const h = harness({ 'a.erb': 'x' });
    await h.pool.acquire({} as never, 'a.erb');
    await h.pool.acquire({} as never, 'a.erb');
    const model = h.models[0]! as unknown as FakeModel;
    expect(h.pool.release('a.erb')).toBe(1);
    expect(model.disposed).toBe(false);
    expect(h.pool.release('a.erb')).toBe(0);
    expect(model.disposed).toBe(true);
    expect(h.pool.refCount('a.erb')).toBe(0);
  });

  it('归零释放后重新 acquire：走重读重建（版本号从 1 重新数）', async () => {
    const h = harness({ 'a.erb': 'v1' });
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.release('a.erb');
    const e2 = await h.pool.acquire({} as never, 'a.erb');
    expect(h.models).toHaveLength(2);
    expect(e2.model).not.toBe(h.models[0]);
  });

  it('释放不存在的路径：返回 0 不抛', () => {
    const h = harness({});
    expect(h.pool.release('ghost.erb')).toBe(0);
  });
});

describe('model 池 · 并发与失败', () => {
  it('并发 acquire 同文件：只读一次盘、共享同一份 model', async () => {
    const h = harness({ 'a.erb': 'x' });
    const [e1, e2] = await Promise.all([
      h.pool.acquire({} as never, 'a.erb'),
      h.pool.acquire({} as never, 'a.erb'),
    ]);
    expect(e1.model).toBe(e2.model);
    expect(h.deps.readText).toHaveBeenCalledTimes(1);
    expect(h.pool.refCount('a.erb')).toBe(2);
  });

  it('读盘失败：acquire 抛原错误；池不悬挂', async () => {
    const h = harness({});
    await expect(h.pool.acquire({} as never, 'nope.erb')).rejects.toThrow('ENOENT');
    expect(h.pool.refCount('nope.erb')).toBe(0);
    // 同一池对象在盘上事实补好后（这里以另一个同路径有文件的池模拟重试语义）
    const again = harness({ 'nope.erb': 'ok' });
    const e = await again.pool.acquire({} as never, 'nope.erb');
    expect(e.model).toBeDefined();
  });

  it('恢复件注入：首次 acquire 用注入内容建 model（不读盘）', async () => {
    const h = harness({ 'a.erb': 'disk' });
    const e = await h.pool.acquire({} as never, 'a.erb', { text: 'recovered', encoding: 'utf-16le', eol: 'CRLF' });
    expect((e.model as unknown as FakeModel).value).toContain('recovered');
    expect(e.encoding).toBe('utf-16le');
    expect(e.eol).toBe('CRLF');
    expect(h.deps.readText).not.toHaveBeenCalled();
  });
});

describe('model 池 · 已保存基线', () => {
  it('基线随文件存续；最后一份引用释放时一并清掉', async () => {
    const h = harness({ 'a.erb': 'x' });
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.setBaseline('a.erb', 7);
    expect(h.pool.baseline('a.erb')).toBe(7);
    h.pool.release('a.erb');
    expect(h.pool.baseline('a.erb')).toBeUndefined();
  });

  it('setBaseline 对不在池里的路径 no-op（不复活已回收的记录）', async () => {
    const h = harness({});
    h.pool.setBaseline('ghost.erb', 3);
    expect(h.pool.baseline('ghost.erb')).toBeUndefined();
  });
});

/**
 * ZH-F3：三方合并要有 base **文本**（版本号判得了"有没有变"，判不了"变在哪一行"）。
 * 生命周期必须与记录一致——关掉的 tab 跟着释放，不许在池外留副本。
 */
describe('model 池 · 磁盘文本快照（三方合并的 base）', () => {
  it('读盘首开：base = 盘上那份文本', async () => {
    const h = harness({ 'a.erb': '盘上原文' });
    await h.pool.acquire({} as never, 'a.erb');
    expect(h.pool.savedBase('a.erb')).toBe('盘上原文');
  });

  it('恢复件首开：盘上真相未知 ⇒ base 留空（调用方据此退回两方语义）', async () => {
    const h = harness({ 'a.erb': '盘上原文' });
    const e = await h.pool.acquire({} as never, 'a.erb', { text: '恢复的未保存稿' });
    expect(e.fromRecovery).toBe(true);
    expect(h.pool.savedBase('a.erb')).toBeUndefined();
  });

  it('保存成功推进 base；最后一份引用释放后与记录一起清掉', async () => {
    const h = harness({ 'a.erb': 'v1' });
    await h.pool.acquire({} as never, 'a.erb');
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.setSavedBase('a.erb', 'v2');
    expect(h.pool.savedBase('a.erb')).toBe('v2');
    expect(h.pool.release('a.erb')).toBe(1);
    expect(h.pool.savedBase('a.erb')).toBe('v2');
    expect(h.pool.release('a.erb')).toBe(0);
    expect(h.pool.savedBase('a.erb')).toBeUndefined();
  });

  it('关标签后重开：base 随新一次读盘重建（不拿陈年快照做三方）', async () => {
    const files = { 'a.erb': 'v1' };
    const h = harness(files);
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.release('a.erb');
    files['a.erb'] = 'v2';
    await h.pool.acquire({} as never, 'a.erb');
    expect(h.pool.savedBase('a.erb')).toBe('v2');
  });

  it('并发首开只读一次盘：base 落定一次、两方共享同一条记录', async () => {
    const h = harness({ 'a.erb': 'x' });
    await Promise.all([h.pool.acquire({} as never, 'a.erb'), h.pool.acquire({} as never, 'a.erb')]);
    expect(h.pool.savedBase('a.erb')).toBe('x');
    expect(h.deps.readText).toHaveBeenCalledTimes(1);
  });

  it('setSavedBase 对不在池里的路径 no-op（不复活已回收的记录，也就不会泄漏）', () => {
    const h = harness({});
    h.pool.setSavedBase('ghost.erb', 'x');
    expect(h.pool.savedBase('ghost.erb')).toBeUndefined();
  });
});

/**
 * 认路判据与**语言可用性门**是两条轴（LAU-3）：本文件只钉前者。缺省档 `2.0-default`
 * 会把封存层（`kojo-legacy`）挡在门外 ⇒ `languageFor('.kojo')` 答 `plaintext`；
 * 装一枚恒真假门把门这一轴摘出去（门本身由 `language-registry.test.ts` 钉）。
 */
beforeEach(() => installAvailabilityGate(() => true));
afterEach(() => installAvailabilityGate(null));

/**
 * 语言挂载判据（L1-LANG，2026-10-17）：`languageFor` 曾是**二值映射**（`.kojo` ⇒ 糖、
 * 其余一律 ⇒ ERB），后果是非 ERB 文件（`.md` / `.txt` / `.json` / 存档容器 …）吃到
 * ERB 的补全 / 悬停 / 改名——JSON 里弹 `#DIM` 骨架。现在必须是**显式白名单 + plaintext
 * 兜底**：认不出就不猜。
 *
 * 只测映射表，不碰池的生命周期/引用计数（那是上面几组的事，也是并行批次的事）。
 */
describe('languageFor · 显式白名单 + plaintext 兜底', () => {
  it('.kojo（含大写 / CJK 基名）⇒ 糖语言', () => {
    expect(languageFor('D:\\作品\\事件.kojo')).toBe(KOJO_LANGUAGE_ID);
    expect(languageFor('D:/x/a.kojo')).toBe(KOJO_LANGUAGE_ID);
    expect(languageFor('D:/x/A.KOJO')).toBe(KOJO_LANGUAGE_ID);
  });

  it('大写 `.ERB` 真实语料形态 ⇒ ERB 语言（冒烟夹具就是全大写）', () => {
    const upper =
      'C:\\game\\ERB\\口上・メッセージ関連\\個人口上\\001 Reimu [霊夢]\\M_KOJO_K1_口上.ERB';
    expect(languageFor(upper)).toBe(ERB_LANGUAGE_ID);
    expect(languageFor('D:\\x\\note.ERB')).toBe(ERB_LANGUAGE_ID);
  });

  it('ERB 方言全集（契约单一真源，不手抄清单）大小写两种写法都 ⇒ ERB 语言', () => {
    for (const ext of ERB_DIALECT_EXTENSIONS) {
      expect(languageFor(`D:\\x\\K36${ext}`)).toBe(ERB_LANGUAGE_ID);
      expect(languageFor(`D:\\x\\K36${ext.toUpperCase()}`)).toBe(ERB_LANGUAGE_ID);
    }
    // 多点名取最后一段（`K11_TR.ERH` 这类真实文件名）
    expect(languageFor('D:\\x\\M_KOJO_K11_TR.ERH')).toBe(ERB_LANGUAGE_ID);
  });

  it('`.json` ⇒ JSON_LANGUAGE_ID（该 id 由 json-language 真实注册，见下一组，不是空挂）', () => {
    expect(languageFor('D:\\x\\settings.json')).toBe(JSON_LANGUAGE_ID);
    expect(languageFor('D:\\x\\SETTINGS.JSON')).toBe(JSON_LANGUAGE_ID);
  });

  it('非白名单文件 ⇒ plaintext 兜底，**绝不**是 ERB（缺陷回归闸）', () => {
    const fallbacks = [
      'D:\\x\\README.md',
      'D:\\x\\说明.txt',
      'D:\\Game\\sav\\save001.sav',
      'D:\\Game\\CSV\\Chara\\Chara1.csv',
      'D:\\x\\LICENSE',
      'D:\\x\\a.erd',
      'D:\\x\\A.ERD',
      'D:\\x\\a.kojo.bak',
      'D:\\x\\.erb',
    ];
    for (const p of fallbacks) {
      expect(languageFor(p), `兜底判错：${p}`).toBe('plaintext');
      expect(languageFor(p), `不许吃 ERB：${p}`).not.toBe(ERB_LANGUAGE_ID);
    }
  });
});

/**
 * `.json` 挂上 `json` 这个 id 之前必须先证明它**不是查无此人**：Monaco 对未注册语言
 * 会静默退化成 plaintext，那样等于没改。这里用假 monaco 验注册面（照 `erh-open-surface`
 * 的写法），与 `monaco/entry.ts` 模块级的 `registerJsonLanguage(monacoApi)` 两处互锁。
 */
describe('JSON_LANGUAGE_ID 真实注册（有 Monarch，不是空挂 id）', () => {
  function mockMonaco() {
    const registered: Array<{ id: string; extensions?: string[] }> = [];
    const monarch = new Set<string>();
    const configs = new Set<string>();
    const monaco = {
      languages: {
        getLanguages: () => registered.map((r) => ({ id: r.id })),
        register: (d: { id: string; extensions?: string[] }) => registered.push(d),
        setMonarchTokensProvider: (id: string) => {
          monarch.add(id);
          return { dispose: () => undefined };
        },
        setLanguageConfiguration: (id: string) => {
          configs.add(id);
          return { dispose: () => undefined };
        },
      },
    };
    return {
      registered,
      monarch,
      configs,
      monaco: monaco as unknown as Parameters<typeof registerJsonLanguage>[0],
    };
  }

  it('registerJsonLanguage 登记 id / `.json` 扩展名 / Monarch / 语言配置', () => {
    const m = mockMonaco();
    registerJsonLanguage(m.monaco);
    expect(m.registered.map((r) => r.id)).toEqual([JSON_LANGUAGE_ID]);
    expect(m.registered[0]!.extensions).toEqual(['.json']);
    expect([...m.monarch]).toEqual([JSON_LANGUAGE_ID]);
    expect([...m.configs]).toEqual([JSON_LANGUAGE_ID]);
  });

  it('重复注册幂等（守卫与 erb / kojo 同款）', () => {
    const m = mockMonaco();
    registerJsonLanguage(m.monaco);
    registerJsonLanguage(m.monaco);
    expect(m.registered).toHaveLength(1);
  });
});
