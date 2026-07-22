import { defineComponents } from "blume";

export default defineComponents({
  layout: {
    // `Footer` has no built-in and renders site-wide after the content grid —
    // Blume's documented injection point. Used here only to mount the sidebar's
    // one-open-at-a-time behavior; it renders no visible chrome.
    Footer: "./components/SidebarAccordion.astro",
  },
});
