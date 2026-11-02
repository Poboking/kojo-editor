/**
 * readme-gif.mjs 的纯函数护栏（2026-11-02 README 重构批）。
 *
 * 录制器本身要连浏览器与 ffmpeg，不适合在功能池里真跑；这里钉的是**会静默骗人**的那几格：
 * 1. 场景校验——动作名写错必须报，不能静默跳过一步（跳步的 GIF 看着"正常"，只是少了动作）；
 * 2. 编码档——`-framerate` 必须是**采样**帧率、`fps=` 滤镜才是编码帧率，两者一起降会把动画加速；
 * 3. 键表——功能键不能发 `char`（实测：给 F12 发 char 会把「F12」当字插进只读文件并弹出解锁框）；
 * 4. 出厂场景自检——每枚都得有 startSample/stopSample 且中间真有动作，否则录出来是张静图。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STEP_KINDS, ffmpegArgs, keyParams, nextAttempt, stepKind, validateScenario,
} from '../readme-gif.mjs';

const SCENARIO_DIR = fileURLToPath(new URL('../gif-scenarios', import.meta.url));
const scenarioFiles = () =>
  JSON.parse(readFileSync(path.join(SCENARIO_DIR, 'scenarios.json'), 'utf8'));

describe('场景校验', () => {
  it('合法场景零错误', () => {
    expect(validateScenario({
      name: 'x',
      steps: [{ cli: ['status'], allowFail: true }, { note: 'n', sleep: 10 }],
    })).toEqual([]);
  });

  it('动作名不认识时报出来（不静默跳过）', () => {
    const errs = validateScenario({ name: 'x', steps: [{ typoKind: 'open-file' }] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('typoKind');
  });

  it('steps 为空 / 缺 name 都判错', () => {
    expect(validateScenario({ steps: [] }).length).toBe(2);
  });

  it('修饰键与动作名同排时仍认得动作（allowFail 不抢 kind）', () => {
    expect(stepKind({ allowFail: true, cli: ['status'] })).toBe('cli');
    expect(stepKind({ note: '说明', sleep: 20 })).toBe('sleep');
    expect(stepKind({ note: '只有说明' })).toBe('note');
  });
});

describe('编码档', () => {
  it('降档序列：先降帧率再降宽度，第四档之后没有更多档', () => {
    expect(nextAttempt({ attempt: 0, fps: 8, width: 1100 })).toEqual({ fps: 8, width: 1100 });
    expect(nextAttempt({ attempt: 1, fps: 8, width: 1100 }).fps).toBe(6);
    expect(nextAttempt({ attempt: 2, fps: 8, width: 1100 })).toEqual({ fps: 6, width: 935 });
    expect(nextAttempt({ attempt: 3, fps: 8, width: 1100 })).toEqual({ fps: 4, width: 825 });
    expect(nextAttempt({ attempt: 4, fps: 8, width: 1100 })).toBeNull();
  });

  it('输入帧率用采样值、滤镜才用编码值（一起降会把动画加速）', () => {
    const args = ffmpegArgs({ framesDir: '/tmp/f', sampleFps: 8, fps: 4, width: 900, out: '/tmp/o.gif' });
    const at = (flag) => args[args.indexOf(flag) + 1];
    expect(at('-framerate')).toBe('8');
    const vf = at('-vf');
    expect(vf.startsWith('fps=4,')).toBe(true);
    expect(vf).toContain('scale=900:-1');
    expect(vf).toContain('palettegen');
    expect(vf).toContain('paletteuse');
  });
});

describe('键表', () => {
  it('功能键交回 keyCode 123 且 key 不是单字符（据此不发 char）', () => {
    const f12 = keyParams('f12');
    expect(f12).toMatchObject({ key: 'F12', keyCode: 123 });
    expect(f12.key.length === 1).toBe(false);
  });

  it('可打印符号按 US 布局给 code 与 shift 位', () => {
    expect(keyParams('#')).toMatchObject({ key: '#', code: 'Digit3', shift: true });
    expect(keyParams('_')).toMatchObject({ code: 'Minus', shift: true });
    expect(keyParams('a')).toMatchObject({ key: 'a', code: 'KeyA', shift: false });
    expect(keyParams(' ')).toMatchObject({ key: ' ', code: 'Space', keyCode: 32 });
  });

  it('光标键与 Esc 这类导航键在表内（改名框要按 End 才不会整名替换）', () => {
    expect(keyParams('end')).toMatchObject({ key: 'End', keyCode: 35 });
    expect(keyParams('home')).toMatchObject({ key: 'Home', keyCode: 36 });
    expect(keyParams('escape')).toMatchObject({ key: 'Escape', keyCode: 27 });
  });

  it('不认识的键如实交回 null（不静默丢键）', () => {
    expect(keyParams('‡')).toBeNull();
  });
});

describe('场景里的"会不会说谎"两条', () => {
  for (const file of scenarioFiles()) {
    it(`${file}：waitExpr / eval 不许用「?.x !== null」这种恒真判据`, () => {
      const src = readFileSync(path.join(SCENARIO_DIR, `${file}.json`), 'utf8');
      // `a?.b !== null` 在 a 缺席时是 `undefined !== null` ⇒ **恒真**：
      // 实测它把"弹层压根没出现"读成"弹层在场"，参数提示那张图就是这么假绿的。
      const tautology = /\?\.[A-Za-z_$][\w$]*(\?\.[A-Za-z_$][\w$]*)*\s*[!=]==?\s*null/.exec(src);
      expect(tautology, tautology ? `写法 ${tautology[0]} 恒真，改成 !!x 或 x !== undefined` : '').toBeNull();
    });
  }
});

describe('出厂场景自检', () => {
  const files = scenarioFiles();
  it('清单非空且每份都能解析', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} 形状合法且采帧窗口里有动作`, () => {
      const s = JSON.parse(readFileSync(path.join(SCENARIO_DIR, `${file}.json`), 'utf8'));
      expect(validateScenario(s)).toEqual([]);
      const kinds = s.steps.map((st) => stepKind(st));
      const start = kinds.indexOf('startSample');
      const stop = kinds.lastIndexOf('stopSample');
      expect(start, '缺 startSample').toBeGreaterThan(-1);
      expect(stop, '缺 stopSample').toBeGreaterThan(start);
      // 窗口里至少一枚"会动"的步（holdFrames 只算静帧，不能单独成窗）
      const movers = kinds.slice(start + 1, stop).filter(
        (k) => k !== 'holdFrames' && k !== 'note' && k !== 'sleep',
      );
      expect(movers.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('动作名白名单与实现处一致（加新动作忘了登记会红）', () => {
    const src = readFileSync(fileURLToPath(new URL('../readme-gif.mjs', import.meta.url)), 'utf8');
    for (const kind of STEP_KINDS) {
      expect(src.includes(`case '${kind}'`), `readme-gif.mjs 里没有 case '${kind}'`).toBe(true);
    }
  });
});
