# Brand assets

Public by design — `middleware.ts` lets `/brand/*` through without a session,
because mail clients fetch images anonymously. Put nothing sensitive here.

## logo.png

Drop the company logo here as `logo.png` (PNG with a transparent or white
background, roughly 300–600px wide — it renders at 150px, so 2x keeps it
crisp on retina screens).

Then set the `company_logo_url` value on the **Settings** page to the
deployed URL:

    https://<your-dashboard-domain>/brand/logo.png

Templates generated after that use the image; until then they fall back to
the text wordmark in `renderSkeleton()` (`dashboard/lib/template.ts`).
