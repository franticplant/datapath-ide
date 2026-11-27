// Owns worker lifetime and ignores messages from earlier or terminated runs.
export class EngineClient {
  constructor(createWorker, onEvent) {
    this.createWorker = createWorker;
    this.onEvent = onEvent;
    this.worker = null;
    this.generation = 0;
    this.nextRunId = 0;
    this.activeRunId = null;
    this.ready = false;
  }

  start() {
    if (this.worker) this.worker.terminate();
    const generation = ++this.generation;
    const worker = this.createWorker();
    this.worker = worker;
    this.ready = false;
    worker.onmessage = ({ data }) => {
      if (generation !== this.generation || !data || typeof data !== 'object') return;
      if (data.type === 'ready') { this.ready = true; this.onEvent(data); return; }
      if (data.runId !== this.activeRunId) return;
      this.onEvent(data);
      if (data.type === 'result' || data.type === 'error') this.activeRunId = null;
    };
    worker.onerror = event => {
      if (generation !== this.generation) return;
      this.ready = false;
      this.activeRunId = null;
      this.onEvent({ type: 'engine-error', message: event.message || 'Worker failed' });
    };
    worker.postMessage({ type: 'init' });
  }

  run(request) {
    if (!this.ready || this.activeRunId !== null) throw new Error('Engine is not ready');
    const runId = ++this.nextRunId;
    this.activeRunId = runId;
    this.worker.postMessage({ ...request, type: request.type === 'compile' ? 'compile' : 'run', runId });
    return runId;
  }

  stop() {
    if (this.activeRunId === null) return false;
    const runId = this.activeRunId;
    this.activeRunId = null;
    this.onEvent({ type: 'stopped', runId, partial: false, reason: 'worker-terminated' });
    this.start();
    return true;
  }
}
