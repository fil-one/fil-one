import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StateCard } from './StateCard';

describe('StateCard', () => {
  it('renders children', () => {
    render(<StateCard border="solid">Card content</StateCard>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });
});
