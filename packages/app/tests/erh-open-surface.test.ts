import { describe, expect, it, vi } from 'vitest';
import { ERB_DIALECT_EXTENSIONS, erbMonacoExtensions, isErbDialectPath } from '@kojo/plugin-api';
import { registerErbLanguage } from '../src/monaco/erb-language';
import { erbReadOnlyGate, isErbLike } from '../src/ui/lift-preview';
import { classifyDrop, dropHintText, processDroppedFiles } from '../src/ui/drag-drop';

/**
 * `.ERH` 覆盖面自证（FT-2，2026-10-14）。
 *
 * 引擎预载白名单认 `.ERH` 是脚本文件（Emuera `Runtime/Utils/Preload.cs`），而编辑器
 * 此前**打不开它**。本批要的是三件一起成立，且**只读语义一条不破**：
 *   ① 拖得开 / 说得清（拖入白名单 + 覆盖提示同源派生）；
 *   ② 有高亮（Monaco 扩展名映射与方言清单同源）；
 *   ③ 能看能存、产物不回退（只读门按既有两轴走，声明文件不被糖线接管）。
 *
 * 写法照本目录既有的纯逻辑测试（`drag-drop.test.ts` / `lift-preview.test.ts`）：
 * 判定与文案派生都住在可单测的纯函数里，React/Monaco 只做接线。
 */

const GAME_ERH = 'C:\\game\\ERB\\口上・メッセージ関連\\個人口上\\010 Suika [萃香]\\萃香 自制别人\\MARKS_OF_SUIKA.ERH';
const WORKSPACE_ERH = 'D:\\作者工作区\\我的作品\\变量定义.ERH';

describe('① 拖得开：.ERH 进拖入白名单，提示文案由同一份清单派生', () => {
  it('大写 / 小写 / CJK 目录 / 带空格的 .ERH 都能拖进来', () => {
    const paths = [GAME_ERH, 'D:\\x\\K15C_SAKUYADIM.erh', 'D:\\x\\一些变量.ErH', 'D:\\x\\K36.ERH'];
    expect(classifyDrop(paths).files).toEqual(paths);
    expect(classifyDrop(paths).rejected).toEqual([]);
  });

  it('覆盖提示里逐个列出的就是 OPENABLE_EXT，且 `.erh` 已在其中（不是另抄一句文案）', () => {
    const hint = dropHintText();
    for (const ext of ['.kojo', ...ERB_DIALECT_EXTENSIONS, '.md', '.txt']) {
      expect(hint, `提示应含 ${ext}`).toContain(ext);
    }
    expect(hint).toBe(`松手就能打开：${['.kojo', ...ERB_DIALECT_EXTENSIONS, '.md', '.txt'].join(' / ')}`);
  });

  it('落地链路照旧零写盘：拖入 .ERH 只 stat + 开标签', async () => {
    const calls: string[] = [];
    const io = {
      stat: vi.fn(async (p: string) => {
        calls.push(`stat:${p}`);
        return { size: 10, mtimeMs: 0, isDirectory: false };
      }),
      writeText: vi.fn(),
      readText: vi.fn(),
      exportFile: vi.fn(),
    };
    const opened: string[] = [];
    const notify = vi.fn();
    await processDroppedFiles({
      io,
      paths: [GAME_ERH, 'D:\\x\\note.txt'],
      openFile: (p) => opened.push(p),
      notifyRejections: notify,
    });
    expect(opened).toEqual([GAME_ERH, 'D:\\x\\note.txt']);
    expect(notify).not.toHaveBeenCalled();
    expect(calls.every((c) => c.startsWith('stat:'))).toBe(true);
    expect(io.writeText).not.toHaveBeenCalled();
    expect(io.exportFile).not.toHaveBeenCalled();
  });
});

