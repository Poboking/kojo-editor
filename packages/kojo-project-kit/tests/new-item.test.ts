/**
 * 新建条目命名规则（P1 语言自由度批，2026-11-02）。
 *
 * 钉三件事：
 * ① 新建档从「kojo / ERB / txt」放开到 `.md` 笔记与 `.erm` 正文，老四档行为逐字不变；
 * ② 扩展名**只从契约单源现算**——`.kojo` 与 `.erb` / `.erm` 在菜单与解析里都不许手抄；
 * ③ 命名规则延续"拒绝并说明"，不静默消毒、不叠第二层扩展名。
 */

import { describe, expect, it } from 'vitest';
import { ERB_BODY_EXTENSIONS, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import {
  NEW_ITEM_MENU,
  newItemPreviewName,
  resolveNewItemPath,
  type NewItemKind,
} from '../src/new-item';

const D = 'C:/app/workspaces/p1/我的作品-灵梦 v1.0';

const ok = (name: string, kind: NewItemKind) => {
  const r = resolveNewItemPath(D, name, kind);
  if (!r.ok) throw new Error(`本该成功，却拒绝：${r.reason}`);
  return r;
};

const reason = (name: string, kind: NewItemKind): string => {
  const r = resolveNewItemPath(D, name, kind);
  if (r.ok) throw new Error(`本该拒绝，却放行：${r.absPath}`);
  return r.reason;
};

describe('新档补全 · md 与 erm', () => {
  it('不写扩展名 → 按所选档补上（md 笔记 / erm 正文）', () => {
    expect(ok('写作笔记', 'md').displayName).toBe('写作笔记.md');
    expect(ok('一般口上', 'erm').displayName).toBe('一般口上.erm');
  });

  it('已写同义大小写形态 → 原样接受，不叠第二层', () => {
    expect(ok('写作笔记.MD', 'md').displayName).toBe('写作笔记.MD');
    expect(ok('一般口上.ERM', 'erm').displayName).toBe('一般口上.ERM');
    expect(ok('事件.KOJO', 'kojo').displayName).toBe('事件.KOJO');
  });

  it('点号但不是已知扩展名（v1.2 草稿）→ 视为无扩展名并补上', () => {
    expect(ok('草稿 v1.2', 'md').displayName).toBe('草稿 v1.2.md');
    expect(ok('草稿 v1.2', 'erm').displayName).toBe('草稿 v1.2.erm');
  });
});

describe('新档拒绝 · 跨类型与非法输入', () => {
  it('跨类型一律拒绝并点名原因（不偷改类型、不叠扩展名）', () => {
    expect(reason('笔记.txt', 'md')).toMatch(/你选的是 \.md/);
    expect(reason('正文.erb', 'erm')).toMatch(/你选的是 \.erm/);
    expect(reason('正文.erm', 'erb')).toMatch(/你选的是 \.erb/);
    expect(reason('正文.erm', 'kojo')).toMatch(/你选的是 \.kojo/);
  });

  it('json / csv 也算"别的已知类型" → 拒绝', () => {
    expect(reason('表.csv', 'md')).toMatch(/名字以 \.csv 结尾/);
    expect(reason('配置.json', 'erm')).toMatch(/名字以 \.json 结尾/);
  });

  it('Windows 非法字符逐档都拒', () => {
    for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
      expect(reason(`a${ch}b`, 'md'), `md 字符 ${ch} 应被拒`).toMatch(/不能含/);
      expect(reason(`a${ch}b`, 'erm'), `erm 字符 ${ch} 应被拒`).toMatch(/不能含/);
    }
  });

  it('空名 / 纯空白拒绝', () => {
    expect(reason('   ', 'md')).toMatch(/不能为空/);
    expect(reason('   ', 'erm')).toMatch(/不能为空/);
  });
});

describe('菜单 · 顺序与单源扩展名', () => {
  it('六项顺序固定：kojo → erb → erm → txt → md → folder', () => {
    expect(NEW_ITEM_MENU.map((m) => m.kind)).toEqual(['kojo', 'erb', 'erm', 'txt', 'md', 'folder']);
    for (const m of NEW_ITEM_MENU) expect(m.hint.length).toBeGreaterThan(0);
  });

  it('菜单上的扩展名与契约单源逐字一致（不手抄）', () => {
    const resolveExt = (kind: NewItemKind): string => ok('示例', kind).displayName.slice('示例'.length);
    expect(resolveExt('kojo')).toBe(KOJO_SOURCE_EXTENSION);
    expect(resolveExt('erb')).toBe(ERB_BODY_EXTENSIONS[0]!);
    expect(resolveExt('erm')).toBe(ERB_BODY_EXTENSIONS[1]!);
    expect(resolveExt('txt')).toBe('.txt');
    expect(resolveExt('md')).toBe('.md');

    const labelOf = (kind: NewItemKind): string => NEW_ITEM_MENU.find((m) => m.kind === kind)!.label;
    expect(labelOf('kojo')).toContain(KOJO_SOURCE_EXTENSION);
    expect(labelOf('erb')).toContain(ERB_BODY_EXTENSIONS[0]!.toUpperCase());
    expect(labelOf('erm')).toContain(ERB_BODY_EXTENSIONS[1]!);
    expect(labelOf('txt')).toContain('.txt');
    expect(labelOf('md')).toContain('.md');
  });

  it('文案说人话：菜单标签不带"方言 / 内部"这类术语', () => {
    for (const m of NEW_ITEM_MENU) expect(m.label).not.toMatch(/方言|内部|契约/);
  });

  it('预览名与实际建成名同源（md / erm 各一）', () => {
    expect(newItemPreviewName('写作笔记', 'md')).toBe('写作笔记.md');
    expect(newItemPreviewName('写作笔记.MD', 'md')).toBe('写作笔记.MD');
    expect(newItemPreviewName('一般口上', 'erm')).toBe('一般口上.erm');
    expect(newItemPreviewName('笔记.txt', 'md')).toBe(''); // 非法 → 无预览，由原因说话
  });
});
