# aave.com — Full-Depth Design Replication Spec

> **Aave** — the decentralised non-custodial liquidity protocol, marketed by Aave
> Labs. Six years of uninterrupted operation, $3.46T lifetime deposits. The
> homepage is a four-product tour: Aave App (consumer savings), Aave Pro (full
> DeFi on v4), Aave Kit (developer integration stack), and a trust/proof section.
>
> Analysed 2026-07-28 at 1440×900 / 834×1112 / 390×844. All numbers below are
> measured from the live DOM (`getComputedStyle`, `getBoundingClientRect`,
> `document.fonts`, `performance.getEntriesByType('resource')`, enumerated
> `document.styleSheets`, `fetch()` on the emitted chunks) or quoted verbatim from
> source, never inferred.

---

## §0 — Site Map

Single page, `docHeight` **7,580px** at 1440×900. Proper `<header>` / `<main>` /
`<footer>` landmarks — the first site in this collection to get that right without
qualification.

`<main>` holds four themed containers followed by three plain sections:

| # | y (1440) | height | `data-theme` | Content |
|---|---------:|-------:|--------------|---------|
| 1 | 0 | 1,088 | **purple** | Aave App — hero, iOS CTA, 3 phone mockups, live earnings odometer |
| 2 | 1,088 | 1,772 | **dark** | Aave Pro — app screenshot, "Markets for every strategy", 3 market cards |
| 3 | 2,860 | 1,272 | **purple** | Aave Kit — "Build with Aave", 6-partner carousel |
| 4 | 4,132 | 1,900 | **light** | Trusted by Default — 6 stats, "The home of stablecoins", performance chart |
| 5 | 6,033 | 569 | — | FAQs (4-item accordion) |
| 6 | 6,602 | 394 | — | Stay Updated (email capture) |
| 7 | 6,996 | 584 | — | Footer — 6 nav columns, social, data partners, legal disclaimer |

Every themed container is `padding: 0 24px 24px` — the coloured panel is an
**inset rounded card**, not a full-bleed band. This is the structural decision that
makes the whole header behave (see §4).

Nav: Products / Solutions / Developers / Resources / About, each a `<button>`
opening an in-flow dropdown, plus a `Use Aave` pill. Footer links out to
`app.aave.com`, `pro.aave.com`, `push.co`, `governance.aave.com`,
`audits.sherlock.xyz`, `dune.com`, `defillama.com`, `tokenterminal.com`,
`aave.tokenlogic.xyz`.

---

## §1 — Stack Fingerprint

### Platform

```html
<html lang="en">
<body>
  <div id="__next"> … </div>
  <script id="__NEXT_DATA__" type="application/json"> … </script>
  <next-route-announcer></next-route-announcer>
```

**Next.js, Pages Router.** `/_next/static/chunks/pages/_app-*.js`,
`_buildManifest.js` / `_ssgManifest.js`, build ID `82z82cSSPSPDIgDqIzSQI`. No
`data-*` framework attributes on `<html>` or `<body>` — nothing else to
fingerprint from markup.

Styling is **CSS Modules**, unambiguously: `styles_container__KfcyI`,
`earning-indicator_wheelStrip__CbZdI`, `performance-chart_linesSvg__ViVxD`. No
Tailwind, no styled-components, no Emotion in use.

### Libraries, verified

Nothing is exposed on `window` — everything is bundled and minified with package
names stripped. Detection was by substring sweep across all 22 emitted chunks
(**2,515,975 chars** total), with every hit context-checked.

| Library | Verdict | Evidence |
|---------|---------|----------|
| **Framer Motion** (`motion/react`) | **REAL** | `data-framer-portal-id`, `"data-"+…("framerAppearId")`, `e.projection = new r(e.latestValues, …)`, `whileInView` ×6, `stagger` ×6 |
| **Radix UI** | **REAL** | `data-radix-focus-guard`, `window[Symbol.for("radix-ui")] = !0`, `radix-${t}` id generator |
| **`@number-flow/react`** | **REAL, but not on this page** | chunk `7145-*.js`: `--_number-flow-d-opacity`, `--_number-flow-d-width`. That chunk belongs to `/app`; `document.querySelector('number-flow')` is `null` here |
| **`qrcode`** | **REAL** | chunk `9964-*.js`: `qrToImageData`, `createImageData`, the QR alignment-pattern table |
| `zod` | **REAL** | chunk `3067-*.js` — form validation |
| `@emotion/is-prop-valid` | **optional, unresolved** | `try { s(require("@emotion/is-prop-valid").default) } catch {}` — Framer Motion's optional peer, wrapped in try/catch |
| `rive` | ❌ **false positive** | matched inside `getDerivedStateFromError` / `getDerivedStateFromProps` |
| `three` | ❌ **false positive** | matched inside a Next.js error string: `"Detected a three-dot character ('…')"` |
| `vaul` | ❌ **false positive** | matched inside the nav label **"Stable Vaults"** |
| `odometer` | ❌ **false positive** | matched CSS-module class names `earning-indicator_odometer__ohzAq` |

**Not present at all**: GSAP, ScrollTrigger, Lenis, Locomotive, three.js, PIXI,
regl, OGL, Lottie, SplitType, Splitting.js, Matter.js, anime.js, Swiper, Flickity,
Embla, keen-slider, react-slick, D3, Recharts, Victory, visx, Chart.js,
lightweight-charts, jQuery.

That last group matters: **the line chart, the partner carousel, the earnings
odometer and the entire animated background are all hand-written.** The only
third-party runtime is Framer Motion for transitions, Radix for primitives, and a
QR encoder.

### Weight

| Metric | Value |
|--------|------:|
| Resources | **81** |
| Decoded total | **≈5.0 MB** |
| JS chunks | 22 files, 2,515,975 chars |
| Hosts | **3** — `aave.com`, `fonts.googleapis.com`, `googletagmanager.com` (+ `google-analytics.com`) |

Heaviest single resources:

| File | Decoded |
|------|--------:|
| `_app-1eca0586ed364707.js` | **1,352 KB** |
| `aave-pro-borrow.svg` | **565 KB** |
| `hero-3.png` | 474 KB |
| `hero-2.png` | 332 KB |
| `hero-1.png` | 315 KB |
| `app-5325ae803604483b.js` | 246 KB (**fetched twice**) |
| `framework-*.js` | 185 KB |
| `main-*.js` | 134 KB |

Only three third-party hosts, and two of those are Google Analytics. Compare
[[tastelabs]] at **13 hosts**. This is a disciplined build — the 5 MB is almost
entirely first-party, and the 1.35 MB `_app` chunk is carrying the WebGL system
described in §7a.

Chunks for `/privacy-policy` and `/app` are **prefetched on the homepage and each
requested twice** (`privacy-policy-*.js` ×2, `app-*.js` ×2, `6446/7145/823/8775`
×2) — Next.js router prefetch firing on top of the `<link rel="prefetch">` hints.

---

## §2 — Colour System

**Seventy-nine custom properties on `:root`, and every single colour is declared
in `color(display-p3 …)`.** Not hex, not `rgb()`, not `oklch()` — wide-gamut P3
throughout, with no `@supports` fallback ladder. This is the most committed colour
setup in the collection.

```css
--bg-1:      color(display-p3 1 1 1/1);
--bg-3:      color(display-p3 0.9803921569 0.9803921569 0.9764705882/1);
--bg-panel:  color(display-p3 0.9843137255 0.9843137255 0.9843137255/1);
--border-1:  color(display-p3 0.9450980392 0.9450980392 0.9411764706/1);
--fg-1:      color(display-p3 0.1294117647 0.1137254902 0.1137254902/1);
--fg-2:      color(display-p3 0.3882352941 0.3803921569 0.3803921569/1);
--fg-3:      color(display-p3 0.5607843137 0.5568627451 0.5568627451/1);
--fg-4:      color(display-p3 0.737254902 0.7333333333 0.7333333333/1);
```

