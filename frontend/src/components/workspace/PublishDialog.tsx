export function PublishDialog({
  open,
  publishing,
  title,
  description,
  publishablePanelCount,
  fileCount,
  onTitleChange,
  onDescriptionChange,
  onClose,
  onPublish,
}: {
  open: boolean;
  publishing: boolean;
  title: string;
  description: string;
  publishablePanelCount: number;
  fileCount: number;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onClose: () => void;
  onPublish: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => {
        if (!publishing) {
          onClose();
        }
      }}
    >
      <div
        className="mx-4 w-full max-w-md rounded-2xl bg-card p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">Publish to Gallery</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Title</label>
            <input
              type="text"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Give your workspace a name..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 focus:border-primary/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Description</label>
            <textarea
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="Describe what this workspace does..."
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 focus:border-primary/50 focus:outline-none"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            This will share {publishablePanelCount} tile view{publishablePanelCount !== 1 ? 's' : ''} and {fileCount} file{fileCount !== 1 ? 's' : ''} to the public gallery.
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            disabled={publishing}
          >
            Cancel
          </button>
          <button
            onClick={onPublish}
            disabled={publishing || !title.trim() || !description.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {publishing ? 'Publishing...' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
