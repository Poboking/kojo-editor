/**
 * 台词替换的判据面。
 *
 * 重点不是"能替换"，而是**替换的边界**：认得出来的换成值，认不出来的原样留着
 * 并进 `unresolved`；随机记号取首项但**不假装确定**（原记号照样上报）。
 * 真盘用例只数"方括号名字族"的替换量级——它们占语料记号的大头，最能反映退化。
 */

import { describe, expect, it } from 'vitest';
import { previewKojoCommand } from '../../src/preview';
import { interpolateKojoText } from '../../src/preview/interpolate';
import { hasKojoCorpus, readKojoCorpusFile, sampleKojoXmlFiles } from './corpus';

describe('interpolateKojoText —— 名字族', () => {
  it('%CALLNAME:MASTER% 用 callName（不是 playerName）', () => {
    const result = interpolateKojoText('「%CALLNAME:MASTER%，欢迎」', {
      callName: 'ご主人様',
      playerName: '玩家',
    });
    expect(result.text).toBe('「ご主人様，欢迎」');
    expect(result.unresolved).toEqual([]);
  });

  it('%CALLNAME:123% 角色号用 charaName', () => {
    const result = interpolateKojoText('%CALLNAME:123%笑了', { charaName: 'アリス' });
    expect(result.text).toBe('アリス笑了');
    expect(result.unresolved).toEqual([]);
  });

  it('%CALLNAME:[$KC]% 是动态实参 → 原样保留并上报', () => {
    const result = interpolateKojoText('%CALLNAME:[$KC]%', { charaName: 'アリス' });
    expect(result.text).toBe('%CALLNAME:[$KC]%');
    expect(result.unresolved).toEqual(['%CALLNAME:[$KC]%']);
  });

  it('%CNAME% 取角色名、%NAME% 取主人公名（一条句子里各换一次）', () => {
    const result = interpolateKojoText('%CNAME%对%NAME%说', { charaName: 'アリス', playerName: '玩家' });
    expect(result.text).toBe('アリス对玩家说');
    expect(result.unresolved).toEqual([]);
  });

  it('方括号族：[$MNAME]→主人公、[$KNAME]/[$NAME]→角色、[$PNAME]→主人公', () => {
    const result = interpolateKojoText('[$MNAME]看着[$KNAME]，[$NAME]低头，[$PNAME]叹气', {
      playerName: '玩家',
      charaName: 'アリス',
    });
    expect(result.text).toBe('玩家看着アリス，アリス低头，玩家叹气');
    expect(result.unresolved).toEqual([]);
  });

  it('vars 覆盖内置别名（[$W] 与显式覆盖 [$MNAME]）', () => {
    const result = interpolateKojoText('[$W]边的[$MNAME]', {
      playerName: '玩家',
      vars: { W: '墙', MNAME: '主人（覆盖）' },
    });
    expect(result.text).toBe('墙边的主人（覆盖）');
    expect(result.unresolved).toEqual([]);
  });

  it('上下文缺失时名字记号原样保留并上报（不替换成空串）', () => {
    const result = interpolateKojoText('%CALLNAME:MASTER%和[$MNAME]');
    expect(result.text).toBe('%CALLNAME:MASTER%和[$MNAME]');
    expect(result.unresolved).toEqual(['%CALLNAME:MASTER%', '[$MNAME]']);
  });
});

describe('interpolateKojoText —— 随机取项', () => {
  it('%S_R("a/b/c")% 取首项 a，原记号进 unresolved 供标注"随机"', () => {
    const result = interpolateKojoText('「%S_R("a/b/c")%」');
    expect(result.text).toBe('「a」');
    expect(result.unresolved).toEqual(['%S_R("a/b/c")%']);
  });

  it('%S_R(@"我/人家")% 的 @ 逐字写法同样取首项', () => {
    const result = interpolateKojoText('%S_R(@"我/人家")%说');
    expect(result.text).toBe('我说');
    expect(result.unresolved).toEqual(['%S_R(@"我/人家")%']);
  });

  it('只有一项的 %S_R("唯一")% 没有随机性 → 不误报', () => {
    const result = interpolateKojoText('%S_R("唯一")%');
    expect(result.text).toBe('唯一');
    expect(result.unresolved).toEqual([]);
  });

  it('随机首项里嵌的记号会被继续解释（%NAME% → 玩家），不把整段当死文本', () => {
    const result = interpolateKojoText('%S_R(@"%NAME%也/一起")%', { playerName: '玩家' });
    expect(result.text).toBe('玩家也');
    expect(result.unresolved).toEqual(['%S_R(@"%NAME%也/一起")%']);
  });
});

