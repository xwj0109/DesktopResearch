import { useEffect, useRef, useState } from "react";

/** A new message gets a fresh interval; rendering or changing callbacks does not
 * extend it. Hover and keyboard focus keep a notice available while reading. */
export function useAutoDismiss(
  key: unknown,
  dismiss: () => void,
  delay: number,
  paused = false,
) {
  const callback = useRef(dismiss);
  callback.current = dismiss;
  useEffect(() => {
    if (!key || paused) return;
    const timer = setTimeout(() => callback.current(), delay);
    return () => clearTimeout(timer);
  }, [key, delay, paused]);
}

export function Notice({
  message,
  onDismiss,
  error = false,
}: {
  message: string;
  onDismiss: () => void;
  error?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useAutoDismiss(message, onDismiss, error ? 12000 : 6000, hovered || focused);
  return (
    <div
      className={`notice dismissible${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
      onClick={onDismiss}
      title="Click to dismiss notification"
    >
      <span className="notice-message">{message}</span>
      <button
        type="button"
        className="notice-dismiss"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        ×
      </button>
    </div>
  );
}
