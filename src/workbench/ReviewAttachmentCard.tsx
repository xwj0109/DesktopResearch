import type { ReviewAttachment } from "../review-attachment";

export function ReviewAttachmentCard({
  attachment,
  onRemove,
  disabled = false,
}: {
  attachment: ReviewAttachment;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="review-attachment">
      <details>
        <summary>
          <span aria-hidden="true" className="review-attachment-icon">
            ▤
          </span>
          <span className="review-attachment-label">
            <strong>{attachment.title}</strong>
            <small>
              Research review · {attachment.passages} passages ·{" "}
              {attachment.papers} papers
            </small>
          </span>
          <span className="review-attachment-inspect">View</span>
        </summary>
        <div className="review-attachment-content">
          <p>
            {onRemove
              ? "This question and evidence will be included when you send."
              : "Question and evidence included with this message."}
          </p>
          <pre>{attachment.content}</pre>
        </div>
      </details>
      {onRemove && (
        <button
          type="button"
          className="icon-btn review-attachment-remove"
          disabled={disabled}
          aria-label={`Remove review attachment: ${attachment.title}`}
          title="Remove attachment"
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </div>
  );
}
