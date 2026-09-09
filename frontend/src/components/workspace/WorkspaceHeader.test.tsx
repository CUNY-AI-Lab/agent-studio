import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelCatalog } from '../../api';
import { WorkspaceHeader } from './WorkspaceHeader';

const modelCatalog: ModelCatalog = {
  default: 'recommended-model',
  models: [
    {
      id: 'recommended-model',
      tier: 'recommended',
      status: 'active',
      sunset: null,
      capabilities: ['tools'],
      contextLength: 32_000,
      name: 'Recommended model',
      description: null,
    },
    {
      id: 'advanced-model',
      tier: 'advanced',
      status: 'active',
      sunset: null,
      capabilities: ['tools'],
      contextLength: null,
      name: 'Advanced model',
      description: null,
    },
  ],
};

const baseProps = {
  workspaceName: 'Research workspace',
  workspaceDescription: 'A working description',
  onNameChange: vi.fn(),
  onDescriptionChange: vi.fn(),
  tileCount: 2,
  fileCount: 1,
  modelCatalog,
  modelQuotaNotice: null,
  workspaceModel: undefined,
  onModelChange: vi.fn(),
  onGoHome: vi.fn(),
  onRefresh: vi.fn(),
  onExport: vi.fn(),
  onDelete: vi.fn(),
  onSave: vi.fn(),
  savingWorkspace: false,
  isCompactHeaderLayout: false,
  galleryId: null,
  publishing: false,
  publishableArtifactCount: 0,
  onUnpublish: vi.fn(),
  onOpenPublishModal: vi.fn(),
  isDockedChatLayout: false,
  chatOpen: false,
  onToggleChat: vi.fn(),
  onOpenShortcuts: vi.fn(),
};

describe('WorkspaceHeader', () => {
  it('keeps an unsupported saved model visible while offering the catalog choices', () => {
    render(<WorkspaceHeader {...baseProps} workspaceModel="legacy-model" />);

    const picker = screen.getByRole('combobox', { name: 'Agent model' });
    expect(picker).toHaveValue('legacy-model');
    expect(screen.getByRole('option', { name: 'legacy-model (tools unavailable)' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Recommended model (default)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Advanced model' })).toBeInTheDocument();
  });

  it('lets a docked layout toggle chat from the header', async () => {
    const user = userEvent.setup();
    const onToggleChat = vi.fn();
    render(<WorkspaceHeader {...baseProps} isDockedChatLayout chatOpen onToggleChat={onToggleChat} />);

    await user.click(screen.getByRole('button', { name: 'Hide chat' }));
    expect(onToggleChat).toHaveBeenCalledOnce();
  });

  it('uses the compact publish control when the header is narrow', async () => {
    const user = userEvent.setup();
    const onOpenPublishModal = vi.fn();
    render(
      <WorkspaceHeader
        {...baseProps}
        isCompactHeaderLayout
        publishableArtifactCount={1}
        onOpenPublishModal={onOpenPublishModal}
      />
    );

    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish to gallery' }));
    expect(onOpenPublishModal).toHaveBeenCalledOnce();
  });
});
