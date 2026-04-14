import { decodePCM, extractCompleteFrames, extractTailFrames, countFrameSamples, parseWavHeader, WAV_HEADER_MIN_SIZE, type AudioFormat } from './decoder'
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
    private format: AudioFormat = 'pcm_16bit',
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
    const produce = this.format === 'mp3'
      ? this.produceLoopMP3()
      : this.format === 'wav'
      ? this.produceLoopWAV()
      : this.produceLoopPCM()
    await Promise.all([produce, this.consumeLoop()])
  }

  private async produceLoopPCM(): Promise<void> {
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

  private async produceLoopWAV(): Promise<void> {
    const reader = this.stream.getReader()
    let accumulated = new Uint8Array(0)
    let headerParsed = false
    let wavChannels = this.channels
    let wavSampleRate = this.ctx.sampleRate
    let remainder: Uint8Array | null = null

    // WAV PCM をデコードしてキューに積む。
    // チャンネル数に応じてインターリーブ解除を行う。
    const processPCM = (data: Uint8Array): void => {
      const chunk = remainder ? concat(remainder, data) : data
      const frameBytes = wavChannels * 2  // 16-bit × channels
      const alignedLen = chunk.byteLength - (chunk.byteLength % frameBytes)
      remainder = alignedLen < chunk.byteLength ? chunk.subarray(alignedLen) : null
      const aligned = chunk.subarray(0, alignedLen)
      if (aligned.byteLength === 0) return

      const float32 = decodePCM(aligned)
      const samplesPerChannel = float32.length / wavChannels
      const buf = this.ctx.createBuffer(wavChannels, samplesPerChannel, wavSampleRate)
      if (wavChannels === 1) {
        buf.copyToChannel(float32, 0)
      } else {
        // インターリーブ PCM (L0,R0,L1,R1,...) → チャンネルごとに分離
        for (let c = 0; c < wavChannels; c++) {
          const ch = new Float32Array(samplesPerChannel)
          for (let i = 0; i < samplesPerChannel; i++) ch[i] = float32[i * wavChannels + c]
          buf.copyToChannel(ch, c)
        }
      }
      this.queue.push(buf)
    }

    // チャンクが RIFF WAV ヘッダーで始まる場合はヘッダーをスキップして PCM 部分を返す。
    // そうでなければそのまま返す。
    const stripWavHeader = (chunk: Uint8Array): Uint8Array => {
      if (chunk.byteLength >= WAV_HEADER_MIN_SIZE) {
        const parsed = parseWavHeader(chunk)  // 非対応フォーマットはスロー
        if (parsed !== null) return chunk.subarray(parsed.dataOffset)
      }
      return chunk
    }

    try {
      while (!this.aborted) {
        const { value, done } = await reader.read()
        if (done) break

        if (!headerParsed) {
          // チャンク境界でヘッダーが分断される可能性があるため 44 バイト溜まるまで蓄積
          accumulated = concat(accumulated, value)
          if (accumulated.byteLength < WAV_HEADER_MIN_SIZE) continue

          if (accumulated[0] === 0x52 && accumulated[1] === 0x49 &&
              accumulated[2] === 0x46 && accumulated[3] === 0x46) {
            // "RIFF" マジック検出 → WAV ヘッダーとして解析
            const parsed = parseWavHeader(accumulated)  // 非対応フォーマットはスロー
            if (parsed === null) throw new Error('WAV error: "data" chunk not found in header')
            wavChannels = parsed.channels
            wavSampleRate = parsed.sampleRate
            headerParsed = true
            const pcm = accumulated.subarray(parsed.dataOffset)
            if (pcm.byteLength > 0) processPCM(pcm)
          } else {
            // RIFF マジックなし → ヘッダーなし PCM として扱う
            headerParsed = true
            processPCM(accumulated)
          }
          continue
        }

        // 毎チャンクに WAV ヘッダーが付くケース: RIFF マジックがあればヘッダーをスキップ
        processPCM(stripWavHeader(value))
      }
    } finally {
      reader.releaseLock()
      this.queue.close()
    }
  }

  private async produceLoopMP3(): Promise<void> {
    const reader = this.stream.getReader()
    let accumulated = new Uint8Array(0)
    // 前バッチ末尾フレーム: MP3 ビットリザーバーのコンテキストとして次バッチに付与する
    let overlapFrames: Uint8Array<ArrayBuffer> | null = null
    let overlapSamples = 0

    const decodeAndQueue = async (framesData: Uint8Array<ArrayBuffer>): Promise<void> => {
      // オーバーラップフレームを先頭に付与してデコード
      const input = overlapFrames ? concat(overlapFrames, framesData) : framesData
      const skipSamples = overlapSamples

      // 次バッチ用にオーバーラップを更新 (await より前に確定)
      overlapFrames = extractTailFrames(framesData, MP3_OVERLAP_FRAMES)
      overlapSamples = countFrameSamples(overlapFrames)

      const arrayBuffer = (input.buffer as ArrayBuffer).slice(
        input.byteOffset,
        input.byteOffset + input.byteLength,
      )
      const raw = await this.ctx.decodeAudioData(arrayBuffer)
      // オーバーラップ分 (前バッチのコンテキスト音声) を先頭からカット
      const buf = skipSamples > 0 ? trimAudioBuffer(raw, skipSamples, this.ctx) : raw
      if (!this.aborted && buf !== null) this.queue.push(buf)
    }

    try {
      while (!this.aborted) {
        const { value, done } = await reader.read()
        if (value) accumulated = concat(accumulated, value)

        const { framesData, remainder } = extractCompleteFrames(accumulated)
        accumulated = remainder

        if (framesData) {
          try { await decodeAndQueue(framesData) } catch { /* 無効データは無視して続行 */ }
        }

        if (done) break
      }

      // ストリーム終端: 残留バイトをフラッシュ (通常はほぼ空)
      if (!this.aborted && accumulated.byteLength > 0) {
        const arrayBuffer = (accumulated.buffer as ArrayBuffer).slice(
          accumulated.byteOffset,
          accumulated.byteOffset + accumulated.byteLength,
        )
        try {
          const raw = await this.ctx.decodeAudioData(arrayBuffer)
          const buf = overlapSamples > 0 ? trimAudioBuffer(raw, overlapSamples, this.ctx) : raw
          if (buf !== null) this.queue.push(buf)
        } catch { /* 無視 */ }
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
        // 音声が実際に途切れた → アンダーフロー
        this.handlers.get('buffering')?.()
        await this.queue.waitForMinBuffer()
        if (!this.queue.closed && !this.aborted) {
          this.handlers.get('playing')?.()
        }
      } else {
        // スケジュール済み音声はまだある → ネットワーク遅延の吸収待ち
        await this.queue.waitForAny()
      }
    }

    this.handlers.get('end')?.()
  }
}

// ビットリザーバーをカバーするために前バッチから引き継ぐフレーム数。
// 128kbps では最大 ~6 フレーム分のリザーバーが必要。16 で余裕を持たせる。
const MP3_OVERLAP_FRAMES = 16

/**
 * AudioBuffer の先頭 samples サンプルを除いた新しい AudioBuffer を返す。
 * samples >= buf.length の場合は null。
 */
function trimAudioBuffer(buf: AudioBuffer, samples: number, ctx: AudioContext): AudioBuffer | null {
  const skip = Math.min(samples, buf.length)
  const newLength = buf.length - skip
  if (newLength <= 0) return null
  const out = ctx.createBuffer(buf.numberOfChannels, newLength, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).subarray(skip), c)
  }
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}
