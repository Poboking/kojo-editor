import { describe, expect, it } from 'vitest';
import type { CharaInfo, WorkspaceService } from '@kojo/plugin-api';
import {
  buildCreateInput,
  charaOptionLabel,
  defaultWorkspaceRoot,
  locationLabel,
  noKojoDirWarning,
  readRequestToken,
} from '../src/new-project-wizard';

/**
 * 「目标角色」文案单测（看板 HK-9，2026-10-13）。
 *
 * eraTW 的 CHARA 表把 MASTER 也当成 `Chara0.csv`（名前 = 你），它没有个人口上目录。
 * 旧向导让这个选项一路畅通到"部署被拒"才说话。口径是**说清后果、不删选项**：
 * 没有口上目录在新整合包里是常态（语料 168 张 CHARA 表 / 155 个口上目录），
 * 而这类包照样能写、能导出、能手工放置——只有"部署"这一条走不通，那就该那样说。
 */

const chara = (no: number, name: string, kojoDir?: string): CharaInfo =>
  kojoDir === undefined ? { no, name } : { no, name, kojoDir };

describe('charaOptionLabel（目标角色下拉文案）', () => {
  it('有口上目录的角色：只有编号与名字，不加任何后缀（155 个常态项不该被噪音淹掉）', () => {
    expect(charaOptionLabel(chara(1, '灵梦', 'C:/game/ERB/…/001 Reimu [霊夢]'))).toBe('#1 灵梦');
  });

  it('没有口上目录的角色：标出来，但**不删选项**（K0「你」就是这一类）', () => {
    const label = charaOptionLabel(chara(0, '你'));
    expect(label).toBe('#0 你 · 无个人口上目录');
    expect(label).toContain('#0');
    expect(label).toContain('你');
  });

  it('空串 kojoDir 也算"没有"（缺省值不该被当成有目录）', () => {
    expect(charaOptionLabel(chara(7, '妖梦', ''))).toContain('无个人口上目录');
  });
});

describe('noKojoDirWarning（选了无目录角色时的后果说明）', () => {
  it('没选角色 → null（向导刚打开不该先吓作者一条警告）', () => {
    expect(noKojoDirWarning(null)).toBeNull();
  });

  it('有口上目录 → null', () => {
    expect(noKojoDirWarning(chara(23, '妖梦', 'C:/game/…/023 Youmu'))).toBeNull();
  });

  it('无口上目录 → 说清"能写能导出，只有部署不行"，不夸大成"这个包没用"', () => {
    const w = noKojoDirWarning(chara(0, '你'));
    expect(w).not.toBeNull();
    const text = w!;
    expect(text).toContain('#0 你');
    expect(text).toContain('照常书写');
    expect(text).toContain('照常导出');
    expect(text).toContain('无法部署');
    // 同一个概念只允许一种说法：这句必须与 deploy.ts 拒绝原因用同一个名词短语
    expect(text).toContain('在游戏目录中没有个人口上目录');
    // 反向断言：不能把"能写"这条路一起否掉
    expect(text).not.toMatch(/无法创建|不能创建|没有意义/);
  });
});

/**
 * 关联号解析单测（2026-10-13 用户反馈 3 批）。
 *
 * 这个函数是「新建口上文件 → 跳去新建项目 → 回来自动落盘」这条链的第一颗螺丝：
 * 它决定这次开门**有没有**请求方。判错方向的代价不对称——
 * 误认成"有人在等"，会在一个作者没要过的项目里凭空多出一个文件；
 * 误认成"没人等"，最坏只是作者得自己再按一次 Ctrl+N。
 * 所以口径是**只认明确形状**，其余一律 null，不做任何"尽力解析"。
 */