The `--fp-*` ramp is the same ink at six alphas — one hue, six weights, so text
hierarchy never introduces a second colour:

```css
--fp-0: color(display-p3 0.1450980392 0.1333333333 0.1568627451/1);
--fp-1: …/1;   --fp-2: …/0.9;  --fp-3: …/0.65;
--fp-4: …/0.5; --fp-5: …/0.4;  --fp-6: …/0.3;
```

Eight purples, three yellows, four blues, plus asset-specific and semantic tokens:

```css
--purple-1 … --purple-8      /* 0.596 0.588 1  →  0.898 0.898 1 */
--icon-purple-1 … --icon-purple-7
--yellow-1 … --yellow-3      --blue-1 … --blue-4
--gho-1:  color(display-p3 0.1568627451 0.8274509804 0.3450980392/1);
--usdc-1: color(display-p3 0.1529411765 0.4588235294 0.7921568627/1);
--usdt-1: color(display-p3 0.1490196078 0.631372549  0.4823529412/1);
--earned-green: color(display-p3 0.0039215686 0.8156862745 0.3843137255/1);
--rich-purple:  color(display-p3 0.5254901961 0.4509803922 1/1);
--deep-purple:  color(display-p3 0.2980392157 0.1215686275 0.368627451/1);
--warm-purple:  color(display-p3 0.7568627451 0.5607843137 1/1);
--push-color:   color(display-p3 0 0 1/1);
--wallet:  color(display-p3 0.0039215686 0.5529411765 1/1);
--account: color(display-p3 0 0.7882352941 0.4705882353/1);
--focus:   color(display-p3 0.5960784314 0.5960784314 1/1);
--fr-1:    color(display-p3 0.9490196078 0.2862745098 0/1);   /* error */
```

Semantic aliases sit on top, so components never name a hue:

```css
--primary:        var(--purple-3);
--primary-text:   #fff;
--error-color:    var(--fr-1);
--control-hover:  color-mix(in srgb, var(--fg-1) 4.5%, transparent);
--menu-icon-surface: var(--bg-2);
--inset-highlight:   rgb(255 255 255/0.15);
```

### The theme system

Three themes, applied as `data-theme` on the section container — no class
toggling, no JS colour tweening (contrast [[ninesixty]], which animates
`body { backgroundColor }` on a ScrollTrigger):

```css
.styles_container__KfcyI[data-theme="light"]  .styles_bgWrap__Zd6Bj { background: rgb(255,255,255); }
.styles_container__KfcyI[data-theme="purple"] .styles_bgWrap__Zd6Bj { background: rgb(255,255,255); }
[data-theme="dark"] .styles_content__nyVFf {
  background-color: rgb(26,26,27);
  box-shadow: rgb(49,49,50) 0 0 0 1px inset, rgba(0,0,0,0.03) 0 1px 2px;
}
[data-theme="dark"] .styles_menuDivider__Vi2e3   { background-color: rgb(49,49,50); }
[data-theme="dark"] .styles_navigationLink__rq9hz{ border-color: rgba(255,255,255,0.08); background-color: rgb(26,26,27); }
[data-theme="dark"] .styles_navigationLink__rq9hz:hover { border-color: rgba(255,255,255,0.12); }
```

Sequence down the page: **purple → dark → purple → light**.

### Motion tokens

```css
--duration-snappy: 750ms;   --ease-snappy: cubic-bezier(0.175, 0.885, 0.32, 1.1);
--duration-swift: 1800ms;   --ease-swift:  cubic-bezier(0.19, 1, 0.22, 1);
```

`--ease-snappy` overshoots — the `1.1` y₂ endpoint puts a small bounce at the end.
`--ease-swift` is a standard expo-out. Note the names read backwards against the
values: **"snappy" is 750ms and "swift" is 1800ms**, so "swift" is the slower of
the two. Worth knowing before you reuse the names.

### Layout tokens

```css
--breakpoint-sm: 640px;  --breakpoint-md: 768px;  --breakpoint-lg: 1024px;
--scrollbar-width: 6px;
```

**Six declared properties are never referenced**: five `--swiper-*` (a fossil from
a Swiper integration that is not in any chunk) and `--grey-soft`.

---

## §3 — Typography

### Faces

| Family | Weights | Format | Loaded on this page? |
|--------|---------|--------|----------------------|
| **Aave Repro** (variable) | variable | `woff` + `woff2` | ✅ — the workhorse |
| **Aave Aguzzo** (variable) | 100–800 | `woff2` | ✅ — accent italics only |
| **Inter Variable** | 100–900 | `woff2` | ✅ — inside the phone mockups |
| Aave Repro Mono (variable) | 400–900 | `woff` + `woff2` | ❌ **preloaded, never used** |
| FT Regola Neue Semibold | 600 | **`.otf`** | ❌ **preloaded, never used** |
| FT Regola Neue Bold | 700 | **`.otf`** | ❌ **preloaded, never used** |

All six use `font-display: swap`.

Three problems, each verified via `document.fonts` status:

1. **Four `<link rel="preload">` fonts never render.** `AaveReproMonoVariable`
   (`woff` *and* `woff2`), `FTRegolaNeue-Semibold.otf` and
   `FTRegolaNeue-Bold.otf` are all preloaded from `<head>` and all report
   `unloaded`. A live count of elements resolving to either family returns **0**.
   Preload is the strongest hint the platform has; spending it on four fonts the
   page never paints is a measurable regression.
2. **The two FT Regola Neue faces are `.otf`**, not `woff2` — typically 2–4× the
   bytes, for fonts that go unused anyway.
3. **Inter is loaded twice.** `/fonts/InterVariable.woff2` is self-hosted and
   `loaded`; a second `<link rel="stylesheet">` to
   `fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap` declares
   **seven more `Inter` faces**, all `unloaded`. That request, plus the two
   `preconnect`s that precede it, is the entire reason `fonts.googleapis.com` and
   `fonts.gstatic.com` appear in the host list.

### Scale

```
--font-sans:   "Aave Repro", ui-sans-serif, system-ui, -apple-system, …
--font-serif:  "Aave Aguzzo", ui-serif, Georgia, Cambria, "Times New Roman", …
--font-mono:   "Aave Repro Mono", ui-monospace, SFMono-Regular, Menlo, …
--font-app:    "Inter Variable", "Inter", sans-serif
--font-regola: "FT Regola Neue", var(--font-app)
```

| Role | Family | Size / LH / Tracking @1440 | Weight |
|------|--------|---------------------------|--------|
| `h1` | Aave Repro | **72 / 79.2 / −3.6px** | 500 |
| `h1` accent | **Aave Aguzzo italic** | 72 / 79.2 / −3.6px | 500 |
| `h2` | Aave Repro | 40 / 48 / −1.2px | 500 |
| `h3` card | Aave Repro | 20 / 27 / −0.2px | **450** |
| lead `p` | Aave Repro | 20 / 27.2 / −0.2px | 400 |
| nav button | Aave Repro | 14 / normal / normal | 450 |
| CTA | Aave Repro | 17px | — |
| footer column head | Aave Repro | 14 / 15.4 / **1%** | 450 |

Tracking is negative and scales with size — **−0.05em at every heading step**
(72 → −3.6, 40 → −1.2 is −0.03em, 20 → −0.01em). The footer column heads are the
only positive tracking on the page, at `1%`.

**Weight 450** is used for UI text (nav, card titles, footer heads) — a variable-font
half-step between Regular and Medium that a static family could not provide. That,
plus 500 for headings and 400 for body, is the whole weight system.

### The accent word

Every `h1` puts one or two words in **Aave Aguzzo italic**, purple. Four instances:

| Heading | Accent | Treatment |
|---------|--------|-----------|
| Savings for **Everyone** | Everyone | flat `color(display-p3 0.592 0.557 1)` |
| The **Full Power** of DeFi | Full Power | **gradient text** |
| Build **with Aave** | with Aave | flat purple |
| **Trusted** by Default | Trusted | flat purple |

