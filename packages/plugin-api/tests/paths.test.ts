import { describe, expect, it } from 'vitest';
import { basename, dirname, extname, isAbsolute, isLibraryOnlyPath, isPathUnder, join, normalize, pathKey, pathStyle, shortPath } from '../src/paths';

describe('路径工具 · win32', () => {
  it('风格判定', () => {
    expect(pathStyle('C:\\Game\\eratw')).toBe('win32');
    expect(pathStyle('C:/Game/eratw')).toBe('win32');
    expect(pathStyle('D:\\')).toBe('win32');
    expect(pathStyle('/home/user')).toBe('posix');
  });

  it('normalize 折叠分隔符与 . / ..', () => {
    expect(normalize('C:\\Game\\..\\Game\\eratw\\.\\ERB')).toBe('C:\\Game\\eratw\\ERB');
    expect(normalize('C:/Game/eratw/')).toBe('C:\\Game\\eratw');
    expect(normalize('C:\\..\\x')).toBe('C:\\x'); // 根之下 .. 忽略
  });

  it('join 保序拼接并归一化', () => {
    expect(join('C:\\Game', 'eratw', 'ERB')).toBe('C:\\Game\\eratw\\ERB');
    expect(join('C:\\Game\\', '\\口上', '個人口上')).toBe('C:\\Game\\口上\\個人口上');
  });

  it('dirname / basename / extname', () => {
    expect(dirname('C:\\Game\\eratw\\A.ERB')).toBe('C:\\Game\\eratw');
    expect(dirname('C:\\A.ERB')).toBe('C:\\');
    expect(basename('C:\\Game\\A.ERB')).toBe('A.ERB');
    expect(extname('C:\\Game\\A.ERB')).toBe('.ERB');
    expect(extname('C:\\Game\\noext')).toBe('');
    expect(extname('C:\\Game\\.hidden')).toBe('');
  });
});

describe('路径工具 · posix', () => {
  it('normalize / join', () => {
    expect(normalize('/a/b/../c')).toBe('/a/c');
    expect(join('/a', 'b', 'c.ERB')).toBe('/a/b/c.ERB');
    expect(dirname('/a/b')).toBe('/a');
    expect(basename('/a/b/c')).toBe('c');
  });

  it('相对路径的 .. 保留', () => {
    expect(normalize('a/../../b')).toBe('../b');
    expect(normalize('../x')).toBe('../x');
  });
});

describe('isPathUnder（可写白名单的核心判定）', () => {
  it('win32 大小写不敏感', () => {
    expect(isPathUnder('C:\\Game\\eratw', 'c:\\game\\ERATW\\ERB\\x.ERB')).toBe(true);
    expect(isPathUnder('C:\\Game\\eratw', 'C:\\Game\\eratw2\\x.ERB')).toBe(false);
    expect(isPathUnder('C:\\Game\\eratw', 'C:\\Game\\eratw')).toBe(true);
  });

  it('posix 大小写敏感', () => {
    expect(isPathUnder('/home/u/eratw', '/home/u/eratw/a')).toBe(true);
    expect(isPathUnder('/home/u/eratw', '/home/u/ERATW/a')).toBe(false);
  });

  it('空父路径拒绝一切', () => {
    expect(isPathUnder('', 'C:\\anything')).toBe(false);
  });
});

describe('isAbsolute / pathKey', () => {
  it('isAbsolute', () => {
    expect(isAbsolute('C:\\a')).toBe(true);
    expect(isAbsolute('/a')).toBe(true);
    expect(isAbsolute('a\\b')).toBe(false);
    expect(isAbsolute('a/b')).toBe(false);
  });

  it('pathKey 用于缓存键：win32 折叠大小写', () => {
    expect(pathKey('C:\\Game\\A.erb')).toBe(pathKey('c:\\game\\a.ERB'));
    expect(pathKey('/A/File')).toBe('/A/File');
  });
});

describe('isLibraryOnlyPath（只读基座库范围判据：作者视图按它排除）', () => {
  const project = { kojoPaths: ['C:\\Game\\eratw\\ERB\\口上\\個人口上'], libraryPaths: ['C:\\Game\\eratw\\ERB'] };

  it('基座内、口上外 ⇒ true（基础库文件不该进作者视图）', () => {
    expect(isLibraryOnlyPath(project, 'C:\\Game\\eratw\\ERB\\SYSTEM\\base.ERB')).toBe(true);
  });

  it('嵌套在口上根内 ⇒ false（作者范围优先，基座是它的祖先）', () => {
    expect(isLibraryOnlyPath(project, 'C:\\Game\\eratw\\ERB\\口上\\個人口上\\001\\a.ERB')).toBe(false);
  });

  it('基座之外 ⇒ false', () => {
    expect(isLibraryOnlyPath(project, 'C:\\Game\\eratw\\CSV\\x.csv')).toBe(false);
  });

  it('缺 libraryPaths（旧适配器）⇒ 恒 false：零回归', () => {
    expect(isLibraryOnlyPath({ kojoPaths: ['C:\\Game\\kojo'] }, 'C:\\Game\\kojo\\a.ERB')).toBe(false);
    expect(isLibraryOnlyPath(null, 'C:\\Game\\kojo\\a.ERB')).toBe(false);
    expect(isLibraryOnlyPath(undefined, 'C:\\Game\\kojo\\a.ERB')).toBe(false);
  });

  it('win32 大小写不敏感（与 isPathUnder 同一判据，不另抄一份）', () => {
    expect(isLibraryOnlyPath(project, 'c:/game/ERATW/erb/base.erb')).toBe(true);
  });
});

describe('shortPath（面板行内短显示：末两段，输出统一 / 形态）', () => {
  it('两种分隔符都切，输出走 POSIX', () => {
    expect(shortPath('C:\\Game\\Chara\\001\\erl.ERB')).toBe('001/erl.ERB');
    expect(shortPath('/game/chara/a.ERB')).toBe('chara/a.ERB');
    expect(shortPath('a.ERB')).toBe('a.ERB');
  });

  it('不折叠 `..`、不改大小写（短显示不是判等，判等走 pathKey）', () => {
    expect(shortPath('C:\\Game\\..\\A.erb')).toBe('../A.erb');
    expect(shortPath('C:\\A\\B.ERB')).toBe('A/B.ERB');
  });
});
