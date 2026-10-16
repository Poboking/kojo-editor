import { describe, expect, it } from 'vitest';
import {
  deleteConfirmText,
  fsLocatePlanOf,
  fsLocatePlanOfRoots,
  isUnderPath,
  joinPath,
  locatePlanOf,
  menuItemsFor,
  parentDir,
  relativeToRoot,
  validateEntryName,
  type MenuCapability,
} from '../src/ui/file-tree-ops';

/**
 * 文件树编辑批（B1/B2/B4）纯逻辑判据。文案与可见性在这里钉死：
 * 组件只接线——判据长在组件里就没法测"菜单为什么少了这一项"。
 */

const FULL_CAP: MenuCapability = { hasIo: true, canReveal: true, canImport: true };

/* ------------------------------ 菜单可见性 ------------------------------ */

describe('menuItemsFor · 能力缺项时整项不显示（灰着不说话 = 违反铁律 4）', () => {
  it('文件菜单全量：打开 | 复制路径、复制相对路径、显示 | 重命名、删除', () => {
    expect(menuItemsFor('file', FULL_CAP).map((i) => i.id)).toEqual([
      'open',
      'copy-path',
      'copy-rel-path',
      'reveal',
      'rename',
      'delete',
    ]);
  });

  it('无 io（浏览器壳/无内核宿主）：盘上动作三项整组消失，复制类保留（剪贴板到处都有）', () => {
    const ids = menuItemsFor('file', { hasIo: false, canReveal: false, canImport: false }).map((i) => i.id);
    expect(ids).toEqual(['open', 'copy-path', 'copy-rel-path']);
  });

  it('无「在资源管理器中显示」通道：只有那一项消失，其余不动', () => {
    const ids = menuItemsFor('file', { hasIo: true, canReveal: false, canImport: false }).map((i) => i.id);
    expect(ids).toEqual(['open', 'copy-path', 'copy-rel-path', 'rename', 'delete']);
  });

  it('目录菜单：新建文件、新建文件夹 | 复制路径 | 显示 | 重命名、删除（无导入、无相对路径）', () => {
    expect(menuItemsFor('dir', FULL_CAP).map((i) => i.id)).toEqual([
      'new-file',
      'new-dir',
      'copy-path',
      'reveal',
      'rename',
      'delete',
    ]);
  });

  it('包菜单 = 导入（有通道才出现）+ 目录动作；导入缺席时新建组顶到首位且不挂分隔线', () => {
    const withImport = menuItemsFor('package', FULL_CAP);
    expect(withImport.map((i) => i.id)).toEqual([
      'import',
      'new-file',
      'new-dir',
      'copy-path',
      'reveal',
      'rename',
      'delete',
    ]);
    expect(withImport[1]!.dividerBefore).toBe(true); // 导入与编辑动作之间隔一条线

    const noImport = menuItemsFor('package', { hasIo: true, canReveal: false, canImport: false });
    expect(noImport[0]!.id).toBe('new-file');
    expect(noImport[0]!.dividerBefore).toBeFalsy(); // 首项分隔线由渲染侧吞掉，这里就不该有
  });

  it('分隔线只出现在既定的分组位（复制组 | 重命名删除组）', () => {
    const file = menuItemsFor('file', FULL_CAP);
    expect(file.find((i) => i.id === 'reveal')!.dividerBefore).toBe(true);
    expect(file.find((i) => i.id === 'rename')!.dividerBefore).toBe(true);
    expect(file.find((i) => i.id === 'delete')!.dividerBefore).toBeFalsy();
  });
});

/* ------------------------------ 名称校验 ------------------------------ */