Only the one on the dark panel gets the gradient, and it is a real three-stop
`background-clip: text`:

```css
color: rgba(0, 0, 0, 0);
-webkit-text-fill-color: rgba(0, 0, 0, 0);
background-clip: text;
background-image: linear-gradient(134deg,
  color(display-p3 0.898039 0.898039 1) 0px,
  rgb(147, 145, 254) 49.47%,
  color(display-p3 0.898039 0.898039 1) 91.25%);
```

Note the mixed colour spaces inside one gradient — P3 endpoints, sRGB midpoint.

### Word-level splitting

Headings are split into per-word spans for the stagger, and Framer Motion leaves
its inline styles in place after settling:

```html
<h1 class="styles_heading__VB3wz styles_level1Large__bDeUm styles_title__G9AAz">
  <span>
    <span style="display: inline-block; position: relative; opacity: 1; transform: none;">Savings</span>
    <span style="display: inline-block; position: relative; opacity: 1; transform: none;">for</span>
  </span>
  <span class="styles_highlight__dzRbM">
    <span><span style="display: inline-block; position: relative; opacity: 1; transform: none;">Everyone</span></span>
  </span>
</h1>
```

Words, not characters — so screen readers still announce the heading correctly.
That is the right call, and the opposite of [[tastelabs]], whose per-character
split makes navigation read as `A b o u t`.

---

## §4 — Layout & Spacing

### The inset-card structure

Every themed section is `padding: 0 24px 24px` on the container, with the coloured
surface as an inner rounded card. The consequence is worth stating plainly: **the
page background behind the fixed header stays light at every scroll position**, so
the header never has to invert, never needs a scrolled state, never needs a
backdrop blur.

Verified at four scroll positions across all four themes:

| Scroll y | Active theme | Logo fill | Nav button colour |
|---------:|--------------|-----------|-------------------|
| 0 | purple | `rgb(39,34,40)` | `rgb(39,34,40)` |
| 1,500 | **dark** | `rgb(39,34,40)` | `rgba(39,34,40,0.65)` |
| 3,100 | purple | `rgb(39,34,40)` | `rgb(39,34,40)` |
| 4,400 | light | `rgb(39,34,40)` | `rgb(39,34,40)` |

Header computed state, unchanged throughout:

```css
position: fixed; top: 0; z-index: 100; height: 82px (64px when collapsed);
background-color: rgba(0, 0, 0, 0);
backdrop-filter: none;
mix-blend-mode: normal;
```

`Use Aave` is `rgb(37,34,40)` on white text; nav buttons are ink at 65% alpha.
Every CTA on the page is `border-radius: 99px`, `padding: 0 24px`, `17px`:

| Button | Background | Colour |
|--------|-----------|--------|
| Download on iOS | `color(display-p3 0.592157 0.556863 1)` | `#fff` |
| Learn More (purple section) | `rgba(151,142,255,0.1)` | `color(display-p3 0.52 0.47 1)` |
| Get Started (dark section) | `rgb(255,255,255)` | `rgb(37,34,40)` |
| Learn More (dark section) | `rgba(255,255,255,0.1)` | `#fff` |

Primary/ghost pairing, restated per theme — never a border, always a tinted fill
at 10%.

Section padding steps 24px → 24px → **8px** at 390.

---

## §5 — Components

### §5a — The WebGL background field — the showpiece

Four `<canvas>` elements, one per themed section, plus a fifth in the light
section. They render a **domain-warped fBm noise field distorted by a real
Navier–Stokes fluid simulation**, and the source ships with its authoring comments
intact inside the GLSL template literals.

**Rendered at roughly a tenth of display size and upscaled by the browser:**

| Viewport | Canvas intrinsic | CSS size | Ratio |
|----------|-----------------|----------|------:|
| 1440 | **139 × 106** | 1386 × 1064 | ~10× |
| 834 | 78 × 100 | 780 × 999 | ~10× |
| 390 | **37 × 91** | 368 × 915 | ~10× |

`image-rendering: auto`, so bilinear upscaling *is* the blur. A full-resolution
soft gradient for the cost of ~15,000 fragments.

**WebGL2** (`#version 300 es`), three programs — display, separable blur, and the
fluid solver. The blur pass is a 5-tap Gaussian with dithering deferred to the
final write:

```glsl
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float s = u_radius * 0.25;
  vec2 o1 = u_direction * u_texel * (1.3846153846 * s);
  vec2 o2 = u_direction * u_texel * (3.2307692308 * s);
  vec4 c  = texture(u_tex, uv)      * 0.2270270270;
  c += texture(u_tex, uv + o1) * 0.3162162162;
  c += texture(u_tex, uv - o1) * 0.3162162162;
  c += texture(u_tex, uv + o2) * 0.0702702703;
  c += texture(u_tex, uv - o2) * 0.0702702703;
  // Dither just before the 8-bit canvas write (vertical pass only) — after the full blur so the
  // low-pass doesn't wash it out; same offset on all channels preserves premultiplied alpha.
  if (u_dither > 0.5) c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = c;
}
```

Interleaved-gradient-noise dithering at ±½ LSB is what keeps a near-flat gradient
from banding on an 8-bit canvas. Applying it only on the pass that writes the
canvas — after the blur, so the low-pass doesn't erase it — is exactly right.

**The hash function carries a performance note in the source:**

```glsl
// Toggle a cheap ALU hash (no sin/SFU) — the most direct fix for the transcendental load that heats
// integrated GPUs (see plan step 6). ENABLED below to cut GPU heat; comment out to A/B. The pattern
// shifts (different pseudo-random lattice), so re-tune u_low/u_high (levels) — the CSS blur hides the
// micro change.
#define USE_FAST_HASH
float rand(vec2 n) {
#ifdef USE_FAST_HASH
  // Dave Hoskins-style hash: all multiply/add/fract on the main ALU, no transcendentals.
  vec3 p3 = fract(vec3(n.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
#else
  return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
#endif
}
```

Value noise, smoothstep-interpolated, then fBm with an early return so a lower
octave count is genuinely cheaper, then domain warping:

```glsl
float noise(vec2 p) {
  vec2 ip = floor(p);  vec2 u = fract(p);
  u = u*u*(3.0-2.0*u);
  float res = mix(mix(rand(ip),            rand(ip+vec2(1.0,0.0)), u.x),
                  mix(rand(ip+vec2(0.0,1.0)), rand(ip+vec2(1.0,1.0)), u.x), u.y);
  return res*res;
}
const mat2 mtx = mat2(0.80, 0.60, -0.60, 0.80);

float pattern(in vec2 p) {
  // u_warp scales the domain-warp offset: 1 = full swirl (original), 0 = plain fbm (no swirl).
  return fbm(p + u_warp * fbm(p + u_warp * fbm(p)));
}
```

A **seamless radial loop** — two phase-offset samples cross-faded by a triangle
wave, so the outward drift never visibly restarts:

```glsl
float computeShade(vec2 d, vec2 seedOff) {
  vec2 dir = d / max(length(d), 1e-4);
  float t = u_time * u_speed;
  float ph1 = fract(t);
  float ph2 = fract(t + 0.5);
  float blend = abs(1.0 - 2.0 * ph1);          // triangle wave
  float s1 = pattern(d * u_scale - dir * ph1 * u_flow + seedOff);
  float s2 = pattern(d * u_scale - dir * ph2 * u_flow + seedOff);
  float shade = mix(s1, s2, blend);
  // Levels remap (Photoshop-style): noise <= u_low -> 0, >= u_high -> 1, linear between.
  return clamp((shade - u_low) / max(u_high - u_low, 1e-5), 0.0, 1.0);
}
```

**A CSS `cubic-bezier` solved in GLSL** — five Newton iterations — so the shader's
fade can be authored with the same easing vocabulary as the CSS:

```glsl
float cubicBezier(float t, vec4 e) {
  float s = t;
  for (int i = 0; i < 5; i++) {
    s = clamp(s - (bezAxis(s, e.x, e.z) - t) / max(bezDX(s, e.x, e.z), 1e-3), 0.0, 1.0);
  }
  return bezAxis(s, e.y, e.w);
}
```

