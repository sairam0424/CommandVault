import { beforeEach, describe, expect, it, vi } from 'vitest';

const { oraMock } = vi.hoisted(() => ({ oraMock: vi.fn() }));
vi.mock('ora', () => ({ default: oraMock }));

import { createSpinner } from '../ui/spinner.js';

describe('createSpinner options', () => {
  beforeEach(() => {
    oraMock.mockReset();
    oraMock.mockReturnValue({ start: vi.fn() });
  });

  it('always passes discardStdin: false', () => {
    createSpinner('Working...');
    expect(oraMock).toHaveBeenCalledWith(expect.objectContaining({ discardStdin: false }));
  });

  it('forwards text and indent', () => {
    createSpinner('Testing...', { indent: 2 });
    expect(oraMock).toHaveBeenCalledWith({ text: 'Testing...', indent: 2, discardStdin: false });
  });

  it('does not start the spinner itself', () => {
    const instance = { start: vi.fn() };
    oraMock.mockReturnValue(instance);
    expect(createSpinner('Idle')).toBe(instance);
    expect(instance.start).not.toHaveBeenCalled();
  });
});
