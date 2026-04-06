// チャンクをシームレスにつなぐためのスケジューリング
// フェーズ1: Buffer Queueなし、受信したチャンクを即スケジュール
export class Scheduler {
  private nextTime = 0

  constructor(private ctx: AudioContext) {}

  schedule(buf: AudioBuffer): void {
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)

    // 初回は少しだけラテンシーを持たせて安定させる
    if (this.nextTime === 0) {
      this.nextTime = this.ctx.currentTime + 0.1
    }

    src.start(this.nextTime)
    this.nextTime += buf.duration
  }

  reset(): void {
    this.nextTime = 0
  }
}