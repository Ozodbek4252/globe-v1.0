/**
 * Resolve a path under `public/` (data, images) against Vite's base URL.
 *
 * Every runtime fetch and image src goes through here so the site works when served
 * from a sub-path such as https://<user>.github.io/<repo>/.
 */
export function publicUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, '');
}