describe('readRequestToken（新建项目向导的开门 payload）', () => {
  it('认得 { requestToken } 这一种形态', () => {
    expect(readRequestToken({ requestToken: 'kojo-m1abc-1' })).toBe('kojo-m1abc-1');
  });

  it('面板按钮开门没有 payload → null（这次创建与任何请求无关）', () => {
    expect(readRequestToken(undefined)).toBeNull();
    expect(readRequestToken(null)).toBeNull();
  });

  it('空串不算号（空号配不上任何东西，留着只会被误配）', () => {
    expect(readRequestToken({ requestToken: '' })).toBeNull();
  });

  it('非对象 / 字段类型不对 / 字段名打错，一律 null', () => {
    expect(readRequestToken('kojo-1')).toBeNull();
    expect(readRequestToken(42)).toBeNull();
    expect(readRequestToken([])).toBeNull();
    expect(readRequestToken({ requestToken: 7 })).toBeNull();
    expect(readRequestToken({ token: 'kojo-1' })).toBeNull();
    expect(readRequestToken({ requestToken: null })).toBeNull();
  });
});

/**
 * 项目位置（2026-10-14 自选位置批）。
 *
 * 判据的关键在**默认路径零变化**：没自选过连 `rootDir` 这个键都不该出现，
 * 于是内核走的就是历史上那条 `join(默认根, id)` 的老路，逐字不变。
 * 自选过才把路径递过去，而"这条路径能不能写"由内核按已授权名单核对——
 * 授权来自系统目录对话框（平台命令内完成），不是来自这个字段本身。
 */
const FORM = { workName: '  东方口上合集  ', authorName: '  张三  ', version: ' 1.0 ' };

describe('buildCreateInput（新建项目的落点入参）', () => {
  it('未自选位置：只有 name / meta，rootDir 键整个不出现', () => {
    const input = buildCreateInput(FORM, null);
    expect(input).toEqual({ name: '东方口上合集', meta: { author: '张三', version: '1.0' } });
    expect('rootDir' in input).toBe(false);
  });

  it('自选后：对话框回来的路径原样进 rootDir（消毒前后一致，不拼不裁）', () => {
    const input = buildCreateInput(FORM, 'D:\\我的作品库');
    expect(input.rootDir).toBe('D:\\我的作品库');
    expect(input.name).toBe('东方口上合集');
  });

  it('create 实收：假工作区收到的入参与 buildCreateInput 的产物一致（自选 / 未自选两条）', async () => {
    const seen: Array<{ name: string; meta: Record<string, unknown>; rootDir?: string }> = [];
    const workspaces = {
      rootDir: () => '/appdata/workspaces',
      roots: () => ['/appdata/workspaces', 'D:\\我的作品库'],
      create: async (input: {
        name: string;
        meta: Record<string, unknown>;
        rootDir?: string;
      }) => {
        seen.push(input);
        return { id: 'p1', name: input.name, createdAt: 1, updatedAt: 1, artifacts: [], meta: {} };
      },
    } as unknown as WorkspaceService;

    await workspaces.create(buildCreateInput(FORM, null));
    await workspaces.create(buildCreateInput(FORM, 'D:\\我的作品库'));

    expect(seen).toHaveLength(2);
    expect('rootDir' in seen[0]!).toBe(false);
    expect(seen[1]!.rootDir).toBe('D:\\我的作品库');
    // 名称/署名两条一路相同：自选位置不该改动作品本身
    expect(seen[1]!.name).toBe(seen[0]!.name);
    expect(seen[1]!.meta).toEqual(seen[0]!.meta);
  });
});

describe('locationLabel / defaultWorkspaceRoot（「项目位置」那行的文案）', () => {
  it('没自选过 → 明说"（默认）+ 默认根"，作者看得见自己东西落在哪', () => {
    expect(locationLabel(null, '/appdata/workspaces')).toBe('（默认）/appdata/workspaces');
  });

  it('自选过 → 直接给那条绝对路径（不再挂"默认"字样）', () => {
    expect(locationLabel('D:\\我的作品库', '/appdata/workspaces')).toBe('D:\\我的作品库');
  });

  it('默认根取不到（浏览器开发壳）→ 降级文案，不抛给作者', () => {
    expect(locationLabel(null, null)).toContain('位置暂不可用');
    const broken = {
      rootDir: () => {
        throw new Error('Workspace service is unavailable (no platform data directory)');
      },
    } as unknown as WorkspaceService;
    expect(defaultWorkspaceRoot(broken)).toBeNull();
    const working = {
      rootDir: () => '/appdata/workspaces',
    } as unknown as WorkspaceService;
    expect(defaultWorkspaceRoot(working)).toBe('/appdata/workspaces');
  });
});
