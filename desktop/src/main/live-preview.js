// At most one local draft translation in flight and one newest pending draft.
// Drafts are never sent to a cloud service or written into the transcript.
export class LivePreview {
  constructor({ translate, publish, delayMs = 400 }) {
    Object.assign(this, { translate, publish, delayMs });
    this.text = ''; this.generation = 0; this.busy = false; this.timer = null; this.closed = false;
  }
  update(text) {
    if (this.closed || text === this.text) return;
    this.text = text; this.generation++;
    // Avoid translating every two-word fragment and very long provisional hypotheses.
    if (text.split(/\s+/).length < 4 || text.length > 600) { clearTimeout(this.timer); this.timer = null; return; }
    this.schedule();
  }
  schedule() {
    if (this.busy || this.timer || !this.text || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, this.delayMs);
    this.timer.unref?.();
  }
  async run() {
    const text = this.text, generation = this.generation;
    this.busy = true;
    try {
      const result = await this.translate(text);
      if (!this.closed && generation === this.generation && result?.tr) this.publish({ text, tr: result.tr });
    } catch {} // Preview failure must not interfere with recognition or final translation.
    finally { this.busy = false; if (!this.closed && generation !== this.generation && this.text.split(/\s+/).length >= 4 && this.text.length <= 600) this.schedule(); }
  }
  clear() { this.text = ''; this.generation++; clearTimeout(this.timer); this.timer = null; }
  close() { this.clear(); this.closed = true; }
}
