/**
 * 新建条目命名规则单测（反馈 1b）。
 *
 * 核心断言不是"能拼出路径"，而是**该拒绝的都拒绝、绝不静默改名**——
 * 作者手打的名字被悄悄改一个字符，他会以为编辑器坏了。
 */

import { describe, expect, it } from 'vitest';
import { isPathUnder } from '@kojo/plugin-api';
import { NEW_ITEM_MENU, newItemPreviewName, resolveNewItemPath } from '@kojo/kojo-project-kit';

const D = 'C:/app/workspaces/p1/我的作品-灵梦 v1.0';
const ok = (name: string, kind: 'folder' | 'kojo' | 'erb' | 'txt') => {
  const r = resolveNewItemPath(D, name, kind);
  if (!r.ok) throw new Error(`本该成功，却拒绝：${r.reason}`);
  return r;
};
const reason = (name: string, kind: 'folder' | 'kojo' | 'erb' | 'txt'): string => {
  const r = resolveNewItemPath(D, name, kind);
  if (r.ok) throw new Error(`本该拒绝，却放行：${r.absPath}`);
  return r.reason;
};

describe('resolveNewItemPath · 放行', () => {
  it('不写扩展名 → 按所选类型补上', () => {
    expect(ok('事件', 'kojo').displayName).toBe('事件.kojo');
    expect(ok('事件', 'erb').displayName).toBe('事件.erb');
    expect(ok('说明', 'txt').displayName).toBe('说明.txt');
  });
  it('写的就是所选类型 → 原样，不叠第二层扩展名', () => {
    expect(ok('事件.kojo', 'kojo').displayName).toBe('事件.kojo');
    expect(ok('事件.KOJO', 'kojo').displayName).toBe('事件.KOJO'); // 大小写不敏感
  });
  it('文件夹不带扩展名逻辑', () => {
    expect(ok('子目录', 'folder').displayName).toBe('子目录/');
    expect(ok('备份.2026', 'folder').displayName).toBe('备份.2026/');
  });
  it('点号但不是已知扩展名（v1.2 草稿）→ 视为无扩展名并补上', () => {
    expect(ok('草稿 v1.2', 'kojo').displayName).toBe('草稿 v1.2.kojo');
  });
  it('中日文、空格、括号一律放行（这是给中文作者用的）', () => {
    expect(ok('奉仕指令（改）', 'kojo').displayName).toBe('奉仕指令（改）.kojo');
    expect(ok('A_一般', 'erb').displayName).toBe('A_一般.erb');
  });
  it('绝对路径确实落在所选目录之下', () => {
    // 用仓库自己的 isPathUnder 判，不用字符串前缀：join 会按首段风格产出分隔符
    // （win32 风格给反斜杠），前缀比较在这里必然假阴性。
    expect(isPathUnder(D, ok('事件', 'kojo').absPath)).toBe(true);
  });
});

describe('resolveNewItemPath · 拒绝（不静默改名）', () => {
  it('空 / 纯空白', () => {
    expect(reason('   ', 'kojo')).toMatch(/不能为空/);
  });
  it('Windows 非法字符逐个都拒', () => {
    for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
      expect(reason(`a${ch}b`, 'kojo'), `字符 ${ch} 应被拒`).toMatch(/不能含/);
    }
  });
  it('「.」与「..」是路径不是名字', () => {
    expect(reason('.', 'folder')).toMatch(/不能用作名称/);
    expect(reason('..', 'folder')).toMatch(/不能用作名称/);
  });
  it('尾随点号拒绝（Windows 会裁掉，建出来的名字对不上）', () => {
    expect(reason('事件.', 'kojo')).toMatch(/不能以点号或空格结尾/);
  });
  it('首尾空白是正常修剪，不算非法（没有作者会故意打尾空格）', () => {
    expect(ok('  事件  ', 'kojo').displayName).toBe('事件.kojo');
  });
  it('选 .kojo 却打 .ERB → 拒绝，既不叠成 .ERB.kojo 也不偷改成 .ERB', () => {
    expect(reason('事件.ERB', 'kojo')).toMatch(/你选的是 \.kojo/);
  });
});

describe('菜单与预览', () => {
  it('菜单四项、顺序即口径（糖优先，因为它是默认源）', () => {
    expect(NEW_ITEM_MENU.map((m) => m.kind)).toEqual(['kojo', 'erb', 'txt', 'folder']);
    for (const m of NEW_ITEM_MENU) expect(m.hint.length).toBeGreaterThan(0);
  });

  it('预览名与实际建成名同源（提示说 A、建出来是 B 是最难查的坑）', () => {
    expect(newItemPreviewName('事件', 'kojo')).toBe('事件.kojo');
    expect(newItemPreviewName('事件.kojo', 'kojo')).toBe('事件.kojo');
    expect(newItemPreviewName('子目录', 'folder')).toBe('子目录/');
    expect(newItemPreviewName('事件.ERB', 'kojo')).toBe(''); // 非法 → 无预览，由原因说话
  });
});
