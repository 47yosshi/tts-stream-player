import { decodePCM } from './decoder'
import { Scheduler } from './scheduler'

type EventType = 'start' | 'end'

export class Session {
  private scheduler: Scheduler
  private handlers: Map<EventType, () => void> = new Map()
  private aborted = false
  private remainder: Uint8Array | null = null  // 前chunkの余りバイト

  constructor(
    private ctx: AudioContext,
    private stream: ReadableStream<Uint8Array>,
    private channels: number,
  ) {
    this.scheduler = new Scheduler(ctx)
  }

  on(event: EventType, handler: () => void): this {
    this.handlers.set(event, handler)
    return this
  }

  cancel(): void {
    this.aborted = true
    this.ctx.suspend()
  }

  async start(): Promise<void> {
    const reader = this.stream.getReader()
    let started = false
    //this.handlers.get('start')?.()

    try {
      while (true) {
        if (this.aborted) break
        const { value, done } = await reader.read()
        if (done) break

        // 前chunkの余りバイトと結合
        const chunk = this.remainder
          ? concat(this.remainder, value)
          : value

        // 奇数バイトなら末尾1バイトを次回に持ち越す
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
        this.scheduler.schedule(buf)

        if (!started) {
            started = true
            this.handlers.get('start')?.()
        }
      }
    } finally {
      reader.releaseLock()
      this.handlers.get('end')?.()
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}