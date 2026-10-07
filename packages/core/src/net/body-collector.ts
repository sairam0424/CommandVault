const KIB = 1024;

/** The size of one block; a body is held as at most `ceil(bytes / BLOCK_BYTES)` of them. */
export const BODY_BLOCK_BYTES = 64 * KIB;

/**
 * Gathers a streamed body into a few large blocks. A `data` event can carry a single byte, and a
 * chunk kept as it arrived costs a few hundred bytes of Buffer bookkeeping (measured at about 400
 * on Node 22), so holding the chunks themselves would let a peer that sends 10 MiB one byte at a
 * time pin gigabytes behind a 10 MiB cap. Here the bytes are copied into fixed blocks and each
 * chunk is dropped at once: memory follows the byte count, never the chunk count.
 */
export class BodyCollector {
  private readonly blocks: Buffer[] = [];
  private usedInLast = 0;
  private total = 0;

  /** Bytes gathered so far. */
  get length(): number {
    return this.total;
  }

  append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.blocks.length === 0 || this.usedInLast === BODY_BLOCK_BYTES) {
        // Never read past what is written below (see `text`), so the block need not be zeroed.
        this.blocks.push(Buffer.allocUnsafe(BODY_BLOCK_BYTES));
        this.usedInLast = 0;
      }
      const block = this.blocks[this.blocks.length - 1] as Buffer;
      const take = Math.min(chunk.length - offset, BODY_BLOCK_BYTES - this.usedInLast);
      chunk.copy(block, this.usedInLast, offset, offset + take);
      this.usedInLast += take;
      this.total += take;
      offset += take;
    }
  }

  /**
   * The body decoded as UTF-8. A leading byte order mark is dropped, the way `response.text()`
   * does, so a file saved with one still parses as JSON.
   */
  text(): string {
    const last = this.blocks.length - 1;
    const written = this.blocks.map((block, index) =>
      index === last ? block.subarray(0, this.usedInLast) : block,
    );
    return new TextDecoder('utf-8').decode(Buffer.concat(written, this.total));
  }
}
