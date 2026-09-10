import { useEffect, useEffectEvent, useId, useRef } from 'react';
import { createFocusTrap } from '../../lib/focusTrap';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const disclosureId = useId();
  const titleFieldId = useId();
  const descriptionFieldId = useId();
  const handleEscape = useEffectEvent(() => {
    if (!publishing) onClose();
  });

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const trap = createFocusTrap(dialogRef.current, {
      onEscape: handleEscape,
    });
    return () => trap.release();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="ui-backdrop"
      onClick={() => {
        if (!publishing) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={disclosureId}
        tabIndex={-1}
        className="ui-surface ui-surface-lg ui-dialog rule-lead max-w-md focus:outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="mb-5">Publish to Gallery</h2>
        <div className="space-y-4">
          <div>
            <label htmlFor={titleFieldId} className="ui-label mb-1.5 block">Title</label>
            <input
              id={titleFieldId}
              type="text"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Give your workspace a name..."
              className="ui-field"
            />
          </div>
          <div>
            <label htmlFor={descriptionFieldId} className="ui-label mb-1.5 block">Description</label>
            <textarea
              id={descriptionFieldId}
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="Describe what this workspace does..."
              rows={3}
              className="ui-field resize-none"
            />
          </div>
          <p id={disclosureId} className="border-l-3 border-lead pl-3 text-xs leading-relaxed text-muted-foreground">
            Agent Studio saves this workspace privately. Model-provider routes are configured not to retain prompts or outputs, but Agent Studio still stores the workspace. Publishing makes {publishablePanelCount} tile view{publishablePanelCount !== 1 ? 's' : ''} and {fileCount} file{fileCount !== 1 ? 's' : ''} available to signed-in CAIL members through the Agent Studio gallery. Gallery links open only for signed-in CAIL members. Don’t publish private or sensitive files.
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="ui-btn ui-btn-quiet"
            disabled={publishing}
          >
            Cancel
          </button>
          <button
            onClick={onPublish}
            disabled={publishing || !title.trim() || !description.trim()}
            className="ui-btn ui-btn-primary"
          >
            {publishing ? 'Publishing...' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