**Chromatic aberration by screen-space derivative** instead of re-sampling — the
comment states the tradeoff and the measured saving:

```glsl
// We approximate the offset-sampled channels from the screen-space gradient of the shade
// (dFdx/dFdy) instead of re-evaluating the expensive pattern twice more: ~identical at subtle
// strength, ~3x cheaper.
float dShade = (dFdx(shadeG) * off.x + dFdy(shadeG) * off.y) * (u_resolution.y / u_heightScale);
shadeR = clamp(shadeG + dShade, 0.0, 1.0);
shadeB = clamp(shadeG - dShade, 0.0, 1.0);
```

Colour is a branchless three-stop gradient in **premultiplied** alpha, so a
transparent stop stays clean:

```glsl
vec4 grad3(vec4 c1, vec4 c2, vec4 c3, float t, vec3 s) {
  float t1 = clamp((t - s.x) / max(s.y - s.x, 1e-4), 0.0, 1.0);
  float t2 = clamp((t - s.y) / max(s.z - s.y, 1e-4), 0.0, 1.0);
  return mix(mix(c1, c2, t1), c3, t2);
}
```

An **iris mask for route transitions**, skipped entirely at rest — and the comment
justifies why the branch is free:

```glsl
// Gated on u_maskActive: at rest the iris is fully open (1 everywhere), so we skip the extra
// pattern() call entirely — a coherent uniform branch (every pixel takes the same path), so
// there's no divergence cost.
float iris = 1.0;
if (u_maskActive > 0.5) {
  vec2 mc = (uv - vec2(0.5, 1.0 + u_maskOffsetY)) * vec2(aspect / u_maskWidth, 1.0);
  float rr = length(mc);
  float maxR = sqrt(0.25 * aspect * aspect + 1.0);              // top-center -> farthest corner
  float mn = pattern(d0 * u_scale + seedOff + vec2(53.3, 71.9)); // decorrelated seed
  float boundary = rr + (mn - 0.5) * u_maskNoise;               // organic edge displacement
  float radius = u_maskRadius * maxR;
  iris = smoothstep(radius + u_maskFeather, radius - u_maskFeather, boundary);
}
```

**The fluid simulation** is a full GPU Navier–Stokes solver on ping-pong FBOs:
curl → vorticity confinement → divergence → pressure → gradient subtract →
advection with dissipation. The pressure solve runs **exactly one Jacobi
iteration** — `for (let e = 0; e < 1; e++)` — a deliberate quality/cost trade for a
field that is blurred 10× anyway. Pointer input is splatted along the movement
path, subdivided into up to **64** sub-splats so a fast flick still paints a
continuous stroke rather than dots:

```js
let l = Math.min(64, Math.max(1, Math.ceil(p / Math.max(.004, .5 * Math.sqrt(e)))));
for (let r = 1; r <= l; r++) { let n = r / l; this.splat(a + t*n, s + i*n, u, c, e, o); }
this.motionEnergy = .92 * this.motionEnergy + 13 * p;
```

The default config object, verbatim — this is the whole tuning surface:

```js
{
  colorStops: [0.2, 0.85, 1],
  motion:    { speed: 0.15, morph: 0.35, flow: 0.75 },
  texture:   { scale: 1.25, octaves: 4.5, warp: 0.25 },
  mask:      { radius: 1.5, width: 1, noise: 0.3, feather: 0.4, offsetY: 1, active: true },
  spotlight: { active: false, centerOpacity: 1, edgeOpacity: 0.66, radius: 0.35, feather: 0.5 },
  origin:    { x: 0.5, y: 1 },
  fade:      { start: 0.35, end: 1, ease: [0.42, 0, 0.58, 1], fromBottom: false },
  levels:    { low: 0, high: 1 },
  chroma:    { amount: 0.15 },
  fluid:     { curl: 5, dissipation: 0.99, radius: 1.25, force: 6000,
               ambient: 1.8, distort: 0.0015, follow: 0.15, agitation: 5, timeScale: 1 },
  pointer:   { track: 1, push: 0.02, steer: 0.6 },
  render:    { scale: 0.25, blur: 6 },
  seed: 0, timeOffset: 0, timeScale: 1, preview: 0
}
```

The comments reference a **"ShaderPlayground"** control panel and a numbered
internal plan ("see plan step 6"), so this was built against a live tuning UI.

**Runtime guards**, all verified in source:

| Guard | Implementation |
|-------|---------------|
| Mobile downscale | `u = innerWidth <= 980`, then `d = u ? Math.min(scale, 0.2) : scale` |
| DPR cap | `Math.min(devicePixelRatio || 1, u ? 1.5 : 2)` |
| Frame limiter | `if (e - j < 14.666666666666668) return;` → **~68 fps ceiling** |
| Fixed-step sim | `for (; _ >= a && i < 5; ) { stepSim(); _ -= a; i++; } if (i === 5) _ = 0;` — max 5 catch-up steps, then drop the backlog |
| Tab hidden | `document.addEventListener("visibilitychange", …)` cancels the rAF |
| Context loss | `webglcontextlost` → `preventDefault()` + stop; `webglcontextrestored` → rebuild, with `console.error("Header shader: WebGL context restore failed", e)` |
| Resize | `ResizeObserver` with a **500 ms** debounce |
| Pointer | `pointermove` ignored entirely when `innerWidth <= 980` |
| Fade region | trimmed with `clipPath: inset(…)` so faded pixels are never composited |

### §5b — Live earnings odometer

Inside the hero phone mockup, `$10.000450 Earned · Past Week` ticks upward
continuously. Six digit wheels, hand-built as CSS-module components — **not**
`@number-flow/react`, which is bundled but scoped to `/app`.

Each wheel is a strip of ten digits inside an 18px window:

```
.earning-indicator_wheelStrip__CbZdI
  height: 180px   (10 digits × 18px)
  children: 10    ("9876543210")
  transform: matrix(1, 0, 0, 1, 0, -162)      /* −162 / 18 = digit index 9 */
  transition: transform 0.35s cubic-bezier(0.33, 1, 0.68, 1)
parent: overflow: hidden; height: 18px
```

`cubic-bezier(0.33, 1, 0.68, 1)` is ease-out-cubic. Digits run **9→0 downward**, so
an increment is a downward roll.

A pulsing dot marks it live, with two independent keyframes on different easings —
opacity on `ease-in-out`, scale on `cubic-bezier(0.455, 0.03, 0.515, 0.955)`
(ease-in-out-quad), both at **1.6s** so they stay phase-locked:

```css
.earning-indicator_dot__X23H0 {
  width: 7.1px; height: 7.1px; border-radius: 50%;
  background: color(display-p3 0.00392157 0.815686 0.384314);   /* --earned-green */
  animation: 1.6s ease-in-out infinite earn-pulse-opacity,
             1.6s cubic-bezier(0.455,0.03,0.515,0.955) infinite earn-pulse-scale;
}
```

### §5c — Performance chart

Hand-authored SVG, **922 × 360**, no chart library. Two stacked `<svg>`s:

- `performance-chart_gridSvg__OcLG_` — 4 `<line>` gridlines in 4 `<g>` groups, 6
  `<text>` labels (`$13k $12k $11k $10k` and `2021`…`2026`)
- `performance-chart_linesSvg__ViVxD` — 4 `<path>`

| Path | Stroke | Width | Fill | Length |
|------|--------|------:|------|-------:|
| area | none | — | `url(#about-area)` | 2,024 |
| Aave (USDC) | `color(display-p3 0.592157 0.556863 1)` | 2px | none | 912 |
| T-Bills | `rgb(110,109,111)` | 2px | none | 907 |
| Savings Account | `rgb(162,162,162)` | 2px | none | 878 |

Paths are cubic Béziers with control points at ⅓ spacing — Catmull-Rom converted
to Bézier, the standard smooth-line construction:

