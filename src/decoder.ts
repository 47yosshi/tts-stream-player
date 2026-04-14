export type AudioFormat = 'pcm_16bit' | 'mp3' | 'wav'

// ---- WAV ヘッダー解析 ----

/** WAV ヘッダーのパースに必要な最小バイト数（標準 PCM WAV の場合）*/
export const WAV_HEADER_MIN_SIZE = 44

export interface WavHeader {
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** PCM データが始まるバイトオフセット（"data" チャンクヘッダーの直後）*/
  dataOffset: number
}

/**
 * バイト列から WAV ヘッダーを解析する。
 *
 * - RIFF/WAVE マジックがない場合は null を返す（WAV ファイルでない）
 * - RIFF/WAVE だが PCM 16-bit 以外のフォーマットはエラーをスローする
 * - "data" チャンクがバッファ内に見つからない場合は null を返す
 */
export function parseWavHeader(data: Uint8Array): WavHeader | null {
  if (data.byteLength < 12) return null
  // "RIFF" magic
  if (data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46) return null
  // "WAVE" format
  if (data[8] !== 0x57 || data[9] !== 0x41 || data[10] !== 0x56 || data[11] !== 0x45) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1

  while (offset + 8 <= data.byteLength) {
    const id = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
    const size = view.getUint32(offset + 4, true)  // little-endian
    const contentStart = offset + 8

    if (id === 'fmt ') {
      if (contentStart + 16 > data.byteLength) return null  // fmt チャンクが截断されている
      const audioFormat = view.getUint16(contentStart, true)
      if (audioFormat !== 1) {
        throw new Error(`WAV error: unsupported audio format ${audioFormat} (only PCM=1 is supported)`)
      }
      channels = view.getUint16(contentStart + 2, true)
      sampleRate = view.getUint32(contentStart + 4, true)
      bitsPerSample = view.getUint16(contentStart + 14, true)
      if (bitsPerSample !== 16) {
        throw new Error(`WAV error: unsupported bit depth ${bitsPerSample} (only 16-bit is supported)`)
      }
    } else if (id === 'data') {
      dataOffset = contentStart
      break
    }

    // WAV チャンクはバイト境界 (偶数) にパディングされる
    offset = contentStart + size + (size & 1)
  }

  if (dataOffset === -1 || channels === 0 || sampleRate === 0) return null
  return { channels, sampleRate, bitsPerSample, dataOffset }
}

// ---- PCM デコード ----

export function decodePCM(chunk: Uint8Array): Float32Array<ArrayBuffer> {
  // 16bit符号付き整数 → Float32 (-1.0 〜 1.0) に変換
  const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
  const float32 = new Float32Array(int16.length) as Float32Array<ArrayBuffer>
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768
  }
  return float32
}

// ---- MP3 フレーム解析 ----

// MPEG1 Layer3 のビットレートテーブル (kbps)
const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
// MPEG2/2.5 Layer3 のビットレートテーブル (kbps)
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

// mpegVersionBits → サンプルレートテーブル (Hz)
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
}

/**
 * offset 位置の MP3 フレームヘッダーを解析してフレームサイズ(bytes)を返す。
 * 無効なヘッダーの場合は null。MPEG1/2/2.5 Layer III のみ対応。
 */
function parseFrameSize(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null
  if (data[offset] !== 0xFF) return null
  if ((data[offset + 1] & 0xE0) !== 0xE0) return null // sync word check

  const byte1 = data[offset + 1]
  const byte2 = data[offset + 2]

  const mpegVersionBits = (byte1 >> 3) & 0x3 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  const layerBits       = (byte1 >> 1) & 0x3 // 1=LayerIII, 2=LayerII, 3=LayerI
  const bitrateIndex    = (byte2 >> 4) & 0xF
  const sampleRateIndex = (byte2 >> 2) & 0x3
  const paddingBit      = (byte2 >> 1) & 0x1

  if (mpegVersionBits === 1) return null          // reserved
  if (layerBits !== 1) return null                // Layer III 以外は非対応
  if (bitrateIndex === 0 || bitrateIndex === 15) return null // free / bad
  if (sampleRateIndex === 3) return null          // reserved

  const isMPEG1 = mpegVersionBits === 3
  const bitrateKbps = isMPEG1 ? BITRATES_MPEG1_L3[bitrateIndex] : BITRATES_MPEG2_L3[bitrateIndex]
  const sampleRate  = SAMPLE_RATES[mpegVersionBits]?.[sampleRateIndex]
  if (!sampleRate || !bitrateKbps) return null

  const frameSize = isMPEG1
    ? Math.floor(144 * bitrateKbps * 1000 / sampleRate) + paddingBit
    : Math.floor(72  * bitrateKbps * 1000 / sampleRate) + paddingBit

  return frameSize > 0 ? frameSize : null
}

