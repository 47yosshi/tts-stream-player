import { Session } from './session'
import type { AudioFormat } from './decoder'

export interface PlayerOptions {
  sampleRate: number
  channels?: number     // default: 1; MP3 では無視 (ストリーム内の値が使われる)
  minBufferMs?: number  // default: 100
  format?: AudioFormat  // default: 'pcm_16bit'
}

export class TTSStreamPlayer {
  private ctx: AudioContext | null = null
  private readonly options: Required<PlayerOptions>

  constructor(options: PlayerOptions) {
    this.options = {
      channels: 1,
      minBufferMs: 100,
      format: 'pcm_16bit',
      ...options,
    }
  }

  // Safari含む全ブラウザでの自動再生解除
  // ユーザー操作のコールバック内で呼ぶこと
  async unlock(): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: this.options.sampleRate })
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume()
    }
  }

  async play(stream: ReadableStream<Uint8Array>): Promise<Session> {
    if (!this.ctx) {
      throw new Error('Call unlock() before play()')
    }
    const session = new Session(
      this.ctx,
      stream,
      this.options.channels,
      this.options.minBufferMs,
      this.options.format,
    )
    session.start()
    return session
  }

  interrupt(): void {
    this.ctx?.suspend()
  }
}
