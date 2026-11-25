# Third-party notices

ibow itself is licensed under the [GNU AGPL-3.0-only](LICENSE). It includes or depends on the following, each under its own
licence. The full licence texts ship beside the assets, where noted.

## Bundled assets (shipped inside the client)

| Asset | Where | Licence | Copyright |
|---|---|---|---|
| Fraunces, variable typeface (Latin subset) | `src/client/assets/fonts/fraunces.woff2` | SIL Open Font License 1.1 | The Fraunces Project Authors (https://github.com/undercasetype/Fraunces) |
| Inter, variable typeface (Latin subset, `woff2`) | `src/client/assets/fonts/inter.woff2` | SIL Open Font License 1.1 | The Inter Project Authors (https://github.com/rsms/inter) |
| Lora, variable typeface (Latin subset) | `src/client/assets/fonts/lora.woff2` | SIL Open Font License 1.1 | The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), Reserved Font Name "Lora" |
| Nunito, variable typeface (Latin subset) | `src/client/assets/fonts/nunito.woff2` | SIL Open Font License 1.1 | The Nunito Project Authors (https://github.com/googlefonts/nunito) |
| Space Grotesk, variable typeface (Latin subset) | `src/client/assets/fonts/space-grotesk.woff2` | SIL Open Font License 1.1 | The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) |

The five fonts' licence text and copyright notices are in `src/client/assets/LICENSE-fonts-OFL.txt`. The fonts are
served as Latin-subset `woff2` files, are not sold on their own, and the page's CSS names them `ibow-inter`, `ibow-lora`
and so on, not by their original names.

The icon set (`src/client/ui/icons.ts`) was drawn for ibow and is part of ibow (AGPL-3.0-only). There are no other bundled images, fonts or scripts. The screenshots in `docs/media/` and the sample businesses in
`samples/` (including the service desk's `logo.svg`) were made for ibow, and the sample businesses are invented.

## Runtime dependencies

| Package | Version | Licence | Used for |
|---|---|---|---|
| [hono](https://github.com/honojs/hono) | 4.13.17 | MIT, Copyright (c) 2021 - present, Yusuke Wada and Hono contributors | The HTTP app, on Node and Workers |
| [@hono/node-server](https://github.com/honojs/node-server) | 2.1.6 | MIT, Copyright (c) 2022 - present, Yusuke Wada and Hono contributors | Serving the app on plain Node |
| [uqr](https://github.com/unjs/uqr) | 0.1.3 | MIT, Copyright (c) Project Nayuki and (c) 2023 Anthony Fu | The UPI QR code, bundled into the client |

`uqr` includes the QR Code generator algorithm by Project Nayuki (MIT).

## Development tools

Not shipped to users: esbuild, TypeScript, Biome, Vitest, Playwright, Miniflare and wrangler (all permissively licensed,
see each package's own `LICENSE`). Wrangler and Miniflare are Cloudflare's tools; using Cloudflare's service is governed
by Cloudflare's own terms, not by this project.

## MIT licence (hono, @hono/node-server, uqr)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Adding something new

A new bundled asset or runtime dependency needs its licence listed here and an entry in `docs/decisions.md`; see
[CONTRIBUTING.md](CONTRIBUTING.md).
