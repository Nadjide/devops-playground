import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { xtermInstances } from './xterm-fake.js';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fake.js')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fake.js')).FakeFitAddon }));

let desktop = true;

export function setDesktopViewport(value) {
  desktop = value;
}

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn((query) => ({
    matches: query.includes('min-width: 1024px') ? desktop : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;

afterEach(() => {
  cleanup();
  desktop = true;
  xtermInstances.length = 0;
});
