/**
 * 生成 src-tauri/icons/icon.ico（程序化绘制"口"字标，无外部资源）。
 * 运行：node generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 绘制图标像素（RGBA，返回 size*size*4 的 Uint8Array） */
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const radius = size / 5;

  const insideRounded = (x, y) => {
    const rx = Math.min(x, size - 1 - x);
    const ry = Math.min(y, size - 1 - y);
    if (rx >= radius || ry >= radius) return true;
    const dx = radius - rx;
    const dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!insideRounded(x, y)) {
        set(x, y, 0, 0, 0, 0);
        continue;
      }
      // 背景：上下轻微渐变 #23272e -> #2c333c
      const t = y / size;
      set(x, y, Math.round(0x23 + t * 9), Math.round(0x27 + t * 12), Math.round(0x2e + t * 14), 255);
    }
  }

  // "口"字：方框 [30%, 70%]，线宽 9%
  const a = Math.round(size * 0.3);
  const b = Math.round(size * 0.7);
  const lw = Math.max(2, Math.round(size * 0.09));
  for (let y = a; y < b; y++) {
    for (let x = a; x < b; x++) {
      const border = x < a + lw || x >= b - lw || y < a + lw || y >= b - lw;
      if (!border) continue;
      // 蓝色渐变（左上亮 -> 右下深）
      const t = (x + y - 2 * a) / (2 * (b - a));
      set(x, y, Math.round(0x5c + t * 0x10 - t * 0x30), Math.round(0x9b - t * 0x2a), Math.round(0xf5 - t * 0x1f), 255);
    }
  }
  return px;
}

/** 单图像 BMP（ICO 内嵌格式：DIB 头 + BGRA 自下而上 + AND mask） */
function bmpForIco(px, size) {
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8); // XOR + AND
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      xor[dst] = px[src + 2];
      xor[dst + 1] = px[src + 1];
      xor[dst + 2] = px[src];
      xor[dst + 3] = px[src + 3];
    }
  }
  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size); // 全 0：透明度由 alpha 通道决定
  return Buffer.concat([dib, xor, and]);
}

const sizes = [32, 256];
const images = sizes.map((s) => bmpForIco(drawIcon(s), s));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);

let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});

mkdirSync(join(here), { recursive: true });
const ico = Buffer.concat([header, ...entries, ...images]);
writeFileSync(join(here, 'icon.ico'), ico);
console.log(`icon.ico written: ${ico.length} bytes (sizes: ${sizes.join(', ')})`);
