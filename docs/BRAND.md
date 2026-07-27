# Skein Brand System

## Meaning

The Skein Goose is an original mark for the product. “Skein” connects two
ideas: a length of thread/yarn and a formation of geese moving together. The
animal represents coordinated agents and forward direction; the colored line
through its wing represents context being carried as one inspectable thread.

The mark is intentionally quieter than a mascot illustration. A coding CLI has
to remain legible at one terminal cell and 16 pixels, so the identity uses a
strong goose silhouette, one wing cutout, and one continuous accent line.

## Selected Direction

The master mark is a right-facing goose in forward motion. Its outer silhouette
owns animal recognition. The wing's negative space separates the body at small
sizes, while the mint thread supplies the product-specific “skein” idea without
changing the silhouette.

Directions rejected during concept review:

- A three-goose V formation became a generic arrow below 32 pixels.
- A standing goose read as a friendly mascot but lost the product's directional
  and multi-agent meaning.
- Interlocking abstract wings became a generic knot and moved too close to
  existing AI-brand geometry.
- Detailed feathers and yarn texture failed the terminal and favicon cases.

The built-in image generator was attempted for a concept board but the current
image entitlement did not include its configured model. No lower image model or
external credential was used. The user then supplied an Image2-generated,
transparent flying-goose illustration from the approved prompt. It is retained
unchanged as the rich raster asset. The small icon family remains deterministic,
code-native artwork created for Skein, and its 512px raster is rendered from the
same simplified SVG source.

## Assets

| Asset | Use |
| --- | --- |
| [`skein-goose-flight.png`](assets/skein-goose-flight.png) | 1024×1024 transparent rich mark for README, npm, GitHub, and release surfaces. |
| [`skein-goose.svg`](assets/skein-goose.svg) | Primary transparent mark for light surfaces. |
| [`skein-goose-dark.svg`](assets/skein-goose-dark.svg) | Light/mint mark for dark surfaces. |
| [`skein-goose-mono.svg`](assets/skein-goose-mono.svg) | One-color printing, masks, and deterministic contrast tests. |
| [`skein-goose.png`](assets/skein-goose.png) | 512×512 sRGB transparent raster master for npm, GitHub, and release surfaces. |

Do not place the mark inside a generic rounded-square or circle container. Keep
at least 8% of the canvas width as clear space and do not recolor the thread to
look like warning, error, or provider-specific status.

## Palette

- Goose/body on light surfaces: `#17202C`
- Thread and eye on light surfaces: `#16A085`
- Goose/body on dark surfaces: `#F4F7FB`
- Thread and eye on dark surfaces: `#6EE7D0`

The mark remains understandable in monochrome. Color is enhancement, never the
only carrier of identity or status.

## Terminal Identity

- Wide interactive lockup: a three-row code-native Goose silhouette with a
  contrasting woven lower wing, paired with repository, route, model, and mode.
- Compact Unicode signature: `__\●▶`
- Compact ASCII fallback: `__\o>`
- Transcript signer: `⌁` (`U+2301`) or `*` in ASCII mode, where repeating the
  full animal would add noise to every assistant response.
- Accessible name: `Skein`

The former single-cell-only header passed width tests but failed real-user
recognition: `⌁` read as an abstract thread, not the Goose. Interactive sessions
therefore use the recognizable responsive lockup above. Terminals under 100
columns keep the compact flight signature; constrained-height and screen-reader
modes never receive multi-line artwork. `TERM=dumb`, `SKEIN_GLYPHS=ascii`, and
screen-reader modes retain deterministic ASCII/name paths. Decorative glyphs
receive the accessible label “Skein”.

## Size Contract

The simplified raster source is validated at 16, 32, 64, 128, and 512 pixels.
At 16 pixels the outer animal silhouette and contrasting wing/thread remain
visible; the eye is optional micro-detail. The rich flight mark remains clear at
32 and 64 pixels but its eye and three-thread weave are not acceptance criteria
at 16 pixels. At small sizes the SVG remains the authority. Every raster must
retain alpha, sRGB output, transparent corners, and a bounded subject with no
clipping on either axis.