/**
 * data[offset..] から最初の有効な MP3 フレーム同期位置を返す。
 * 見つからない場合は -1。
 */
function findSyncWord(data: Uint8Array, offset = 0): number {
  for (let i = offset; i < data.length - 1; i++) {
    if (data[i] === 0xFF && (data[i + 1] & 0xE0) === 0xE0 && parseFrameSize(data, i) !== null) {
      return i
    }
  }
  return -1
}

/**
 * 蓄積バイト列から「完結している MP3 フレームの連続」を切り出す。
 *
 * framesData  — 完結フレームのみを含む連続バイト列 (なければ null)
 * remainder   — 次の (未完) フレーム以降のバイト列
 *
 * Note: decodeAudioData はバッチ呼び出しのたびにエンコーダーディレイ (~13ms) が
 * 付加されるため、継ぎ目で微小なギャップが生じる可能性がある。
 * WASM デコーダーを使えばこの問題は解消できるが、ゼロ依存を優先している。
 */
export function extractCompleteFrames(data: Uint8Array): {
  framesData: Uint8Array<ArrayBuffer> | null
  remainder: Uint8Array<ArrayBuffer>
} {
  const slice = (from: number, to?: number): Uint8Array<ArrayBuffer> => {
    const absFrom = from < 0 ? data.byteLength + from : from
    const absTo   = to   !== undefined ? to : data.byteLength
    return new Uint8Array((data.buffer as ArrayBuffer).slice(data.byteOffset + absFrom, data.byteOffset + absTo))
  }

  const start = findSyncWord(data)
  if (start === -1) {
    // 末尾の 1 byte は次の sync word の先頭かもしれないので保持
    return { framesData: null, remainder: data.length > 0 ? slice(-1) : new Uint8Array(0) }
  }

  let pos = start
  let end = start

  while (pos < data.length) {
    const frameSize = parseFrameSize(data, pos)
    if (frameSize === null) break

    const nextPos = pos + frameSize
    if (nextPos > data.length) break // フレームが未完 → 終了

    end = nextPos
    pos = nextPos

    if (pos >= data.length) break // データ末尾に達した

    // 次のフレームが有効でなければ停止 (パディングや破損データ対策)
    if (parseFrameSize(data, pos) === null) break
  }

  if (end === start) {
    // 完結フレームなし
    return { framesData: null, remainder: slice(start) }
  }

  return {
    framesData: slice(start, end),
    remainder: slice(end),
  }
}

/**
 * フレームバッファの末尾 n フレームを返す。
 * ビットリザーバーのオーバーラップコンテキスト用。
 */
export function extractTailFrames(data: Uint8Array, n: number): Uint8Array<ArrayBuffer> {
  const offsets: number[] = []
  let pos = 0
  while (pos < data.length) {
    const size = parseFrameSize(data, pos)
    if (size === null || pos + size > data.length) break
    offsets.push(pos)
    pos += size
  }
  if (offsets.length === 0) return new Uint8Array(0)
  const startPos = offsets[Math.max(0, offsets.length - n)]
  return new Uint8Array((data.buffer as ArrayBuffer).slice(
    data.byteOffset + startPos,
    data.byteOffset + data.byteLength,
  ))
}

/**
 * フレームバッファに含まれる完結フレームの合計 PCM サンプル数を返す。
 * MPEG1: 1152 samples/frame, MPEG2/2.5: 576 samples/frame
 */
export function countFrameSamples(data: Uint8Array): number {
  let pos = 0
  let samples = 0
  while (pos < data.length) {
    const size = parseFrameSize(data, pos)
    if (size === null || pos + size > data.length) break
    const mpegVersionBits = (data[pos + 1] >> 3) & 0x3
    samples += mpegVersionBits === 3 ? 1152 : 576
    pos += size
  }
  return samples
}