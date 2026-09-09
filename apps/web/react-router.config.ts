import type { Config } from "@react-router/dev/config";

export default {
  /**
   * Server-side rendering, always.
   *
   * Marketing pages need real HTML for search engines and for social preview
   * crawlers, which do not run JavaScript. Authenticated pages need it so the
   * session is resolved on the server and a signed-out visitor never briefly
   * sees a dashboard shell before being redirected.
   */
  ssr: true,
} satisfies Config;
