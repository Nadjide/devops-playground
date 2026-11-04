/** Minimal xterm stand-in for jsdom, which cannot measure or render a terminal. */
export const xtermInstances = [];

export class FakeTerminal {
  constructor(options) {
    this.options = options;
    this.output = '';
    this.dataDisposed = false;
    this.disposed = false;
    this.handler = null;
    xtermInstances.push(this);
  }

  loadAddon() {}

  open(host) {
    this.host = host;
  }

  write(text) {
    this.output += text;
  }

  clear() {
    this.output = '';
  }

  onData(handler) {
    this.handler = handler;
    return { dispose: () => { this.dataDisposed = true; } };
  }

  dispose() {
    this.disposed = true;
  }
}

export class FakeFitAddon {
  fit() {}
}
