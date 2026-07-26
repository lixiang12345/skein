# Skein website

The production site is a zero-dependency static artifact. Serve this directory
as the document root; no build step or remote runtime is required.

## Local verification

    npm run website:check
    python3 -m http.server 4173 --directory website

Open http://127.0.0.1:4173/. The repository-level Pages workflow publishes the
exact website directory after the main CI gate succeeds.

## Deployment assumptions

- Canonical URL: https://lixiang12345.github.io/skein/
- Document root: website/
- Custom error page: 404.html
- Hosts that support a _headers file receive the included security and cache
  policy. GitHub Pages ignores that file, so equivalent response headers need a
  CDN or custom host if the site later moves behind one.

The site intentionally contains no analytics, cookies, remote fonts, or
third-party scripts.
