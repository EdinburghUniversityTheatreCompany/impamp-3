import { vi, beforeAll, afterAll, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import 'vitest-canvas-mock';
import '@testing-library/jest-dom';
import { setupMatchers } from './custom-matchers';

// Keep a minimal audio API mock - just enough to prevent errors
class MockAudioBuffer {
  duration = 30;
  length = 44100 * 30;
  numberOfChannels = 2;
  sampleRate = 44100;
  getChannelData = vi.fn(() => new Float32Array(44100 * 30));
}

class MockAudioBufferSourceNode extends EventTarget {
  buffer: MockAudioBuffer | null = null;
  onended: ((this: AudioBufferSourceNode, ev: Event) => any) | null = null;
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
  start = vi.fn(() => {
    // Simulate ending in 1 second for quicker tests
    setTimeout(() => {
      const event = new Event('ended');
      this.dispatchEvent(event);
      if (this.onended) this.onended.call(this as unknown as AudioBufferSourceNode, event);
    }, 1000);
  });
  stop = vi.fn();
}

class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
  };
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  
  createBufferSource() {
    return new MockAudioBufferSourceNode();
  }
  
  createGain() {
    return new MockGainNode();
  }
  
  decodeAudioData(_arrayBuffer: ArrayBuffer) {
    return Promise.resolve(new MockAudioBuffer());
  }
  
  resume() {
    return Promise.resolve();
  }
}

// Setup necessary mocks for tests
beforeAll(() => {
  // Initialize custom matchers
  setupMatchers();

  // Mock AudioContext
  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('webkitAudioContext', MockAudioContext);

  // Create a working localStorage mock
  const localStorageStore: Record<string, string> = {};
  const localStorageMock = {
    getItem: vi.fn((key: string) => localStorageStore[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      localStorageStore[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete localStorageStore[key];
    }),
    clear: vi.fn(() => {
      Object.keys(localStorageStore).forEach(key => delete localStorageStore[key]);
    }),
    length: 0,
    key: vi.fn((index: number) => Object.keys(localStorageStore)[index] || null),
  };
  Object.defineProperty(localStorageMock, 'length', {
    get: () => Object.keys(localStorageStore).length
  });
  vi.stubGlobal('localStorage', localStorageMock);

  // Set up timers
  vi.useFakeTimers();
  
  // Mock URL methods
  global.URL.createObjectURL = vi.fn(() => 'mock-url');
  global.URL.revokeObjectURL = vi.fn();
});

// Clean up after each test
afterEach(() => {
  // Clean up testing-library components
  cleanup();
  
  // Reset any timers
  vi.runOnlyPendingTimers();
  vi.clearAllTimers();
  
  // Reset mocks
  vi.clearAllMocks();
});

// Clean up after all tests
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
