import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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
});
