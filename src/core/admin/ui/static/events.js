"use strict";

document.querySelectorAll(".log-row").forEach((row) => {
  const tabs = row.querySelectorAll(".log-tab");
  const panes = row.querySelectorAll("[data-tab-pane]");
  tabs.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const name = button.getAttribute("data-tab");
      tabs.forEach((tab) => tab.classList.toggle("is-active", tab === button));
      panes.forEach((pane) => {
        pane.style.display = pane.getAttribute("data-tab-pane") === name ? "" : "none";
      });
    });
  });
  const copy = row.querySelector(".log-copy");
  copy?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = copy.getAttribute("data-json") || "";
    void navigator.clipboard?.writeText(text);
    const original = copy.textContent;
    copy.textContent = "Copied";
    setTimeout(() => {
      copy.textContent = original;
    }, 1_400);
  });
});
