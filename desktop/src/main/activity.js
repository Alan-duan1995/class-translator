/** Track active recording/finalization/report work; always release the OS sleep blocker. */
export class Activity {
  constructor(power) { this.power = power; this.count = 0; this.blocker = null; }
  get busy() { return this.count > 0; }
  acquire() {
    if (!this.count) this.blocker = this.power.start('prevent-app-suspension');
    this.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.count === 0) { this.power.stop(this.blocker); this.blocker = null; }
    };
  }
}
export function audioLevel(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / n);
  return rms ? Math.max(0, Math.min(100, (20 * Math.log10(rms) + 60) / 60 * 100)) : 0;
}