describe('interpolateKojoText —— 认不出来就不吞', () => {
  it('函数调用 %ANAME([$KC])% 原样保留并上报', () => {
    const result = interpolateKojoText('%ANAME([$KC])%', { charaName: 'アリス' });
    expect(result.text).toBe('%ANAME([$KC])%');
    expect(result.unresolved).toEqual(['%ANAME([$KC])%']);
  });

  it('音效记号 [$SE:Water_0.mp3] 不是名字 → 原样保留并上报', () => {
    const result = interpolateKojoText('[$SE:Water_0.mp3]水声');
    expect(result.text).toBe('[$SE:Water_0.mp3]水声');
    expect(result.unresolved).toEqual(['[$SE:Water_0.mp3]']);
  });

  it('同一记号重复 3 次只报 1 条（去重保首次顺序）', () => {
    const result = interpolateKojoText('%X%%X%%X%');
    expect(result.text).toBe('%X%%X%%X%');
    expect(result.unresolved).toEqual(['%X%']);
  });

  it('空文本 / 无记号文本 → unresolved 为空', () => {
    expect(interpolateKojoText('')).toEqual({ text: '', unresolved: [] });
    expect(interpolateKojoText('「没有记号」')).toEqual({ text: '「没有记号」', unresolved: [] });
  });
});

describe('previewKojoCommand —— 三面合一', () => {
  it('CRLF 台词拆成 2 行、条件 3 条、未解析 1 条', () => {
    const result = previewKojoCommand(
      {
        attrs: {
          com: '300',
          kojoPlace: 'TOP',
          eval: '{TSTR:X == "Y"}',
          isFall: 'LOVER,!SLAVE',
          emotion: 'GOOD',
        },
        text: '「[$MNAME]」\r\n「%ANAME([$KC])%」',
      },
      { playerName: '玩家' },
    );
    expect(result.lines).toEqual(['「玩家」', '「%ANAME([$KC])%」']);
    expect(result.conditions).toHaveLength(4);
    expect(result.unresolved).toEqual(['%ANAME([$KC])%']);
  });

  it('空条目 → lines 为空数组（不是 [""]），条件与未解析都为空', () => {
    expect(previewKojoCommand({ attrs: {}, text: '' })).toEqual({
      lines: [],
      conditions: [],
      unresolved: [],
    });
  });
});

describe('真盘读数（守卫：D:/Game/erafl/ERB/口上 存在才跑）', () => {
  it.skipIf(!hasKojoCorpus)('20 份抽样：[$MNAME] 277 处 / [$KNAME] 56 处全部换成名字，零残留', () => {
    const files = sampleKojoXmlFiles(20);
    expect(files).toHaveLength(20);

    let mname = 0;
    let kname = 0;
    let leftover = 0;

    for (const path of files) {
      const file = readKojoCorpusFile(path);
      for (const command of file.commands) {
        mname += (command.text.match(/\[\$MNAME\]/g) ?? []).length;
        kname += (command.text.match(/\[\$KNAME\]/g) ?? []).length;
        if (!command.text.includes('[$MNAME]') && !command.text.includes('[$KNAME]')) continue;

        const result = interpolateKojoText(command.text, {
          playerName: '主人公',
          charaName: '角色',
        });
        leftover += (result.text.match(/\[\$(?:M|K)NAME\]/g) ?? []).length;
        expect(result.unresolved).not.toContain('[$MNAME]');
        expect(result.unresolved).not.toContain('[$KNAME]');
      }
    }

    expect(mname).toBeGreaterThanOrEqual(200);
    expect(kname).toBeGreaterThanOrEqual(40);
    expect(leftover).toBe(0);
  });
});
