import type { Route } from "./+types/notifications";
import { call, type Paged } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, PageHeader, Pill, formatRelative } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Notifications",
    description: "Account notifications.",
    path: location.pathname,
    noindex: true,
  });
}

interface NotificationItem {
  id: string;
  kind: "announcement" | "security" | "credits" | "support" | "account";
  title: string;
  body: string;
  actionPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Paged<NotificationItem>>("/me/notifications?limit=50", { request });
  return { items: result.data?.items ?? [] };
}

const KIND_TONE: Record<NotificationItem["kind"], "neutral" | "positive" | "caution" | "critical"> =
  {
    announcement: "neutral",
    security: "critical",
    credits: "positive",
    support: "neutral",
    account: "caution",
  };

export default function Notifications({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Everything we have told you about your account."
      />

      {loaderData.items.length === 0 ? (
        <Empty title="Nothing yet">
          Account notices, credit changes and security alerts will appear here.
        </Empty>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            borderTop: "1px solid var(--color-rule)",
          }}
        >
          {loaderData.items.map((item) => (
            <li
              key={item.id}
              style={{ padding: "1.125rem 0", borderBottom: "1px solid var(--color-rule-soft)" }}
            >
              <div
                style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}
              >
                <Pill tone={KIND_TONE[item.kind]}>{item.kind}</Pill>
                <span style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                  {formatRelative(item.createdAt)}
                </span>
              </div>
              <p style={{ fontWeight: 600, marginTop: "0.5rem" }}>{item.title}</p>
              {/* Rendered as text, never as HTML. */}
              <p style={{ marginTop: "0.25rem", color: "var(--color-muted)" }}>{item.body}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
