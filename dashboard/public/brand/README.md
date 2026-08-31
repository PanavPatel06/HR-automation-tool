# Brand assets

Public by design — `middleware.ts` lets `/brand/*` through without a session,
because mail clients fetch images anonymously and a login-gated URL reaches
candidates as a broken image. Put nothing sensitive here.

| File | What it is |
|---|---|
| `3SPACElogo(white).png` | The original upload, 1563×1563 with the artwork floating in a large margin. Kept as the source. |
| `logo.png` | What the emails actually use: the same artwork trimmed to its bounding box, background knocked out to transparency, exported at 450×220 (3× the 150px it renders at). |

## Replacing the logo

Overwrite `logo.png`. Keep it trimmed, transparent, and about 450px wide —
it renders at `width="150"` in the template header, and the extra pixels are
what keep it sharp on retina screens.

Nothing else needs changing: templates reference `{{company_logo_url}}`,
which `resolveLogoUrl()` in `dashboard/lib/template.ts` resolves per send to
`<deployment origin>/brand/logo.png`. Set the `company_logo_url` value on the
**Settings** page only if the logo needs to live somewhere else entirely.
