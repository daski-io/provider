"use strict";

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const confirmTarget = target?.closest("[data-confirm]");
  if (confirmTarget && !window.confirm(confirmTarget.getAttribute("data-confirm") || "Continue?")) {
    event.preventDefault();
    return;
  }
  if (target?.closest("a,button,input,select,textarea,label")) return;
  const href = target?.closest("[data-href]")?.getAttribute("data-href");
  if (href) window.location.assign(href);
});

const reviewNav = document.querySelector("[data-review-nav]");
if (reviewNav) {
  fetch("/admin/ui/reviews/count", { credentials: "same-origin" })
    .then((response) => response.ok ? response.json() : null)
    .then((metrics) => {
      if (!metrics || !Number.isFinite(metrics.open) || metrics.open < 1) return;
      const badge = document.createElement("span");
      badge.className = metrics.critical > 0 ? "pill pill--danger" : "pill pill--warning";
      badge.style.marginLeft = "6px";
      badge.textContent = String(metrics.open);
      reviewNav.appendChild(badge);
    })
    .catch(() => undefined);
}