describe('validateEntryName · 新建/重命名的文件名合法性', () => {
  it('普通名字合法（中日文、点扩展名、空格在中间都行）', () => {
    expect(validateEntryName('事件.ERB')).toBeNull();
    expect(validateEntryName('M_KOJO_K1_2_イベント.erb')).toBeNull();
    expect(validateEntryName('我的 包 v2')).toBeNull();
    expect(validateEntryName('  事件.ERB  ')).toBeNull(); // 首尾空白裁掉后合法
  });

  it('空 / 纯空白 / 保留名 拒绝', () => {
    expect(validateEntryName('')).not.toBeNull();
    expect(validateEntryName('   ')).not.toBeNull();
    expect(validateEntryName('.')).not.toBeNull();
    expect(validateEntryName('..')).not.toBeNull();
  });

  it('路径分隔符与 Windows 非法字符拒绝，且错误信息说人话（不带内部术语）', () => {
    for (const bad of ['a/b', 'a\\b', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      const msg = validateEntryName(bad)!;
      expect(msg, bad).toBeTruthy();
      expect(msg).not.toMatch(/writable|domain|model/i);
    }
  });

  it('结尾的点拒绝；首尾空白先被归正（Windows 硬约束：盘上会静默丢掉它们）', () => {
    expect(validateEntryName('abc.')).not.toBeNull();
    expect(validateEntryName(' abc ')).toBeNull(); // trim 归正后合法——顺手修正是更好的 UX
  });
});

/* ------------------------------ 路径小工具 ------------------------------ */

describe('joinPath / parentDir / isUnderPath', () => {
  it('joinPath 折叠目录尾部分隔符，不产生双斜杠', () => {
    expect(joinPath('C:/koa/001', 'a.ERB')).toBe('C:/koa/001/a.ERB');
    expect(joinPath('C:/koa/001/', 'a.ERB')).toBe('C:/koa/001/a.ERB');
    expect(joinPath('C:\\koa\\001\\', 'a.ERB')).toBe('C:\\koa\\001/a.ERB'); // 反斜杠只折叠尾部
  });

  it('parentDir 取末段之前；无分隔符 = 空串', () => {
    expect(parentDir('C:/koa/001/a.ERB')).toBe('C:/koa/001');
    expect(parentDir('C:\\koa\\001\\a.ERB')).toBe('C:\\koa\\001');
    expect(parentDir('a.ERB')).toBe('');
  });

  it('isUnderPath：分隔符与大小写归一；根自身算在内；前缀巧合不算（001 不含 0011）', () => {
    expect(isUnderPath('C:/koa/001', 'C:/koa/001/a.ERB')).toBe(true);
    expect(isUnderPath('C:/koa/001/', 'C:\\KOA\\001\\子\\b.ERB')).toBe(true);
    expect(isUnderPath('C:/koa/001', 'C:/koa/001')).toBe(true);
    expect(isUnderPath('C:/koa/001', 'C:/koa/0011/a.ERB')).toBe(false);
    expect(isUnderPath('C:/koa/001', 'C:/koa/002/a.ERB')).toBe(false);
  });
});

describe('relativeToRoot · 复制相对路径', () => {
  it('根下：去掉根前缀，保留一层相对形态（分隔符统一成正斜杠）', () => {
    expect(relativeToRoot('C:/game/koa/001/a.ERB', 'C:/game/koa')).toBe('001/a.ERB');
    expect(relativeToRoot('C:\\game\\koa\\001\\a.ERB', 'C:/game/koa')).toBe('001/a.ERB');
  });

  it('大小写不同的根前缀也命中（Windows 口径）', () => {
    expect(relativeToRoot('c:/GAME/koa/a.ERB', 'C:/game')).toBe('koa/a.ERB');
  });

  it('不在根下（工作区外拖入等）：原样返回完整路径——半截路径只会误导收的人', () => {
    expect(relativeToRoot('D:/works/a.ERB', 'C:/game')).toBe('D:/works/a.ERB');
  });
});

/* ------------------------------ 删除确认文案 ------------------------------ */

describe('deleteConfirmText · 递归删除的量级提示（必须让用户看清刀多大）', () => {
  it('文件：给文件名 + 无法撤销', () => {
    const msg = deleteConfirmText({ name: '事件.ERB', isDir: false });
    expect(msg).toContain('事件.ERB');
    expect(msg).toContain('无法撤销');
    expect(msg).not.toContain('文件夹'); // 文件不用背目录的量级警示
  });

  it('目录 + 现算成功的 N：「将同时删除其中的 N 个文件」', () => {
    const msg = deleteConfirmText({ name: '少女之梦', isDir: true, fileCount: 42 });
    expect(msg).toContain('少女之梦');
    expect(msg).toContain('42');
    expect(msg).toContain('无法撤销');
  });

  it('目录 + N 现算失败：数字退场，但「全部内容都会被删除」的警示语必须保留', () => {
    const msg = deleteConfirmText({ name: '少女之梦', isDir: true, fileCount: undefined });
    expect(msg).not.toContain('undefined');
    expect(msg).toContain('全部内容');
    expect(msg).toContain('无法撤销');
  });
});

/* ------------------------------ B4：定位计算 ------------------------------ */

const GROUPS = [
  {
    label: '#1 霊夢',
    prefix: 'C:/koa/001',
    subs: [
      { label: null, files: ['C:/koa/001/M_KOJO_K1.ERB'] },
      { label: '少女之梦', files: ['C:/koa/001/少女之梦/M_KOJO_MESSAGE_COM_K1_1.ERB'] },
    ],
  },
  {
    label: '#4 觉',
    prefix: 'C:/koa/004',
    subs: [{ label: null, files: ['C:/koa/004/x.ERB'] }],
  },
];
const pkgDirOf = (prefix: string, label: string): string => `${prefix}/${label}`;

describe('locatePlanOf · activeFile → 需要展开的组/包 + 目标行', () => {
  it('包内文件：展开所在组 + 打开该包的真实文件夹视图，目标行 = 文件路径', () => {
    const plan = locatePlanOf(GROUPS, 'C:/koa/001/少女之梦/M_KOJO_MESSAGE_COM_K1_1.ERB', pkgDirOf);
    expect(plan).not.toBeNull();
    expect(plan!.groupLabel).toBe('#1 霊夢');
    expect(plan!.pkg).toEqual({ key: '#1 霊夢::少女之梦', dir: 'C:/koa/001/少女之梦' });
    expect(plan!.targetPath).toBe('C:/koa/001/少女之梦/M_KOJO_MESSAGE_COM_K1_1.ERB');
  });

  it('根散文件（无包目录）：只展开组，pkg = null', () => {
    const plan = locatePlanOf(GROUPS, 'C:/koa/004/x.ERB', pkgDirOf);
    expect(plan!.groupLabel).toBe('#4 觉');
    expect(plan!.pkg).toBeNull();
  });

  it('路径写法不同（反斜杠/大小写）也命中——Windows 同一文件', () => {
    const plan = locatePlanOf(GROUPS, 'c:/koa/001/少女之梦/m_kojo_message_com_k1_1.erb', pkgDirOf);
    expect(plan).not.toBeNull();
    expect(plan!.groupLabel).toBe('#1 霊夢');
  });

  it('找不到（未归属/被删）：null——调用侧安静放弃，不报错', () => {
    expect(locatePlanOf(GROUPS, 'C:/nowhere/a.ERB', pkgDirOf)).toBeNull();
    expect(locatePlanOf([], 'C:/koa/001/x.ERB', pkgDirOf)).toBeNull();
  });

  it('长前缀优先的归属不被破坏：同前缀字符串的两组各归各组', () => {
    const groups = [
      { label: '#A', prefix: 'C:/koa', subs: [{ label: null, files: ['C:/koa/a.ERB'] }] },
      { label: '#B', prefix: 'C:/koa/001', subs: [{ label: null, files: ['C:/koa/001/b.ERB'] }] },
    ];
    expect(locatePlanOf(groups, 'C:/koa/001/b.ERB', pkgDirOf)!.groupLabel).toBe('#B');
    expect(locatePlanOf(groups, 'C:/koa/a.ERB', pkgDirOf)!.groupLabel).toBe('#A');
  });
});

/* ------------------------------ B5：文件系统视图的定位 ------------------------------ */

describe('fsLocatePlanOf · 文件系统视图的定位（从根到目标逐级展开）', () => {
  it('深层文件：返回由浅到深的祖先目录（绝对路径、不含根自身）', () => {
    expect(fsLocatePlanOf('C:/game', 'C:/game/ERB/kojo/001/a.ERB')).toEqual([
      'C:/game/ERB',
      'C:/game/ERB/kojo',
      'C:/game/ERB/kojo/001',
    ]);
  });

  it('根层直挂文件：无需展开任何祖先，返回 []', () => {
    expect(fsLocatePlanOf('C:/game', 'C:/game/a.ERB')).toEqual([]);
  });

  it('分隔符/大小写写法差异也命中（Windows 同一文件）；段大小写取自 activeFile 原样', () => {
    expect(fsLocatePlanOf('c:\\game\\', 'C:/GAME/ERB/kojo/a.ERB')).toEqual([
      'c:/game/ERB',
      'c:/game/ERB/kojo',
    ]);
  });

  it('不在项目根下 / 根自身：null——调用侧安静放弃，不报错', () => {
    expect(fsLocatePlanOf('C:/game', 'D:/other/a.ERB')).toBeNull();
    expect(fsLocatePlanOf('C:/game', 'C:/game')).toBeNull();
  });

  it('根尾随分隔符不产生空段；前缀巧合不算（/game 不含 /game2）', () => {
    expect(fsLocatePlanOf('C:/game/', 'C:/game/a.ERB')).toEqual([]);
    expect(fsLocatePlanOf('C:/game', 'C:/game2/sub/a.ERB')).toBeNull();
  });
});

/* ------------------------------ D1：多根文件系统视图的定位 ------------------------------ */

describe('fsLocatePlanOfRoots · 多根 fs 视图的定位（归属到根 + 从该根展开）', () => {
  const roots = ['C:/game', 'D:/参考资料'];

  it('附加根内的文件：归属到附加根，祖先从附加根起算', () => {
    expect(fsLocatePlanOfRoots(roots, 'D:/参考资料/ERB/a.ERB')).toEqual({
      root: 'D:/参考资料',
      dirs: ['D:/参考资料/ERB'],
    });
  });

  it('项目根内的文件：归属到项目根（附加根是并列的另一棵，不抢）', () => {
    expect(fsLocatePlanOfRoots(roots, 'C:/game/ERB/kojo/a.ERB')).toEqual({
      root: 'C:/game',
      dirs: ['C:/game/ERB', 'C:/game/ERB/kojo'],
    });
  });

  it('附加根嵌在项目根之下时取最长前缀（子目录树归附加根，不被项目根吞掉）', () => {
    const nested = ['C:/game', 'C:/game/参考'];
    expect(fsLocatePlanOfRoots(nested, 'C:/game/参考/笔记/a.ERB')).toEqual({
      root: 'C:/game/参考',
      dirs: ['C:/game/参考/笔记'],
    });
    // 附加根之外的文件仍归项目根
    expect(fsLocatePlanOfRoots(nested, 'C:/game/ERB/a.ERB')?.root).toBe('C:/game');
  });

  it('都不包含 / 文件就是某个根自身：null——调用侧安静放弃', () => {
    expect(fsLocatePlanOfRoots(roots, 'E:/elsewhere/a.ERB')).toBeNull();
    expect(fsLocatePlanOfRoots(roots, 'C:/game')).toBeNull();
  });

  it('根层直挂文件：root 给出、dirs 为空（无需展开，等根层列举回来即可滚）', () => {
    expect(fsLocatePlanOfRoots(roots, 'D:/参考资料/README.txt')).toEqual({
      root: 'D:/参考资料',
      dirs: [],
    });
  });
});
