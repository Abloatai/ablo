import { defineComponents } from "blume";

export default defineComponents({
  layout: {
    Logo: "./components/SiteLogo.astro",
    // `Footer` has no built-in and renders site-wide after the content grid —
    // Blume's documented injection point, and the only one. It renders no
    // page-specific chrome; `SiteFooter` owns the Ablo branding and behaviors on
    // every page, so adding one never means editing another's module.
    Footer: "./components/SiteFooter.astro",
  },
});
