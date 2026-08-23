// 生成 dsh-notify 的通知提示音（无版权、自包含）：一个柔和的双音“叮-咚” chime。
// 用法：node tools/generate-audio.mjs
// 输出：assets/notify.wav（44.1kHz / 16bit / 单声道，约 1.2s）
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'assets', 'notify.wav')

const SAMPLE_RATE = 44100
const DURATION = 1.15

// 两个音符：(频率, 起始秒, 时长秒, 相对振幅)
const NOTES = [
  [880.0, 0.00, 0.42, 1.0],   // A5
  [1318.5, 0.14, 0.62, 0.9],  // E6（大六度上行）
]

function synth() {
  const total = Math.floor(SAMPLE_RATE * DURATION)
  const buf = new Float32Array(total)
  const add = (freq, startSec, durSec, amp) => {
    const start = Math.floor(startSec * SAMPLE_RATE)
    const n = Math.floor(durSec * SAMPLE_RATE)
    for (let i = 0; i < n; i++) {
      const idx = start + i
      if (idx >= total) break
      const t = i / SAMPLE_RATE
      const env = Math.exp(-2.6 * t / Math.max(durSec, 0.01)) * Math.min(1, t / 0.008)
      const phase = 2 * Math.PI * freq * t
      // 基频 + 柔和泛音
      const v = (Math.sin(phase) + 0.32 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase)) / 1.42
      buf[idx] += v * env * amp
    }
  }
  for (const [f, s, d, a] of NOTES) add(f, s, d, a)
  // 简单回声（模拟钟声的余韵）
  const echoDelay = Math.floor(0.28 * SAMPLE_RATE)
  const echoGain = 0.34
  for (let i = echoDelay; i < total; i++) {
    buf[i] += buf[i - echoDelay] * echoGain
  }
  // 归一化到 0.55 峰值
  let peak = 0
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]))
  if (peak > 0) {
    const g = 0.55 / peak
    for (let i = 0; i < total; i++) buf[i] *= g
  }
  return buf
}

function wavBytes(pcm) {
  const dataSize = pcm.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)      // PCM
  buffer.writeUInt16LE(1, 22)      // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buffer
}

mkdirSync(path.dirname(OUT), { recursive: true })
const bytes = wavBytes(synth())
writeFileSync(OUT, bytes)
console.log('wrote', OUT, bytes.length, 'bytes')
