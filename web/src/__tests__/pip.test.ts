/**
 * usePiP hook — unit tests
 *
 * Covers openPiP() behavior: unsupported, opens window, guards duplicates,
 * reopens after pagehide.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const _realCreateElement = document.createElement.bind(document);

function makePipWindow() {
  const listeners: Record<string, () => void> = {};
  const doc = {
    createElement: vi.fn((tag: string) => {
      if (tag === 'style') return { textContent: '' };
      if (tag === 'iframe') return { src: '', allow: '' };
      return {};
    }),
    head: { appendChild: vi.fn() },
    body: { appendChild: vi.fn() },
    title: '',
  };
  return {
    document: doc,
    closed: false,
    close: vi.fn(),
    addEventListener: vi.fn((event: string, cb: () => void) => { listeners[event] = cb; }),
    _fireEvent: (event: string) => listeners[event]?.(),
  };
}

let mockPipWindow: ReturnType<typeof makePipWindow> | null = null;
const mockRequestWindow = vi.fn(async () => {
  mockPipWindow = makePipWindow();
  return mockPipWindow;
});
Object.defineProperty(globalThis, 'documentPictureInPicture', {
  value: { requestWindow: mockRequestWindow },
  writable: true,
  configurable: true,
});

vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
  if (tag === 'audio') return {} as HTMLElement;
  return _realCreateElement(tag);
});
vi.spyOn(document.body, 'appendChild').mockImplementation(node => node as Node);

const { usePiP, tryOpenPiP, isPiPOpen, __resetForTest } = await import('../hooks/usePiP');

describe('usePiP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipWindow = null;
    __resetForTest();
  });

  it('pipSupported is true when documentPictureInPicture is present', () => {
    const { result } = renderHook(() => usePiP());
    expect(result.current.pipSupported).toBe(true);
  });

  it('openPiP opens a window and returns true', async () => {
    const { result } = renderHook(() => usePiP());
    const ok = await act(() => result.current.openPiP());
    expect(ok).toBe(true);
    expect(mockRequestWindow).toHaveBeenCalledTimes(1);
  });

  it('openPiP returns false when a window is already open', async () => {
    const { result } = renderHook(() => usePiP());
    await act(() => result.current.openPiP());
    const ok = await act(() => result.current.openPiP());
    expect(ok).toBe(false);
    expect(mockRequestWindow).toHaveBeenCalledTimes(1);
  });

  it('openPiP can reopen after pagehide', async () => {
    const { result } = renderHook(() => usePiP());
    await act(() => result.current.openPiP());
    const win = mockPipWindow!;
    act(() => { win._fireEvent('pagehide'); });
    const ok = await act(() => result.current.openPiP());
    expect(ok).toBe(true);
    expect(mockRequestWindow).toHaveBeenCalledTimes(2);
  });
});

describe('tryOpenPiP (standalone)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipWindow = null;
    __resetForTest();
  });

  it('opens a PiP window and returns true', async () => {
    const ok = await tryOpenPiP();
    expect(ok).toBe(true);
    expect(mockRequestWindow).toHaveBeenCalledTimes(1);
  });

  it('returns false when a window is already open', async () => {
    await tryOpenPiP();
    const ok = await tryOpenPiP();
    expect(ok).toBe(false);
    expect(mockRequestWindow).toHaveBeenCalledTimes(1);
  });

  it('can reopen after pagehide', async () => {
    await tryOpenPiP();
    const win = mockPipWindow!;
    win._fireEvent('pagehide');
    const ok = await tryOpenPiP();
    expect(ok).toBe(true);
    expect(mockRequestWindow).toHaveBeenCalledTimes(2);
  });
});

describe('isPiPOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipWindow = null;
    __resetForTest();
  });

  it('returns false when no PiP window has been opened', () => {
    expect(isPiPOpen()).toBe(false);
  });

  it('returns true after opening PiP', async () => {
    await tryOpenPiP();
    expect(isPiPOpen()).toBe(true);
  });

  it('returns false after pagehide', async () => {
    await tryOpenPiP();
    mockPipWindow!._fireEvent('pagehide');
    expect(isPiPOpen()).toBe(false);
  });

  it('returns false when window is closed externally', async () => {
    await tryOpenPiP();
    (mockPipWindow as any).closed = true;
    expect(isPiPOpen()).toBe(false);
  });
});