describe('② 有高亮：Monaco 扩展名映射与方言清单同源', () => {
  /** 只留注册表与语言配置要用的成员；断言"注册了什么"，不碰真 Monaco */
  function mockMonaco() {
    const registered: Array<{ id: string; extensions: string[]; aliases: string[] }> = [];
    const monaco = {
      languages: {
        // ERB-ENTER-RULES：`.erb` 的语言配置现在也过 `toMonacoEnterConfig`（与 `.kojo` 同一道翻译层），
        // 装配 `onEnterRules` 时要读这一格；取值与 monaco-editor 的枚举逐字对齐（同 monarch-harness）。
        IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
        getLanguages: () => registered.map((r) => ({ id: r.id })),
        register: (d: { id: string; extensions: string[]; aliases: string[] }) => registered.push(d),
        setMonarchTokensProvider: vi.fn(),
        setLanguageConfiguration: vi.fn(),
      },
      // 本批只验"登记了哪些扩展名"，主题那条通道留个空壳即可
      editor: { defineTheme: vi.fn() },
    };
    return { registered, monaco: monaco as unknown as Parameters<typeof registerErbLanguage>[0] };
  }

  it('ERB 语言把每个方言扩展名都登记了（大小写两种写法）', () => {
    const { registered, monaco } = mockMonaco();
    registerErbLanguage(monaco);
    expect(registered).toHaveLength(1);
    const { extensions } = registered[0]!;
    expect(extensions).toEqual(erbMonacoExtensions());
    for (const ext of ERB_DIALECT_EXTENSIONS) {
      expect(extensions, `映射应含 ${ext}`).toContain(ext);
      expect(extensions, `映射应含 ${ext.toUpperCase()}`).toContain(ext.toUpperCase());
    }
  });

  it('重复注册不叠加（幂等守卫还在：第二次调用不再 register）', () => {
    const { registered, monaco } = mockMonaco();
    registerErbLanguage(monaco);
    registerErbLanguage(monaco);
    expect(registered).toHaveLength(1);
  });
});

describe('③ 能看能存：只读门按既有两轴走，.ERH 不绕开任何一道', () => {
  it('.ERH 与 .ERB 走同一条判定（isErbLike 只是单一真源的别名）', () => {
    expect(isErbLike(GAME_ERH)).toBe(true);
    expect(isErbLike(WORKSPACE_ERH)).toBe(true);
    expect(isErbLike('C:\\x\\事件.kojo')).toBe(false);
    expect(isErbLike('C:\\x\\readme.md')).toBe(false);
    expect(isErbLike(GAME_ERH)).toBe(isErbDialectPath(GAME_ERH));
  });

  it('真值表：只有"方言文件 ∧ 不在作者工作区 ∧ 没拿到可编辑"才锁', () => {
    // 游戏目录里的声明文件：默认只读（写允许域没批就是读）
    expect(erbReadOnlyGate(GAME_ERH, { inWorkspace: false, canEdit: false })).toBe(true);
    // 作者工作区（常驻可写根）：恒可编辑——存得出去
    expect(erbReadOnlyGate(WORKSPACE_ERH, { inWorkspace: true, canEdit: false })).toBe(false);
    // 会话内显式解锁 / 直连模式开门：照样不锁（`.ERH` 没把这套逻辑绕开）
    expect(erbReadOnlyGate(GAME_ERH, { inWorkspace: false, canEdit: true })).toBe(false);
    // 非方言文件（`.kojo` / `.md`）不经这道门
    expect(erbReadOnlyGate('D:\\x\\事件.kojo', { inWorkspace: false, canEdit: false })).toBe(false);
    expect(erbReadOnlyGate('D:\\x\\readme.md', { inWorkspace: false, canEdit: false })).toBe(false);
  });

  it('留位未接线的 `.ERD` 三件都不给（不写没盘可证的行为）', () => {
    const erd = 'C:\\game\\ERB\\カラム機能\\COLUMNDIV@2.ERD';
    expect(classifyDrop([erd]).files).toEqual([]);
    expect(isErbLike(erd)).toBe(false);
    expect(erbReadOnlyGate(erd, { inWorkspace: false, canEdit: false })).toBe(false);
  });
});
