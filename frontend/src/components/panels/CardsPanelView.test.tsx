import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CardsPanelView } from './CardsPanelView';

describe('CardsPanelView', () => {
  it('renders every card badge and metadata field in the panel DOM', () => {
    const { container } = render(
      <CardsPanelView
        panel={{
          id: 'research-cards',
          type: 'cards',
          title: 'Research cards',
          items: [
            {
              id: 'one',
              title: 'First finding',
              subtitle: 'Evidence',
              description: 'A concise finding.',
              badge: 'High confidence',
              metadata: { Source: 'Paper A', Year: '2026' },
            },
            {
              id: 'two',
              title: 'Second finding',
              badge: 'Open question',
              metadata: { Source: 'Paper B' },
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'First finding' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Second finding' })).toBeInTheDocument();
    expect(screen.getByText('High confidence')).toBeInTheDocument();
    expect(screen.getByText('Open question')).toBeInTheDocument();
    expect(screen.getByText('Paper A')).toBeInTheDocument();
    expect(screen.getByText('Paper B')).toBeInTheDocument();
    expect(container.querySelectorAll('.panel-card')).toHaveLength(2);
    expect(container.querySelectorAll('.panel-card-metadata-row')).toHaveLength(3);
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.panel-card'));
    expect(within(cards[0]).getByText('Year')).toBeInTheDocument();
  });
});