```
M 44 320 C 102.53333333333333 295.84 161.0666666666667 265.13666666666666 219.6 …
```

x-step is **58.533px** per control point (175.6px per data point). All three series
start at exactly `y = 320`, i.e. $10,000, so the divergence reads instantly. Value
pills sit at the line ends: **$12,321 / $11,851 / $10,152**.

`stroke-dasharray: none` and `stroke-dashoffset: 0px` measured at rest — the lines
are not drawn by a dash-offset reveal.

### §5d — Partner carousel

Native-scroll, hand-rolled, no library:

```css
.styles_carousel__ndXKn { display: flex; gap: 23px; overflow: visible; }
.styles_track__PT7wA     { display: flex; gap: 16px; overflow: auto; }
```

Six cards; `Previous` and `Next` are `<button aria-label>` and the Previous button
is correctly `disabled` at position 0. Because the track is a real scroll
container, keyboard and trackpad scrolling work without any JS. Cards:

| Partner | Stat | Caption |
|---------|------|---------|
| Whop | 21M+ users | with yield powered by Aave. |
| MetaMask | 100M+ users | with access to Aave-powered yield. |
| Cap | $360M+ supplied | 90% of stcUSD yield from Aave. |
| Ethena | $10B reached | in 500 days. |
| Kraken | ~60% | lending market share. |
| Kinexys by J.P. Morgan | J.P. Morgan | validated institutional DeFi on Aave. |

### §5e — Navigation dropdown

Not an overlay — the dropdown is **in flow and pushes the page down**, animating
its own height:

```html
<nav class="styles_navigation__LrkPB styles_open__X9ppk" style="height: 94px;">
  <div class="styles_navigationLinksContainerWrapper__SZrco">
    <div class="styles_navigationLinksContainer__1k_ff" style="opacity: 1; transform: none;">
      <a class="styles_navigationLink__rq9hz" href="/app"> … </a>
```

Header height goes 82 → 176px with the panel open. Each entry is icon + title +
version tag + description (`Aave App / Savings for everyone`, `Aave Pro ᵛ⁴ / The
full power of DeFi`, `Aave ᵛ³ / The original DeFi protocol` with an external-link
arrow). The trigger gains `styles_active__I9iOk`.

### §5f — FAQ accordion

Framer Motion height animation, measured live:

| State | item height | content opacity | `data-is-open` |
|-------|------------:|----------------:|----------------|
| closed | 72px | 0 | `false` |
| +200 ms | 173px | 0.553 | `true` |
| settled | 176px | 1 | `true` |

The inner wrapper stays a constant `104px`; the **item** animates 72 → 176 and
clips. State lives on `data-is-open`, alongside `data-show-number` and
`data-color="purple"` — a clean declarative surface. Its accessibility is not
clean; see §10.

### §5g — Stats grid

Six proof points in the light section:

| Value | Label |
|-------|-------|
| **6+ Years** | Of uninterrupted operation. |
| **$3.46T** | Lifetime deposits. |
| **$1T** | Lifetime borrows. |
| **$88.44B** | Monthly volume across markets. |
| **$1.92B** | Interest earned by lenders. |
| **SOC 2 Type 2** | Annual security audit. |

### §5h — Market cards

Three cards, each an eyebrow + `h3` + description + token chips:

| Eyebrow | Name | Tokens |
|---------|------|--------|
| General Purpose | **Main** | AAVE, USDC, wETH, wBTC, LINK, **+4 More** |
| Collateral-Isolated | **Bluechip** | wETH, wstETH, wBTC, cbBTC |
| Strategy-Isolated | **Ethena Correlated** | PT-sUSDe, PT-USDe, sUSDe, USDe |

---

## §6 — Imagery & Media

**28 `<img>`, 37 `<svg>`, 5 `<canvas>`, 0 `<video>`, 0 `<picture>`.**
25 of the 28 images are `next/image` (`data-nimg="1"`).

**Every raster asset on the page is PNG.** Verified by fetching:

| Asset | Content-Type | Size |
|-------|-------------|-----:|
| `/images/app/hero/row/hero-1.png` | `image/png` | **315 KB** |
| `/images/app/hero/row/hero-2.png` | `image/png` | **332 KB** |
| `/images/app/hero/row/hero-3.png` | `image/png` | **474 KB** |
| `/_next/image?url=%2Ftokens%2FAAVE.png&w=32&q=75` | `image/png` | 1 KB |

Two distinct problems:

1. **The three hero phone mockups bypass the image pipeline entirely.** They are
   `<link rel="preload">`ed as raw `/images/…png` and never routed through
   `/_next/image`, so they get no resizing, no quality step, no format
   negotiation — **1,121 KB of PNG** preloaded before anything else on the page.
2. **Even the images that *do* go through `/_next/image` come back as PNG.** The
   token icon request returns `image/png`, not WebP or AVIF, so modern formats are
   not being negotiated. No `<picture>` and no `<source type>` anywhere as a
   fallback.

`aave-pro-borrow.svg` is **565 KB** — the Aave Pro app screenshot shipped as vector
rather than raster. It is the second-heaviest asset on the page and would almost
certainly be smaller as a well-tuned raster.

Static assets return `cache-control: public, max-age=0, must-revalidate` — no
long-lived caching on content-addressed files.

Alt text: product icons are labelled (`"Aave App icon"`, `"Aave Pro icon"`), token
chips carry their symbol (`"AAVE"`, `"USDC"`), partner logos are `"Whop logo"` etc.
The three hero phone mockups are `alt=""` — defensible, since the adjacent copy
carries the meaning.

---

## §7 — Motion: Detection → Prescription

### §7a — What actually ships

**Ten `@keyframes`**, all CSS-module-scoped:

| Name | Purpose |
|------|---------|
| `scrim-enter` | route/overlay scrim |
| `root-enter` | page mount |
| `styles_loading__kLz3f`, `styles_loading___r_tU` | two loading spinners |
| `styles_fade-up-centre__4IXqL` | centre-anchored fade-up |
| `styles_fade-up-side__S0R5d` | side-anchored fade-up |
| `earning-indicator_earn-pulse-opacity__MW_Jm` | odometer dot, opacity |
| `earning-indicator_earn-pulse-scale__R9rPQ` | odometer dot, scale |
| `styles_fadeIn__sujx_` | generic fade |
| `styles_spin__rFxEC` | spinner rotation |

**Framer Motion** handles entrances and layout: `whileInView` ×6, `stagger` ×6,
per-word heading reveals, the accordion's height animation, the nav dropdown's
height animation, the carousel.

**Two rAF systems:** the shader/fluid loop (68 fps cap, fixed-step sim) and the
odometer tick.

**Two named duration/ease pairs** in CSS (§2), plus per-component eases:
`cubic-bezier(0.33, 1, 0.68, 1)` for the odometer roll,
`cubic-bezier(0.455, 0.03, 0.515, 0.955)` for the dot scale.

**Media queries:** 45 × `(max-width: 768px)`, 15 × `(hover: hover)`, then
980 / 1024 / 1000 / 900 / 820 / 600 / 520 / 412 — nine breakpoints in total, with
768 doing most of the work. **44 `:hover` rules, 10 `:focus-visible` rules.**

### §7b — What is *not* here

| Absent | Evidence |
|--------|----------|
| GSAP / ScrollTrigger / ScrollSmoother | no substring match in 2.5 M chars |
| Lenis / Locomotive | absent; native scroll throughout |
| three.js / PIXI / regl / OGL | absent — WebGL2 is called directly |
| Any chart library | the SVG paths are hand-built cubic Béziers |
| Any carousel library | the track is `overflow: auto` |
| Lottie | absent |
| SplitType / Splitting.js | word splitting is done in React |
| Scroll-driven CSS animations | no `animation-timeline`, no `@scroll-timeline` |
| View Transitions API | no `startViewTransition` |
| Header scroll state | header is transparent at every position (§4) |
| JS colour tweening | themes are static `data-theme` CSS |

