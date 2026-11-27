// Bound retained simulator output even when a testbench prints indefinitely.
export class ConsoleBuffer {
  constructor(limit = 512 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid console limit');
    this.limit = limit;
    this.text = '';
    this.truncated = false;
  }
  append(chunk) {
    const next = this.text + String(chunk);
    if (next.length > this.limit) {
      this.text = next.slice(-this.limit);
      this.truncated = true;
    } else this.text = next;
  }
  clear() { this.text = ''; this.truncated = false; }
}
