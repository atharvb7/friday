// Keeps memory embeddings current without ever blocking a write. Embeds new/edited
// rows in small batches; backfills old rows; degrades silently to keyword-only
// search if the embedding provider is down.
export class MemoryIndexer {
  #timer = null;
  #busy = false;
  constructor({ memory, ai, batch = 8, intervalMs = 20_000, bus = null }) {
    Object.assign(this, { memory, ai, batch, intervalMs, bus });
    this.lastError = null;
    this.model = null;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.#timer.unref();
    void this.runOnce();
  }
  stop() { clearInterval(this.#timer); this.#timer = null; }

  kick() { setTimeout(() => void this.runOnce(), 50).unref(); }

  async runOnce() {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      const rows = this.memory.needingEmbedding(this.batch);
      if (!rows.length) return 0;
      const { vectors, model } = await this.ai.embed(rows.map((r) => r.content), { inputType: 'passage' });
      rows.forEach((r, i) => this.memory.setEmbedding(r.id, vectors[i], model));
      this.model = model;
      this.lastError = null;
      if (rows.length === this.batch) this.kick(); // more to backfill
      return rows.length;
    } catch (error) {
      this.lastError = error.message?.slice(0, 160) ?? 'embed failed';
      return 0;
    } finally { this.#busy = false; }
  }

  // Query vector for retrieval; null on any failure (caller falls back to FTS).
  async queryVector(text) {
    try { return (await this.ai.embed([text.slice(0, 2000)], { inputType: 'query' })).vectors[0]; }
    catch (error) { this.lastError = error.message?.slice(0, 160); return null; }
  }
}
