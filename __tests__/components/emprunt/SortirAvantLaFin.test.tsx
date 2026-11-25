import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SortirAvantLaFin } from '@/components/emprunt/SortirAvantLaFin';

const submit = vi.fn(function (this: HTMLFormElement) { return [this.method, this.getAttribute('action')]; });
beforeEach(() => { vi.useFakeTimers(); submit.mockClear(); HTMLFormElement.prototype.submit = submit; });
afterEach(() => vi.useRealTimers());

it('sort une minute avant la fin, pas avant ; démonté, il ne sort plus', () => {
  const fin = Date.now() + 600_000;
  const { unmount } = render(<SortirAvantLaFin finMs={fin} />);
  vi.advanceTimersByTime(539_000);
  expect(submit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_500);
  expect(submit.mock.results[0].value).toEqual(['post', '/api/auth/emprunt/sortir']);
  unmount();
  render(<SortirAvantLaFin finMs={Date.now() + 600_000} />).unmount();
  vi.advanceTimersByTime(700_000);
  expect(submit).toHaveBeenCalledTimes(1);
});