### §7c — Reduced motion — the strongest result in the corpus

Two CSS blocks, and they are not "turn off transitions". The first **replaces the
shader with a static gradient that matches it**:

```css
@media (prefers-reduced-motion: reduce) {
  .styles_container__KfcyI[data-theme="light"]  .styles_bgWrap__Zd6Bj {
    background: linear-gradient(rgb(255,255,255) 20%, rgb(246,247,244)), rgb(255,255,255);
  }
  .styles_container__KfcyI[data-theme="purple"] .styles_bgWrap__Zd6Bj {
    background: linear-gradient(rgb(255,255,255) 20%, rgba(151,142,255,0.4)), rgb(255,255,255);
  }
  .styles_container__KfcyI[data-theme="dark"]   .styles_bgWrap__Zd6Bj {
    background: linear-gradient(rgba(15,15,16,0.85), rgba(31,31,33,0.85)), linear-gradient(193deg, …);
  }
}
```

The second stops the odometer:

```css
@media (prefers-reduced-motion: reduce) {
  .earning-indicator_dot__X23H0     { animation: auto ease 0s 1 normal none running none; }
  .earning-indicator_wheelStrip__CbZdI { transition: none; }
}
```

**And the JS honours it too.** Emulating `prefers-reduced-motion: reduce` and
reloading:

| | Normal | Reduced |
|---|---|---|
| `<canvas>` count | **5** | **0** |
| `bgWrap` background | `rgb(255,255,255)` | `linear-gradient(rgb(255,255,255) 20%, rgba(151,142,255,0.4)), rgb(255,255,255)` |

The shader component is **not rendered at all** — no WebGL context is created, no
fluid FBOs are allocated, no rAF starts. The CSS gradient stands in, and a
screenshot under reduced motion is visually near-identical to the normal page.

That is the correct pattern, and it is stricter than everything else measured so
far: [[ouro-labs]] guards 15 CSS blocks and 8 scripts but still animates;
[[tastelabs]]' deck branches at nine sites but keeps rendering;
[[ninesixty]] does nothing at all. Aave is the only one that **removes the
expensive thing entirely and substitutes a designed static equivalent**.

Framer Motion's own `useReducedMotion` is present in the bundle
(`matchMedia("(prefers-reduced-motion)")`), so component entrances are covered by
the library.

### §7d — Prescription for a rebuild

| Effect | Site uses | A rebuild needs |
|--------|-----------|-----------------|
| Background field | hand-written WebGL2 + fluid solver | keep it, or substitute a static CSS gradient — the reduced-motion path already proves the gradient reads fine |
| ¼–1/10 render + browser upscale | `render.scale`, `image-rendering: auto` | same trick, ~40 lines. Works for any canvas effect |
| GLSL cubic-bezier | 5-iteration Newton solve | same, ~15 lines — lets one easing vocabulary span CSS and shaders |
| Dithered gradient | interleaved gradient noise, ±½ LSB | same 3 lines. Cheapest banding fix there is |
| Word-stagger headings | Framer Motion | CSS `@keyframes` + `animation-delay` on server-rendered word spans, 0 KB |
| Accordion / dropdown height | Framer Motion height animation | `grid-template-rows: 0fr → 1fr`, 0 KB |
| Scroll reveals (`whileInView`) | Framer Motion | `IntersectionObserver` + a class, or `animation-timeline: view()` |
| Line chart | hand-built cubic Bézier SVG | same — no library needed for 3 series |
| Carousel | `overflow: auto` + 2 buttons | same, plus `scroll-snap-type: x mandatory` |
| Odometer | 10-digit strip + `translateY` | same, or `@number-flow/react` (already in the monorepo) |
| Theme switching | static `data-theme` CSS | same |

**Tier: React-app.** Framer Motion is doing real work across a dozen components
and is a reasonable keep at this scale; the WebGL background is irreducible if you
want it. But the honest budget is far lower than what ships: **Framer Motion could
be dropped entirely** — every animation it drives here (word stagger, height
transitions, in-view fades) has a 0 KB CSS equivalent, and the accordion's
`height: auto` problem is solved by `grid-template-rows` today. That would take a
1,352 KB `_app` chunk down substantially while leaving the shader — the only part a
visitor would actually miss — untouched.

---

## §8 — Responsive

Nine breakpoints in CSS; **768px** carries 45 of the 78 media queries. The shader
uses its own **980px** threshold, which does not align with any CSS breakpoint.

| Measure | 1440×900 | 834×1112 | 390×844 |
|---------|---------:|---------:|--------:|
| `docHeight` | 7,580 | 8,651 | **10,243** |
| `h1` size / LH / tracking | 72 / 79.2 / −3.6 | **72 / 79.2 / −3.6** | 48 / 52.8 / −1.44 |
| `h2` | 40 | 40 | **28** |
| `h3` | 20 | 20 | 20 |
| Lead `p` | 20 | 20 | 20 |
| Header height | 82 | 64 | 64 |
| Section padding | `0 24px 24px` | `0 24px 24px` | **`0 8px 8px`** |
| Nav buttons | 5 visible | 5 visible | **container `display: none`** |
| `Use Aave` | visible | visible | `display: none` |
| Hamburger | — | — | 32 × 32 |
| Canvas intrinsic | 139 × 106 | 78 × 100 | **37 × 91** |
| Canvas CSS | 1386 × 1064 | 780 × 999 | 368 × 915 |
| Chart | 922 × 360 | 620 × 360 | **264 × 280** |
| Market cards | **row** | stacked | stacked |
| Hero mockups | 3 phones | — | **1 phone** |
| `<img>` count | 28 | 28 | 28 |
| Resources | 73 | 71 | 71 |

Notes:

- **The tablet gets desktop type.** `h1` stays at 72px/−3.6px and `h2` at 40px all
  the way from 1440 down to 834; only at 390 do they step to 48/28. Combined with
  the stacked market cards, 834 is the least-tuned width — the same pattern seen on
  [[ninesixty]] and [[tastelabs]], where the tablet is where the design is thinnest.
- Mobile is **2,663px taller** than desktop, entirely from stacking.
- The `<img>` count is **identical at all three widths** — no per-breakpoint asset
  swapping, which follows from there being no `<picture>` (§6). A phone downloads
  the same 1,121 KB of hero PNG as a desktop.
- The shader scales down correctly: at 390 it renders **37 × 91** — about 3,400
  fragments — and pointer input is disabled below 980px.

---

## §9 — Verbatim Copy

**Meta**

- Title: `Aave`
- Description: `Aave is an Open Source Protocol to create Non-Custodial Liquidity
  Markets to earn interest on supplying and borrowing assets with a variable…`
- `og:image` / `twitter:image`: `https://aave.com/og/default.png`
- `theme-color`, `msapplication-TileColor`, `msapplication-navbutton-color`,
  `apple-mobile-web-app-status-bar-style` all `#FFFFFF`
- `viewport`: `width=device-width, initial-scale=1, maximum-scale=1`

**Cookie banner**

> We use cookies to enhance your user experience, provide personalised content and
> analyse traffic. **Cookie Policy**
> `Accept All` · `Deny All`

**Hero — Aave App**

> Aave App
> # Savings for *Everyone*
> Put your money to work, every second of every day.

`Download on iOS` · `Learn More` · odometer: `$10.000450 Earned · Past Week` ·
`Jul 22` → `Today`

**Aave Pro**

> Aave Pro
> # The *Full Power* of DeFi
> Earn, borrow and swap. Built on Aave v4.

`Get Started` → `pro.aave.com` · `Learn More` → `/pro`

> ## Markets for every strategy.
> From conservative stablecoin configurations to higher-yield arrangements, choose
> the market that matches how you earn and borrow.

> **Main** — The broadest market on Aave with competitive rates across a wide range of collateral.
> **Bluechip** — Deposit assets and borrow stablecoins against them, with the assurance that your collateral isn't lent out.
> **Ethena Correlated** — Borrow USDe against Ethena assets like USDe, sUSDe, and sUSDe Pendle tokens for looping.

