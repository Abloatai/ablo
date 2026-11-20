# Ablo documentation appearance

`blume.config.ts` and `theme.css` use the application's neutral light/dark palette,
matching the palette in Lobby docs PR #964. Match Lobby’s header/sidebar surfaces, compact header, plain navigation and
code/search treatment. Both body and headings use application system typography;
controls retain Ablo’s tighter `sm` corner radius. Small secondary text uses a darker light-mode neutral for
readability. Generated prose remains owned by `packages/ablo/docs`.

Build with `npm run build --prefix docs/ablo`, serve `docs/ablo/dist`, and run
`node docs/ablo/check-theme.mjs http://localhost:3213` from the repository root
with its Playwright dependencies installed. The focused check covers neutral
page colors, application heading fonts, shared header/sidebar tones, tight corners,
plain navigation, code surfaces, persistent theme switching, search and phone overflow. It does not
replace a full accessibility audit.

The footer uses `public/logo/wordmark.svg`, copied from the public website's
`apps/sync-web/public/brand/ablo-wordmark.svg`. Keep the lowercase brand geometry
instead of typesetting the name with the body font. Its mask follows the current
light/dark foreground; the header emblem is 32px.

The API reference sidebar groups endpoints under plain, always-open category
headings like Lobby’s sidebar, using the OpenAPI tags rather than disclosures. Endpoint rows show their names without HTTP-method
badges; their links and labels remain derived from the OpenAPI document.
The focused browser check covers API endpoint navigation at desktop and phone
widths in both themes, as well as the prose navigation and search checks above.
