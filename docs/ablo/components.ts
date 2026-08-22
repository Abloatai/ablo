import { defineComponents } from "blume";

export default defineComponents({
  layout: {
    // `Footer` has no built-in and renders site-wide after the content grid —
    // Blume's documented injection point, and the only one. It renders no
    // visible chrome; `SiteFooter` composes the behaviors that need to mount on
    // every page, so adding one never means editing another's module.
    Footer: "./components/SiteFooter.astro",
  },
});
