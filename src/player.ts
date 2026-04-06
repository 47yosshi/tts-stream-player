import { Session } from './session'

export interface PlayerOptions {
  sampleRate: number
  channels?: number  // default: 1
}

export class TTSStreamPlayer {
  private ctx: AudioContext | null = null
  private readonly options: Required<PlayerOptions>

  constructor(options: PlayerOptions) {
    this.options = {
      channels: 1,
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
    const session = new Session(this.ctx, stream, this.options.channels)
    session.start()
    return session
  }

  interrupt(): void {
    this.ctx?.suspend()
  }
}