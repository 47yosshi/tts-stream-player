// チャンクをシームレスにつなぐためのスケジューリング
export class Scheduler {
  private nextTime = 0

  constructor(
    private ctx: AudioContext,
    private minBufferSeconds: number,
  ) {}

  schedule(buf: AudioBuffer): void {
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)

    if (this.nextTime === 0 || this.nextTime < this.ctx.currentTime) {
      // 初回 or アンダーフロー後: minBuffer 分先を基準に再スタート
      this.nextTime = this.ctx.currentTime + this.minBufferSeconds
    }

    src.start(this.nextTime)
    this.nextTime += buf.duration
  }

  /** スケジュール済み音声が現在時刻より過去になっているか（実際の音切れ） */
  isUnderflowed(): boolean {
    return this.nextTime > 0 && this.nextTime <= this.ctx.currentTime
  }

  reset(): void {
    this.nextTime = 0
  }
}
