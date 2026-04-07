import { decodePCM } from './decoder'
import { Scheduler } from './scheduler'
import { BufferQueue } from './queue'

type EventType = 'start' | 'end' | 'buffering' | 'playing'

export class Session {
  private queue: BufferQueue
  private scheduler: Scheduler
  private handlers: Map<EventType, () => void> = new Map()
  private aborted = false
  private remainder: Uint8Array | null = null

  constructor(
    private ctx: AudioContext,
    private stream: ReadableStream<Uint8Array>,
    private channels: number,
    minBufferMs: number,
  ) {
    const minBufferSeconds = minBufferMs / 1000
    this.queue = new BufferQueue(minBufferSeconds)
    this.scheduler = new Scheduler(ctx, minBufferSeconds)
  }

  on(event: EventType, handler: () => void): this {
    this.handlers.set(event, handler)
    return this
  }

  cancel(): void {
    this.aborted = true
    this.queue.close()  // consumer の待機を即解除
    this.ctx.suspend()
  }

  async start(): Promise<void> {
    await Promise.all([this.produceLoop(), this.consumeLoop()])
  }

  private async produceLoop(): Promise<void> {
    const reader = this.stream.getReader()
    try {
      while (!this.aborted) {
        const { value, done } = await reader.read()
        if (done) break

        const chunk = this.remainder ? concat(this.remainder, value) : value
        const aligned = chunk.byteLength % 2 === 0
          ? chunk
          : chunk.subarray(0, chunk.byteLength - 1)
        this.remainder = chunk.byteLength % 2 === 0
          ? null
          : chunk.subarray(chunk.byteLength - 1)

        if (aligned.byteLength === 0) continue

        const float32 = decodePCM(aligned)
        const buf = this.ctx.createBuffer(this.channels, float32.length, this.ctx.sampleRate)
        buf.copyToChannel(float32, 0)
        this.queue.push(buf)
      }
    } finally {
      reader.releaseLock()
      this.queue.close()
    }
  }

  private async consumeLoop(): Promise<void> {
    // 初期バッファリング: minBufferMs 分溜まるまで待ってから再生開始
    await this.queue.waitForMinBuffer()

    if (this.aborted) return
    this.handlers.get('start')?.()

    while (!this.aborted && (!this.queue.closed || !this.queue.isEmpty)) {
      const buf = this.queue.shift()

      if (buf !== undefined) {
        this.scheduler.schedule(buf)
        continue
      }

      if (this.queue.closed) break

      // キューが空でストリームは継続中
      if (this.scheduler.isUnderflowed()) {
        console.log("under...flowed!")
        // 音声が実際に途切れた → アンダーフロー
        this.handlers.get('buffering')?.()
        await this.queue.waitForMinBuffer()
        if (!this.queue.closed && !this.aborted) {
          this.handlers.get('playing')?.()
        }
      } else {
        console.log("wait for any!")
        // スケジュール済み音声はまだある → ネットワーク遅延の吸収待ち
        await this.queue.waitForAny()
      }
    }

    this.handlers.get('end')?.()
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}
