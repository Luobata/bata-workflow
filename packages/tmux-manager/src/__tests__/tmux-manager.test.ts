import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sanitizeName,
  isInTmux,
  detectMultiplexerContext,
  checkTmuxHealth,
  createSession,
  killSession,
  listSessions,
} from '../index.js';

describe('sanitizeName', () => {
  it('should allow alphanumeric characters and hyphens', () => {
    expect(sanitizeName('my-session-123')).toBe('my-session-123');
  });

  it('should replace invalid characters with hyphens', () => {
    expect(sanitizeName('my session!@#$%')).toBe('my-session-----');
  });

  it('should truncate to 50 characters', () => {
    const longName = 'a'.repeat(100);
    expect(sanitizeName(longName)).toHaveLength(50);
  });

  it('should throw for empty result', () => {
    expect(() => sanitizeName('!@#$%')).toThrow('contains no valid characters');
  });

  it('should preserve underscores and allow hyphens', () => {
    expect(sanitizeName('my_session-name')).toBe('my_session-name');
  });
});

describe('detectMultiplexerContext', () => {
  it('should return tmux when TMUX is set', () => {
    const env = { TMUX: '/tmp/tmux-1000/default,1234,0' };
    expect(detectMultiplexerContext(env)).toBe('tmux');
  });

  it('should return cmux when CMUX_SURFACE_ID is set', () => {
    const env = { CMUX_SURFACE_ID: 'abc123' };
    expect(detectMultiplexerContext(env)).toBe('cmux');
  });

  it('should return none when no multiplexer is detected', () => {
    expect(detectMultiplexerContext({})).toBe('none');
  });
});

describe('isInTmux', () => {
  it('should return true when TMUX is set', () => {
    const env = { TMUX: '/tmp/tmux-1000/default,1234,0' };
    expect(isInTmux(env)).toBe(true);
  });

  it('should return false when TMUX is not set', () => {
    expect(isInTmux({})).toBe(false);
  });
});

describe('checkTmuxHealth', () => {
  it('should return health check result', async () => {
    const health = await checkTmuxHealth();
    expect(health).toHaveProperty('available');
    expect(health).toHaveProperty('inTmux');
    expect(typeof health.available).toBe('boolean');
    expect(typeof health.inTmux).toBe('boolean');
  });
});

// Integration tests (require tmux to be installed)
describe('tmux integration', () => {
  const testSessionName = `test-${Date.now().toString(36)}`;

  beforeEach(async () => {
    // Clean up any existing test session
    try {
      await killSession(testSessionName);
    } catch {
      // Ignore
    }
  });

  afterEach(async () => {
    // Clean up test session
    try {
      await killSession(testSessionName);
    } catch {
      // Ignore
    }
  });

  it('should create and kill a session', async () => {
    const health = await checkTmuxHealth();
    if (!health.available) {
      console.log('Skipping: tmux not available');
      return;
    }

    const session = await createSession({
      name: testSessionName,
      cwd: process.cwd(),
    });

    expect(session.name).toBe(testSessionName);
    expect(session.paneId).toMatch(/^%\d+$/);

    const sessions = await listSessions();
    expect(sessions).toContain(testSessionName);

    await killSession(testSessionName);

    const sessionsAfter = await listSessions();
    expect(sessionsAfter).not.toContain(testSessionName);
  });
});
