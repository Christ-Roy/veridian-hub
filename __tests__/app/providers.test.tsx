import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let pathname = '/';
const sessionProvider = vi.fn(({ children }: { children: React.ReactNode }) => (
  <div data-testid="session-provider">{children}</div>
));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: (props: { children: React.ReactNode }) => sessionProvider(props),
}));

import Providers from '@/app/providers';

describe('<Providers>', () => {
  beforeEach(() => {
    pathname = '/';
    sessionProvider.mockClear();
  });

  it('conserve Auth.js sur les routes applicatives', () => {
    pathname = '/dashboard';
    render(<Providers><span>Dashboard</span></Providers>);

    expect(screen.getByTestId('session-provider')).toBeInTheDocument();
    expect(sessionProvider).toHaveBeenCalledOnce();
  });

  it('ne charge pas Auth.js dans les ateliers UI fictifs', () => {
    pathname = '/dev/onboarding';
    render(<Providers><span>Atelier onboarding</span></Providers>);

    expect(screen.getByText('Atelier onboarding')).toBeInTheDocument();
    expect(screen.queryByTestId('session-provider')).toBeNull();
    expect(sessionProvider).not.toHaveBeenCalled();
  });
});
