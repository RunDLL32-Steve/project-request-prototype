// Light/dark theme. Loaded synchronously in <head> so the right theme is set before first paint.
// Saved choice (localStorage) wins; otherwise follow the operating system until the user picks.
(function () {
  var KEY = "theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { var t = localStorage.getItem(KEY); return t === "dark" || t === "light" ? t : null; } catch (e) { return null; }
  }
  function current() { return saved() || (media && media.matches ? "dark" : "light"); }
  function apply(theme) {
    root.dataset.theme = theme;
    var b = document.getElementById("themeToggle");
    if (!b) return;
    var toDark = theme === "light";
    b.setAttribute("aria-label", toDark ? "Switch to dark mode" : "Switch to light mode");
    b.title = toDark ? "Switch to dark mode" : "Switch to light mode";
    // Show the icon of the mode you will switch TO.
    b.innerHTML = toDark
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  }

  apply(current());

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("themeToggle");
    if (!b) return;
    apply(root.dataset.theme || current());
    b.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    });
  });

  if (media && media.addEventListener) {
    media.addEventListener("change", function () { if (!saved()) apply(current()); });
  }
})();
