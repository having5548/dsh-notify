// 生成 dsh-notify 的 32x32 ICO（24bpp BMP + 1bit AND 遮罩），供注册表 IconUri 使用。
// 画一个蓝色圆形 + 白色底部横条，视觉上像“通知”。
// 用法：node tools/generate-icon.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'assets', 'dsh-notify.ico')

const S = 32
const BLUE = [0x4c, 0x7e, 0xf3]
const WHITE = [0xff, 0xff, 0xff]

// 每个像素 (x, y) -> [r,g,b] 或 null(透明)
function pixel(x, y) {
  const cx = 15.5, cy = 15.5, r = 14.5
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy
  if (dx * dx + dy * dy > r * r) return null
  // 底部白色横条（通知条）
  if (y >= 21 && y <= 26 && x >= 7 && x <= 24) return WHITE
  return BLUE
}

// XOR 位图（bottom-up 行序，BGR 每像素 3 字节）
const xor = Buffer.alloc(S * S * 3)
// AND 遮罩（bottom-up，每行 4 字节）
const maskRowBytes = Math.ceil(S / 8) * 4 // 32bit = 4 bytes
const and = Buffer.alloc(S * maskRowBytes)
for (let row = 0; row < S; row++) {
  const srcY = S - 1 - row // bottom-up
  for (let x = 0; x < S; x++) {
    const c = pixel(x, srcY)
    const off = row * S * 3 + x * 3
    if (c) {
      xor[off] = c[2]     // B
      xor[off + 1] = c[1] // G
      xor[off + 2] = c[0] // R
    } else {
      // 透明：AND 位 = 1
      const byteIdx = row * maskRowBytes + Math.floor(x / 8)
      and[byteIdx] |= 0x80 >> (x % 8)
    }
  }
}

const bmpHeader = Buffer.alloc(40)
bmpHeader.writeUInt32LE(40, 0)          // biSize
bmpHeader.writeInt32LE(S, 4)            // biWidth
bmpHeader.writeInt32LE(S * 2, 8)        // biHeight (XOR+AND)
bmpHeader.writeUInt16LE(1, 12)          // biPlanes
bmpHeader.writeUInt16LE(24, 14)         // biBitCount
bmpHeader.writeUInt32LE(0, 16)          // biCompression

const image = Buffer.concat([bmpHeader, xor, and])
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0)   // reserved
header.writeUInt16LE(1, 2)   // type: icon
header.writeUInt16LE(1, 4)   // count
header.writeUInt8(S === 256 ? 0 : S, 6)  // width
header.writeUInt8(S === 256 ? 0 : S, 7)  // height
header.writeUInt8(0, 8)      // color count
header.writeUInt8(0, 9)      // reserved
header.writeUInt16LE(1, 10)  // planes
header.writeUInt16LE(24, 12) // bit count
header.writeUInt32LE(image.length, 14) // bytesInRes
header.writeUInt32LE(22, 18) // imageOffset

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.concat([header, image]))
console.log('wrote', OUT)
