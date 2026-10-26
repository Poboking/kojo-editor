/**
 * eraAV `loadProject` 判据（P1 的最小回路：角色索引 + 口上面 + 摘要 + 可写域）。
 *
 * 钉的是四件最容易写错的事：
 * ① **不设 `kojoDir`**——本作口上是 `ERB/Lines/` 下的扁平文件，把公共父目录塞进
 *    `CharaInfo.kojoDir` 会让「按角色收窄检索」变成「按整个 Lines 搜」，是**给出错结果**
 *    而不是「少一个功能」（文件头注写明理由，这里钉住它别被后人"顺手补上"）；
 * ② 可写域只有 `ERB/Lines`，其余（含 `附件/` 那棵补丁树）一律只读；
 * ③ Chara CSV 读不到 / 番号缺失时**跳过并 warn**，不建假条目；
 * ④ `inputDigest` 必须把「非 ERB 输入」（Chara 正文 + 口上文件名 + 变量字典）折进去，
 *    缺了它下游派生缓存会拿着旧字典出新品。
 */

import { existsSync } from 'node:fs';
import { join } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { loadEraavVariableSchema } from '../src/variable-schema';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const ROOT = 'D:/mem/eraAV';

function synth(): ReturnType<typeof memIo> {
  return memIo(
    {
      [`${ROOT}/CSV/GameBase.csv`]: 'タイトル,Erav优化整合版\r\n',
      [`${ROOT}/ERB/EVENT/EVENT_K.ERB`]: '@EVENTTRAIN\r\n',
      [`${ROOT}/CSV/Chara/Chara1_甲.csv`]: '番号,1\r\n名前,甲子\r\n呼び名,甲\r\n',
      [`${ROOT}/CSV/Chara/Chara0.csv`]: '番号,0\r\n名前,あなた\r\n',
      // 没有番号行、文件名也没号：必须被跳过（而不是编号 0 的假条目）
      [`${ROOT}/CSV/Chara/Chara_坏.csv`]: '名前,坏\r\n',
      [`${ROOT}/ERB/Lines/EVENT_K01_甲.ERB`]: '@KOJO_MESSAGE_COM_1\r\n',
      [`${ROOT}/ERB/Lines/想达成调教结束后表白效果.txt`]: '不是 ERB\r\n',
      [`${ROOT}/CSV/Train.csv`]: '0,素股\r\n1,手コキ\r\n',
    },
    [`${ROOT}/CSV/Chara`, `${ROOT}/ERB/Lines`, `${ROOT}/ERB`],
  );
}

describe('loadProject —— 合成工程', () => {
  it('角色索引按 CSV 建、坏文件跳过、kojoDir 一律不建', async () => {
    const adapter = adapterOf(synth());
    const project = await adapter.loadProject(ROOT);
    expect(project.adapterId).toBe('eraav');
    expect([...project.charaIndex.keys()].sort()).toEqual([0, 1]);
    expect(project.charaIndex.get(1)?.name).toBe('甲子'); // 名前 行优先于文件名段
    expect(project.charaIndex.get(0)?.name).toBe('あなた');
    // ① 本作没有角色口上目录：任何角色都不许带 kojoDir
    for (const [no, info] of project.charaIndex) expect(info.kojoDir, String(no)).toBeUndefined();
  });

  it('可写域只有 `ERB/Lines`；索引吃整棵 ERB；无 savDir', async () => {
    const project = await adapterOf(synth()).loadProject(ROOT);
    expect(project.writablePaths).toEqual([join(ROOT, 'ERB', 'Lines')]);
    expect(project.kojoPaths).toEqual([join(ROOT, 'ERB')]);
    expect(project.savDir).toBeUndefined();
  });

  it('④ 非 ERB 输入折进 inputDigest（缺了它派生缓存会拿旧字典出新品）', async () => {
    const project = await adapterOf(synth()).loadProject(ROOT);
    expect(typeof project.inputDigest).toBe('string');
    expect(project.inputDigest!.length).toBeGreaterThan(0);
  });
});

describe('loadProject —— 真盘（C:/game/eraAV）', () => {
  it.skipIf(!hasCorpus)('角色 120 份 CSV 全建上、口上扁平文件不进 kojoDir', async () => {
    const adapter = adapterOf(nodeIo());
    expect(await adapter.detect(GAME_ROOT)).toMatchObject({ matched: true });
    const project = await adapter.loadProject(GAME_ROOT);
    // 实测 120/120 番号与文件名前导号一致且全局唯一 ⇒ 角色数就是 120
    expect(project.charaIndex.size).toBe(120);
    expect(project.charaIndex.get(1)?.name).toBe('宫间奏美'); // 中文名（汉化盘）
    for (const info of project.charaIndex.values()) expect(info.kojoDir).toBeUndefined();
    expect(project.writablePaths).toEqual([join(GAME_ROOT, 'ERB', 'Lines')]);
    expect(typeof project.inputDigest).toBe('string');
  });

  it.skipIf(!hasCorpus)(
    '变量字典装载器在真盘上不抛（`loadProject` 把失败吞成「本次无字典」，这里必须让它现形）',
    async () => {
      const noise: string[] = [];
      const log = {
        debug: () => {},
        info: () => {},
        warn: (m: string) => noise.push(m),
        error: (m: string) => noise.push(m),
      };
      const schema = await loadEraavVariableSchema({
        io: nodeIo(),
        csvDir: join(GAME_ROOT, 'CSV'),
        erbDir: join(GAME_ROOT, 'ERB'),
        log,
      });
      expect(noise, `加载器告警：${noise.join(' | ')}`).toEqual([]);
      // 实测 12 份 `.csv` ⇒ 族在；`CFLAG` 表在本盘不存在 ⇒ 查它是 undefined，
      // 而不是「拿 eraTW 的 CFLAG 名字表顶上去」
      expect(schema.lookup('TALENT'), '真盘 TALENT.csv 有 262 条，族应在').toBeDefined();
      expect(schema.lookup('CFLAG'), '本盘没有 CFLAG 表：族必须缺席（不借别游戏的名）').toBeUndefined();
      expect(typeof schema.inputDigest).toBe('string');
    },
  );

  it.skipIf(!hasCorpus)('缺 CFLAG 四表时查名不抛，指令名表带得上', async () => {
    const adapter = adapterOf(nodeIo());
    await adapter.loadProject(GAME_ROOT);
    // 字典与指令表挂在 adapter 的 getter 上（`loadProject` 只回工程载荷）
    const schema = adapter.variableSchema;
    expect(schema, '真盘变量字典缺席（上一条会指出为什么）').toBeDefined();
    expect(schema!.lookup('CFLAG')).toBeUndefined();
    expect(adapter.kojoInstructionTable?.hasTable).toBe(true);
  });
});
