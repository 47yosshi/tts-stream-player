export class BufferQueue {
  private items: AudioBuffer[] = []
  private _duration = 0
  private waiters: Array<() => void> = []
  private _closed = false

  constructor(readonly minBufferSeconds: number) {}

  push(buf: AudioBuffer): void {
    this.items.push(buf)
    this._duration += buf.duration
    this.notifyWaiters()
  }

  shift(): AudioBuffer | undefined {
    const buf = this.items.shift()
    if (buf) this._duration -= buf.duration
    return buf
  }

  get bufferedDuration(): number {
    return this._duration
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }

  get closed(): boolean {
    return this._closed
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    this.notifyWaiters()
  }

  /** minBufferSeconds 分溜まるか closed になるまで待つ */
  async waitForMinBuffer(): Promise<void> {
    while (!this._closed && this._duration < this.minBufferSeconds) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
  }

  /** 1件以上溜まるか closed になるまで待つ */
  async waitForAny(): Promise<void> {
    while (!this._closed && this.items.length === 0) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
  }

  private notifyWaiters(): void {
    const ws = this.waiters.splice(0)
    ws.forEach(r => r())
  }
}
