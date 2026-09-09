/**
 * Shared interface pieces.
 *
 * Deliberately small: the design system lives in CSS, and these components
 * exist to enforce the parts that are easy to get wrong — accessible form
 * association, error announcement, and status that never relies on colour
 * alone.
 */
import { useId } from "react";
import { Link } from "react-router";

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: string;
  error?: string;
  /** Render the label for screen readers only, for single-field forms. */
  hideLabel?: boolean;
}

/**
 * A labelled input.
 *
 * The label is always a real `<label for>`, the hint and error are wired
 * through `aria-describedby`, and an invalid field carries `aria-invalid` — so
 * a screen reader announces the field name, its instructions and its error
 * together, and the error is never conveyed by red text alone.
 */
export function Field({ label, hint, error, hideLabel, className, ...props }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "field-label"}>
        {label}
        {props.required && (
          <span aria-hidden="true" style={{ color: "var(--color-loop)" }}>
            {" "}
            *
          </span>
        )}
      </label>
      <input
        {...props}
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint && !error && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface TextAreaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id"
> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextArea({ label, hint, error, className, ...props }: TextAreaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <textarea
        {...props}
        id={id}
        className="input"
        style={{ minHeight: "8rem", resize: "vertical", lineHeight: 1.55, ...props.style }}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint && !error && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  hint?: string;
  error?: string;
  options: Array<{ value: string; label: string }>;
}

export function Select({ label, hint, error, options, className, ...props }: SelectProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select {...props} id={id} className="input" aria-describedby={hint ? hintId : undefined}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export type NoticeTone = "info" | "positive" | "caution" | "critical";

/**
 * A message about what just happened, or what needs to happen.
 *
 * `role="alert"` on the critical tone so an error is announced immediately;
 * `role="status"` otherwise, which announces politely without interrupting.
 */
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: string;
  children: React.ReactNode;
}) {
  const palette: Record<NoticeTone, { border: string; bg: string; fg: string }> = {
    info: { border: "var(--color-rule)", bg: "var(--color-panel)", fg: "var(--color-ink)" },
    positive: {
      border: "var(--color-positive)",
      bg: "var(--color-positive-wash)",
      fg: "var(--color-positive)",
    },
    caution: {
      border: "var(--color-caution)",
      bg: "var(--color-caution-wash)",
      fg: "var(--color-caution)",
    },
    critical: {
      border: "var(--color-critical)",
      bg: "var(--color-critical-wash)",
      fg: "var(--color-critical)",
    },
  };
  const colors = palette[tone];

  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      style={{
        // A 3px rule on the leading edge rather than a tinted card: it reads at
        // a glance without turning every message into a coloured box.
        borderLeft: `3px solid ${colors.border}`,
        background: colors.bg,
        padding: "0.875rem 1rem",
        fontSize: "var(--text-fine)",
        lineHeight: 1.55,
      }}
    >
      {title && (
        <strong style={{ display: "block", color: colors.fg, marginBottom: "0.25rem" }}>
          {title}
        </strong>
      )}
      <div style={{ color: "var(--color-ink-soft)" }}>{children}</div>
    </div>
  );
}

/** Status label. Always carries a word, never colour alone. */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "positive" | "caution" | "critical";
  children: React.ReactNode;
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/**
 * Empty state.
 *
 * An empty screen is an invitation to act, so this always offers the next
 * action rather than just reporting nothing is here.
 */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: { label: string; to: string };
}) {
  return (
    <div
      style={{
        padding: "3rem 1.5rem",
        textAlign: "left",
        border: "1px dashed var(--color-rule)",
      }}
    >
      <h3 style={{ fontSize: "var(--text-h4)" }}>{title}</h3>
      {children && <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>{children}</p>}
      {action && (
        <Link to={action.to} className="btn btn-ink" style={{ marginTop: "1.25rem" }}>
          {action.label}
        </Link>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** A page heading with optional supporting line and trailing actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        gap: "1.5rem",
        alignItems: "flex-end",
        justifyContent: "space-between",
        flexWrap: "wrap",
        paddingBottom: "1.25rem",
        borderBottom: "1px solid var(--color-rule)",
        marginBottom: "2rem",
      }}
    >
      <div>
        <h1 style={{ fontSize: "var(--text-h3)" }}>{title}</h1>
        {description && (
          <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>{description}</p>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: "0.5rem" }}>{actions}</div>}
    </header>
  );
}

/**
 * A figure with a label. Used for balances and counts.
 *
 * The number leads and the label follows, because the number is what someone
 * came to read.
 */
export function Stat({
  value,
  label,
  tone = "ink",
  hint,
}: {
  value: string | number;
  label: string;
  tone?: "ink" | "loop" | "muted";
  hint?: string;
}) {
  const color =
    tone === "loop"
      ? "var(--color-loop)"
      : tone === "muted"
        ? "var(--color-muted)"
        : "var(--color-ink)";

  return (
    <div>
      <p
        className="numeric"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "var(--text-h2)",
          lineHeight: 1,
          letterSpacing: "-0.04em",
          color,
        }}
      >
        {value}
      </p>
      <p
        style={{
          marginTop: "0.5rem",
          fontSize: "var(--text-fine)",
          color: "var(--color-muted)",
        }}
      >
        {label}
      </p>
      {hint && (
        <p
          style={{
            marginTop: "0.25rem",
            fontSize: "var(--text-micro)",
            color: "var(--color-muted)",
          }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/** Formats an ISO timestamp for display. */
export function formatDate(value: string | Date | null, withTime = false): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

/** "3 minutes ago" — for activity lists, where exact times add noise. */
export function formatRelative(value: string | Date | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(date);
}

/** Signed credit amount, with the sign as a character not just a colour. */
export function formatCredits(amount: number): string {
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${Math.abs(amount).toLocaleString("en-GB")}`;
}
