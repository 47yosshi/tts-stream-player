// フェーズ1: PCMのみ対応
// フェーズ2以降でMP3/WAVを追加する想定

export type AudioFormat = 'pcm_16bit' // | 'mp3' | 'wav'  ← 後で追加

export function decodePCM(chunk: Uint8Array): Float32Array<ArrayBuffer> {
  // 16bit符号付き整数 → Float32 (-1.0 〜 1.0) に変換
  const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
  const float32 = new Float32Array(int16.length) as Float32Array<ArrayBuffer>
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768
  }
  return float32
}