**Aave Kit**

> Aave Kit
> # Build *with Aave*
> Launch lending, yield, and onchain financial experiences with Aave's integration stack.

`Start Building` · `Talk to Sales`

> ## The best build with Aave.
> Reach millions of users and access billions in capital with a few lines of code.

**Trust**

> # *Trusted* by Default
> Six years of uninterrupted operation. Trillions deposited. Independently audited,
> onchain, and open to verify.

`Learn More` · `View Careers`

> ## The home of stablecoins.
> Aave is the most used protocol for stablecoin lending and borrowing across DeFi.

Chart:

> Earn more with stablecoins on Aave.
> Growth of $10,000 USDC based on historical rates.
> `Aave (USDC)` · `T-Bills` · `Savings Account`
> $13k / $12k / $11k / $10k · 2021–2026 · **$12,321** / **$11,851** / **$10,152**
> USDC supply APY from on-chain data (Aave V2+V3 Ethereum) • T-Bill: 3-month
> secondary market rate • Savings: FDIC national avg

**FAQs**

> **What is Aave?** — Aave is a decentralised non-custodial liquidity protocol
> where users can participate as suppliers or borrowers. Suppliers provide
> liquidity to the market while earning interest, and borrowers can access
> liquidity by providing collateral that exceeds the borrowed amount.
>
> **Where are supplied tokens stored?** — Supplied tokens are stored in publicly
> accessible smart contracts that enable overcollateralised borrowing according to
> governance-approved parameters. The Aave Protocol smart contracts have been
> audited and formally verified by third parties.
>
> **Does Aave have risks?** — No protocol can be considered entirely risk free, but
> extensive steps have been taken to minimize these risks as much as possible – the
> Aave Protocol code is publicly available and auditable by anyone, and has been
> audited by multiple smart contract auditors. Any code changes must be executed
> through the onchain governance processes. Additionally, there is an ongoing bug
> bounty campaign and service providers specializing in technical reviews and risk
> mitigation.
>
> **What is the Aave token?** — AAVE is used as the centre of gravity of Aave
> Protocol governance. AAVE is used to vote and decide on the outcome of Aave
> Improvement Proposals (AIPs). Apart from this, AAVE can be staked within the
> protocol Safety Module to provide a backstop in the case of a shortfall event, and
> earn incentives for doing so.

`Learn More About Aave`

**Stay Updated**

> ## Stay Updated
> Be the first to hear about news from Aave Labs
> `Email` → `Notify Me` *(disabled until valid)*

**Footer**

Products: Aave App · Aave Pro · Aave V3
Solutions: Stable Vaults · Push · GHO + sGHO
Developers: Aave Kit · Documentation · Case Studies · Security · Bug Bounty
Resources: Blog · Brand · FAQ · Help & Support · Governance · Policy
About: Aave Labs · Careers · Contact · Press
Legal & Privacy: Legal Hub · Verify Contact · Manage Analytics

> Aave.com provides information and resources about the fundamentals of the
> decentralised non-custodial liquidity protocol called the Aave Protocol,
> comprised of open-source self-executing smart contracts that are deployed on
> various permissionless public blockchains, such as Ethereum (the "Aave Protocol"
> or the "Protocol"). Aave Labs does not control or operate any version of the Aave
> Protocol on any blockchain network.

---

## §10 — Defects & Accessibility Notes

This is the cleanest build measured so far. The list is short and mostly about
payload rather than correctness.

### Payload

1. **Four preloaded fonts never render** (§3) — `AaveReproMonoVariable.woff`,
   `AaveReproMonoVariable.woff2`, `FTRegolaNeue-Semibold.otf`,
   `FTRegolaNeue-Bold.otf`. `document.fonts` reports all four `unloaded` and a live
   element count for both families returns 0.
2. **Two of those are `.otf`**, not `woff2`.
3. **Inter is loaded twice** — self-hosted `InterVariable.woff2` (used) plus a
   Google Fonts stylesheet declaring seven `Inter` faces (all unloaded). Dropping
   it removes two hosts and two preconnects.
4. **1,121 KB of hero PNG is preloaded and bypasses `next/image`** — the three
   phone mockups are raw `/images/…png` with no resizing or format negotiation.
5. **No WebP or AVIF anywhere.** Even `/_next/image` responses return `image/png`.
   Zero `<picture>` elements.
6. **`aave-pro-borrow.svg` is 565 KB** — an app screenshot shipped as vector.
7. **`_app-*.js` is 1,352 KB decoded** — the largest single asset by nearly 3×.
8. **`/app` and `/privacy-policy` chunks are each fetched twice** on the homepage.
9. **`cache-control: public, max-age=0, must-revalidate`** on hashed static assets.
10. Mobile downloads **exactly the same 28 images** as desktop (§8).

### Naming

11. **`--duration-snappy` (750ms) is faster than `--duration-swift` (1800ms)** —
    the names invert the values. Cosmetic, but it will mislead anyone reaching for
    "swift" expecting the quicker of the two.
12. **Six declared custom properties are unused**: five `--swiper-*` and
    `--grey-soft`. Swiper is not in any chunk — these are fossils.

### Accessibility

13. **The mobile menu button has no accessible name.** It is icon-only, with no
    text content, no `aria-label` and no `<title>` in its SVG. The whole page has
    only **4 `[aria-label]`** attributes, none on this button.
14. **The FAQ accordion is not exposed as one.** The trigger is
    `<button type="button">` with **no `aria-expanded` and no `aria-controls`**;
    state lives only in `data-is-open` on the parent. A screen-reader user gets no
    signal that the control expands anything, or whether it is currently open.
15. **Collapsed accordion content stays in the accessibility tree.** When closed,
    the panel is `opacity: 0` with `overflow: visible` and no `hidden` /
    `aria-hidden` / `display: none` — all four answers appear as `paragraph` nodes
    in the a11y snapshot regardless of state.
16. **Nav dropdown triggers also lack `aria-expanded`.** The open state is carried
    by `styles_active__I9iOk` and an inline `height` only.
17. **Colour is declared exclusively in `color(display-p3 …)` with no fallback.**
    Browsers without P3 support get no colour from these properties at all — there
    is no `@supports (color: color(display-p3 1 1 1))` ladder and no preceding
    `rgb()` declaration to fall back to. Support is broad in 2026, but the site has
    chosen no floor.
18. **`maximum-scale=1` in the viewport meta** blocks pinch-zoom on some mobile
    browsers.
19. **10 `:focus-visible` rules against 44 `:hover` rules** — better than most in
    this collection, but still under-covered relative to hover.
20. The three hero mockups are `alt=""`. Reasonable, but they carry the product's
    numbers (`$9,128.74`, `6.25% APY`, `$586,198`) which appear nowhere in text.

### Credit where due

21. Proper `<header>` / `<main>` / `<footer>` landmarks.
22. Carousel `Previous` is genuinely `disabled` at position 0, and both arrows have
    `aria-label`.
23. `Notify Me` is `disabled` until the email validates.
24. Marquee-style clones are not used; nothing decorative pollutes the a11y tree.
25. Headings are split by **word**, not character — so they still read correctly.

---

## §11 — Replication Checklist

Twenty-six checks. Each is verifiable in a browser.

1. `docHeight` ≈ **7,580px** at 1440×900; **8,651** at 834; **10,243** at 390.
2. `<header>`, `<main>`, `<footer>` all present; four themed containers inside
   `<main>`, sequence **purple → dark → purple → light**.
3. Every themed container `padding: 0 24px 24px`, coloured surface as an inset
   rounded card.
4. Header `position: fixed`, `z-index: 100`, `background: rgba(0,0,0,0)`,
   `backdrop-filter: none` — **identical at every scroll position and every theme**.
