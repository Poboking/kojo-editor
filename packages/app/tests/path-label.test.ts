import { describe, expect, it } from 'vitest';
import { dirLabelParts, pathLabelParts, splitPath } from '../src/ui/path-label';

/**
 * 编辑器工具条路径呈现（UI P4，§5.99）的两条纯函数。
 *
 * 钉的是实机量出来的那个坏结果：1280 宽窗口里整条绝对路径 969px、工具条只给 550px，
 * 纯 CSS 尾部省略把**文件名整个裁掉**——作者看编辑器顶部读到的是游戏目录前缀，
 * 读不到"我在改哪一个文件"。规矩：**身份不许裁（文件名 + 最深一层目录恒显），前缀可以让**。
 */

const REAL =
  'C:\\game\\eratw-4.980\\ERB\\口上・メッセージ関連\\個人口上\\001 Reimu [霊夢]\\灵梦-少女之梦\\M_KOJO_K1_2_セクハラコマンド.ERB';

describe('splitPath · 目录与文件名拆分', () => {
  it('Windows 分隔符：最后一段是文件名，其余是目录', () => {
    expect(splitPath('C:\\a\\b\\name.ERB')).toEqual({ dir: 'C:\\a\\b', base: 'name.ERB' });
  });

  it('正斜杠同样认（平台原样字符串，这里不做归一化）', () => {
    expect(splitPath('/x/y/z.kojo')).toEqual({ dir: '/x/y', base: 'z.kojo' });
  });

  it('没有分隔符 → 整串是文件名，目录空（不猜当前目录）', () => {
    expect(splitPath('readme.txt')).toEqual({ dir: '', base: 'readme.txt' });
  });

  it('以分隔符结尾 → 文件名为空：调用侧据此决定显示什么，不在这里编一个', () => {
    expect(splitPath('C:\\a\\')).toEqual({ dir: 'C:\\a', base: '' });
  });
});

describe('pathLabelParts · 三段（head 可缩 / tail+base 恒显）', () => {
  it('真实语料路径：文件名与最深一层目录**整段保住**，只有前缀被省略', () => {
    const p = pathLabelParts(REAL);
    expect(p.base).toBe('M_KOJO_K1_2_セクハラコマンド.ERB');
    expect(p.tail).toBe('灵梦-少女之梦');
    expect(p.head.length).toBeLessThanOrEqual(27);
    expect(p.head).toContain('…');
    expect(p.head.startsWith('C:\\game\\')).toBe(true);
  });

  it('前缀省略仍保住靠近尾部的那段（角色目录比盘符有用）', () => {
    const p = pathLabelParts(REAL);
    const grand = splitPath(splitPath(REAL).dir).dir; // 去掉包名与文件名后的前缀
    expect(p.head.endsWith(grand.slice(-12))).toBe(true);
  });

  it('只有一层目录 → 盘符留在 head、目录名进 tail，谁都不编造分隔符', () => {
    expect(pathLabelParts('C:\\a\\name.kojo')).toEqual({ head: 'C:', tail: 'a', base: 'name.kojo' });
  });

  it('没有目录 → 三段里只有文件名', () => {
    expect(pathLabelParts('readme.txt')).toEqual({ head: '', tail: '', base: 'readme.txt' });
  });

  it('短路径原样通过：不硬造省略号', () => {
    expect(pathLabelParts('D:\\Work\\kojo-editor\\docs\\HANDOFF.md')).toEqual({
      head: 'D:\\Work\\kojo-editor',
      tail: 'docs',
      base: 'HANDOFF.md',
    });
  });

  it('预算可收：给多小都不会超过预算 + 省略号，且身份两段不受影响', () => {
    const p = pathLabelParts(REAL, 16);
    expect(p.head.length).toBeLessThanOrEqual(17);
    expect(p.tail).toBe('灵梦-少女之梦');
    expect(p.base).toBe('M_KOJO_K1_2_セクハラコマンド.ERB');
  });
});

describe('dirLabelParts · 快速打开副行（目录两段）', () => {
  const DIR = REAL.slice(0, REAL.lastIndexOf('\\'));

  it('最深一层目录（包名）整段保住 —— 副行唯一要回答的就是"哪一个包"', () => {
    const d = dirLabelParts(DIR);
    expect(d.tail).toBe('灵梦-少女之梦');
    expect(d.head.length).toBeLessThanOrEqual(27);
    expect(d.head.startsWith('C:\\game\\')).toBe(true);
  });

  it('只有一层目录 → 盘符留在 head、目录名进 tail（不编造分隔符）', () => {
    expect(dirLabelParts('D:\\发布')).toEqual({ head: 'D:', tail: '发布' });
  });

  it('空串与无分隔符都安全（调用侧传什么是它的自由）', () => {
    expect(dirLabelParts('')).toEqual({ head: '', tail: '' });
    expect(dirLabelParts('发布包')).toEqual({ head: '', tail: '发布包' });
  });
});
