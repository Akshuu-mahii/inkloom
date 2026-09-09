/**
 * Declarative page-view tracking.
 *
 * Dropped into a route to record one event when that page is opened. Fires once
 * per mount, so a client-side navigation back to the same page does not
 * double-count.
 */
import { useEffect, useRef } from "react";
import { track, type AnalyticsEvent } from "../lib/analytics";

export function TrackView({
  event,
  properties,
}: {
  event: AnalyticsEvent;
  properties?: Record<string, string | number | boolean>;
}) {
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    // `properties` is deliberately read but not depended on: a new object
    // identity on every render would re-fire the event and inflate every count.
    // The `sent` ref is what actually guarantees once-per-mount.
    track(event, properties);
  }, [event, properties]);

  return null;
}
