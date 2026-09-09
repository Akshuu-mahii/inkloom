/**
 * Server context passed from the Worker into every loader and action.
 *
 * React Router 8 replaced the loose `loadContext` object with typed contexts,
 * which is a real improvement here: a loader asking for `services` gets the
 * fully-typed service container, and a typo is a compile error rather than an
 * undefined at runtime.
 *
 * These contexts exist only on the server. Nothing in them is ever serialised
 * to the client — a loader returns plain data, never the container.
 */
import { createContext } from "react-router";
import type { Services } from "@inkloom/api";

export const servicesContext = createContext<Services>();

/** Per-response CSP nonce, so a route can mark its own inline script as trusted. */
export const nonceContext = createContext<string>();
