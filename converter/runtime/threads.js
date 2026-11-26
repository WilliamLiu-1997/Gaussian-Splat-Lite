let nextId = 0;
const active = new Set();
export const threadCount = () => active.size;

class BrowserThread {
  constructor(data) {
    this.events = {};
    this.id = nextId++;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    self.postMessage({ spawn: this.id, data, port: port2 }, [port2]);
    this.port.onmessage = ({ data: message }) => {
      if (message.error) this.events.error?.(new Error(message.error));
      else this.events.message?.(message.result);
    };
    active.add(this);
    self.postMessage({ threads: 1 + active.size });
  }
  on(name, handler) {
    this.events[name] = handler;
  }
  unref() {}
  postMessage(message, transfer) {
    // Disk pages are owned by the coordinating worker. It completes a
    // prediction that encounters one using the same CLI MISS path.
    this.port.postMessage(
      message.files ? { ...message, files: [null, null, null] } : message,
      transfer,
    );
  }
  terminate() {
    self.postMessage({ stop: this.id });
    this.port.close();
    active.delete(this);
    self.postMessage({ threads: 1 + active.size });
  }
}
export const createThread = ({ workerData }) => new BrowserThread(workerData);
export function wakePool(workers, _control, _word, gen) {
  for (const worker of workers) worker.postMessage({ round: gen });
}
