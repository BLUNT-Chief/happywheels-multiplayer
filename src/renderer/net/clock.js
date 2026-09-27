// Shared race clock: every client estimates the host's performance.now() offset from ping
// round trips (keeping the lowest-RTT samples, which have the least queuing error).

export class Clock {
  constructor() {
    this.offset = 0;
    this.samples = [];
    this.synced = false;
    this.rtt = 0;
  }

  now() { return performance.now() + this.offset; }

  /**
   * Called when joining a lobby or when the host changes. The offset is kept, so a new host that
   * was synced to the old one continues the same timebase and in-flight race times stay valid.
   */
  reset(isHost) {
    this.samples = [];
    this.synced = !!isHost;
    this.rtt = 0;
  }

  /** t0/t1 local send/receive times, hostNow host time when it answered. */
  addSample(t0, t1, hostNow) {
    const rtt = t1 - t0;
    if (!(rtt >= 0) || rtt > 5000) return;
    this.samples.push({ rtt, offset: hostNow - (t0 + t1) / 2 });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    // Avoid visible jumps once synced: move gradually unless the error is large.
    if (!this.synced || Math.abs(best.offset - this.offset) > 50) this.offset = best.offset;
    else this.offset += (best.offset - this.offset) * 0.25;
    this.rtt = best.rtt;
    if (this.samples.length >= 3) this.synced = true;
  }
}
