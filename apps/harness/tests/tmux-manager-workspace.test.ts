import { describe, expect, it } from 'vitest'

describe('@luobata/tmux-manager workspace dependency', () => {
  it('allows harness workspace to import tmux-manager exports', async () => {
    const tmuxManager = await import('@luobata/tmux-manager')

    expect(tmuxManager.detectMultiplexerContext).toEqual(expect.any(Function))
    expect(tmuxManager.createSplitLayout).toEqual(expect.any(Function))
  })
})