5. Logo fill stays `rgb(39,34,40)` over the dark section — the header never inverts.
6. **79 `:root` custom properties, every colour in `color(display-p3 …)`.**
7. `--fp-0` … `--fp-6` — one ink at seven alphas (1, 1, 0.9, 0.65, 0.5, 0.4, 0.3).
8. `--duration-snappy: 750ms` / `--ease-snappy: cubic-bezier(0.175,0.885,0.32,1.1)`;
   `--duration-swift: 1800ms` / `--ease-swift: cubic-bezier(0.19,1,0.22,1)`.
9. `h1` **72 / 79.2 / −3.6px / weight 500**; `h2` 40 / 48 / −1.2; `h3` 20 / 27 /
   −0.2 / **weight 450**.
10. Accent words in **Aave Aguzzo italic**; exactly one (`Full Power`) uses
    `background-clip: text` with a 134° three-stop gradient.
11. Headings split by **word** into `<span style="display:inline-block; position:relative">`.
12. All CTAs `border-radius: 99px`, `padding: 0 24px`, `font-size: 17px`; ghost
    variant at 10% tint.
13. **Five `<canvas>`**, intrinsic **139 × 106** at 1440 → CSS **1386 × 1064**
    (~10× upscale, `image-rendering: auto`).
14. WebGL**2** (`#version 300 es`), three programs; `USE_FAST_HASH` enabled;
    5-tap separable Gaussian blur with IGN dither on the vertical pass only.
15. Fluid solver: curl → vorticity → divergence → pressure (**1 Jacobi
    iteration**) → gradient subtract → advection; pointer splats subdivided up to
    **64** steps.
16. Frame limiter at **14.667 ms** (~68 fps); fixed-step sim with max 5 catch-up
    steps; `ResizeObserver` debounced **500 ms**; pointer disabled ≤ 980px;
    `visibilitychange` and `webglcontextlost`/`restored` both handled.
17. Default config: `motion.speed 0.15`, `texture.scale 1.25 / octaves 4.5 / warp
    0.25`, `fluid.curl 5 / dissipation 0.99 / force 6000`, `render.scale 0.25 /
    blur 6`, `colorStops [0.2, 0.85, 1]`.
18. Odometer: 6 wheels, strip **180px** (10 × 18px) in an 18px `overflow: hidden`
    window, `transition: transform 0.35s cubic-bezier(0.33,1,0.68,1)`, digits
    ordered **9→0**.
19. Pulse dot **7.1px**, `--earned-green`, two 1.6s keyframes on different eases.
20. Chart **922 × 360**, 4 gridlines, 6 labels, 4 paths (1 area + 3 lines at 2px);
    all series start at `y = 320`; x-step **58.533px**; end pills **$12,321 /
    $11,851 / $10,152**.
21. Carousel is `overflow: auto` with `gap: 16px`; `Previous` `disabled` at index 0.
22. Nav dropdown animates **height 0 → 94px** and pushes the page (header 82 → 176).
23. Accordion: item **72 → 176px**, content opacity 0 → 1, state on `data-is-open`.
24. **Ten `@keyframes`**; **two** `prefers-reduced-motion` blocks; **44 `:hover`**
    vs **10 `:focus-visible`** rules.
25. Under `prefers-reduced-motion: reduce`: **`<canvas>` count drops 5 → 0** and
    `bgWrap` gains `linear-gradient(rgb(255,255,255) 20%, rgba(151,142,255,0.4)),
    rgb(255,255,255)`.
26. **3 hosts**, **81 resources**, **≈5.0 MB** decoded; `_app-*.js` **1,352 KB**;
    all rasters PNG; **0 `<picture>`**, **0 `<video>`**.

---

## Rebuild Library Recommendation

**Verdict: React-app tier as built; genuinely could be plain-CSS plus one shader.**

Aave is the most technically disciplined site in this collection, and the gap
between it and the rest is not close. Three hosts. Proper landmarks. Seventy-nine
design tokens, every colour in Display P3. A theme system that is three values of
one `data-theme` attribute and zero lines of JavaScript. A line chart, a carousel,
an odometer and a full animated background, none of which pull in a library.

The background field is the piece worth studying. It is WebGL2 with hand-authored
GLSL and a real Navier–Stokes fluid solver, and — uniquely in this collection —
**it ships with its reasoning attached**. The comments explain why the hash avoids
`sin` (transcendental load heats integrated GPUs), why the dither happens only on
the pass that writes the canvas (so the blur doesn't wash it out), why chromatic
aberration is approximated from `dFdx`/`dFdy` (~3× cheaper, visually identical at
this strength), and why the iris branch costs nothing (coherent across every
pixel). It solves a CSS `cubic-bezier` in GLSL with five Newton iterations so the
shader's fade can be authored in the same easing vocabulary as the stylesheet. And
the whole thing renders at **139 × 106** and lets the browser upscale it 10× —
about 15,000 fragments for a full-viewport effect, with bilinear filtering doing
the blur for free.

The reduced-motion handling is the best I have measured. Not "pause the
animation", not "shorten the durations" — under `prefers-reduced-motion: reduce`
the canvas count goes **5 → 0**. No WebGL context is created, no FBOs are
allocated, no rAF starts, and CSS substitutes a static gradient tuned per theme to
match what the shader would have produced. A screenshot under reduced motion is
near-indistinguishable from the normal page. That is the standard the rest of this
collection should be held to, and only [[ouro-labs]] comes close.

Where it is beatable is payload, and the numbers are specific. **Four preloaded
fonts never paint a single glyph** — two of them `.otf`, all four confirmed
`unloaded`. **Inter loads twice**, once self-hosted and once from Google Fonts,
which is the only reason two of the three hosts exist. **1,121 KB of hero PNG is
preloaded and bypasses `next/image` entirely**, and even the images that do go
through the pipeline come back as PNG — no WebP, no AVIF, no `<picture>` anywhere.
An app screenshot ships as a **565 KB SVG**. Hashed static assets carry
`max-age=0, must-revalidate`. And `_app-*.js` is **1,352 KB decoded**, nearly 3×
the next-largest asset.

That last number is where the rebuild argument lives. Framer Motion drives word
staggers, in-view fades, and two height animations — and in 2026 every one of
those has a zero-kilobyte equivalent: `@keyframes` with `animation-delay` on
server-rendered word spans, `animation-timeline: view()` or a five-line
`IntersectionObserver`, and `grid-template-rows: 0fr → 1fr` for the accordion and
dropdown. Radix earns its place on the dropdown's focus management. My
recommendation is to **keep the shader, keep Radix, drop Framer Motion**, fix the
font preloads and route the heroes through the image pipeline. That is a
substantially smaller `_app` chunk and roughly a megabyte off the critical path,
with nothing a visitor would notice missing.

Three things to steal. **Render your canvas effect at a tenth scale and let the
browser upscale it** — `image-rendering: auto` is a free high-quality blur, and it
turns a full-viewport shader into a rounding error. **Solve `cubic-bezier` in
GLSL** so one easing vocabulary spans your CSS and your shaders. And **make
reduced motion a substitution, not a subtraction** — design the static fallback
first, then treat the animated version as the enhancement; the fact that Aave's
reduced-motion page looks finished rather than stripped is the whole proof.

Two to avoid. **Don't spend `<link rel="preload">` on fonts you haven't confirmed
render** — it is the strongest hint the platform gives and four of Aave's six go
to faces that never paint. And **don't ship `data-is-open` without
`aria-expanded`** — the accordion and the nav dropdown both animate beautifully
and both are invisible as controls to assistive tech, with the collapsed answers
still sitting in the accessibility tree at `opacity: 0`. Two attributes each.

Cross-references: [[tastelabs]] (the other WebGL showpiece in this folder, and the
opposite discipline — 13 hosts, six orphaned GSAP plugins), [[ouro-labs]] (the
zero-library benchmark and the other top-tier reduced-motion implementation),
[[ninesixty]] (JS-tweened section colour, versus Aave's static `data-theme`),
[[mistral]] and [[anima.ai]] (other Next.js product-marketing builds),
[[stateofaidesign]] (comparable token discipline).