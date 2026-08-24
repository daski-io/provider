"use strict";

const stream = document.getElementById("chat-stream");
const operatorTemplate = document.getElementById("tpl-operator-bubble");
const typingTemplate = document.getElementById("tpl-typing");
let busy = false;

function formatRemaining(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
}

function tickCountdowns() {
  document.querySelectorAll("[data-intent-countdown]").forEach((element) => {
    const expires = Number(element.getAttribute("data-expires-at"));
    if (!expires) return;
    const remaining = expires - Date.now();
    if (remaining > 0) {
      element.textContent = `single-use · expires in ${formatRemaining(remaining)}`;
      return;
    }
    const form = element.closest("form[data-confirmation-form]");
    const note = document.createElement("div");
    note.className = "dim";
    note.style.cssText = "font-size:11.5px; margin:6px 0 10px;";
    note.textContent = "Approval expired — ask the agent to run the action again for a fresh button.";
    if (form) form.replaceWith(note);
    else element.replaceWith(note);
  });
  const bar = document.getElementById("pending-approvals");
  if (bar && !bar.querySelector("[data-intent-countdown]")) bar.remove();
}

if (stream && operatorTemplate instanceof HTMLTemplateElement
  && typingTemplate instanceof HTMLTemplateElement) {
  if (!location.hash) {
    window.scrollTo(0, document.body.scrollHeight);
    document.querySelector(
      'form[data-chat-form][action="/admin/ui/chat"] input[name="message"]',
    )?.focus();
  }
  tickCountdowns();
  setInterval(tickCountdowns, 1_000);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-chat-form")) return;
    event.preventDefault();
    if (busy) return;
    const messageInput = form.elements.namedItem("message");
    if (!(messageInput instanceof HTMLInputElement)) return;
    const text = messageInput.value.trim();
    if (!text) return;
    busy = true;
    const details = form.closest("details");
    const target = details?.querySelector("[data-convo]") || stream;
    target.querySelector("[data-empty]")?.remove();
    const bubble = operatorTemplate.content.firstElementChild?.cloneNode(true);
    const typing = typingTemplate.content.firstElementChild?.cloneNode(true);
    if (!(bubble instanceof HTMLElement) || !(typing instanceof HTMLElement)) {
      busy = false;
      return;
    }
    const content = bubble.firstElementChild;
    if (content) content.textContent = text;
    target.append(bubble, typing);
    if (messageInput.type !== "hidden") {
      messageInput.value = "";
      messageInput.focus();
    }
    if (details) typing.scrollIntoView({ block: "nearest", behavior: "smooth" });
    else window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    const anchorId = details?.id || null;
    fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: text }).toString(),
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((html) => {
        const documentCopy = new DOMParser().parseFromString(html, "text/html");
        const fresh = documentCopy.getElementById("chat-stream");
        if (!fresh) {
          location.reload();
          return;
        }
        const openIds = Array.from(stream.querySelectorAll("details[open]"), (detail) => detail.id);
        stream.replaceChildren(...Array.from(fresh.childNodes).map((node) => node.cloneNode(true)));
        const freshBar = documentCopy.getElementById("pending-approvals");
        const currentBar = document.getElementById("pending-approvals");
        if (currentBar && freshBar) currentBar.replaceWith(freshBar);
        else if (currentBar) currentBar.remove();
        else if (freshBar) {
          const compose = document.querySelector('form[data-chat-form][action="/admin/ui/chat"]');
          compose?.parentElement?.before(freshBar);
        }
        tickCountdowns();
        openIds.forEach((id) => {
          const detail = document.getElementById(id);
          if (detail instanceof HTMLDetailsElement) detail.open = true;
        });
        const anchor = anchorId ? document.getElementById(anchorId) : null;
        if (anchor instanceof HTMLDetailsElement) {
          anchor.open = true;
          anchor.scrollIntoView({ block: "nearest" });
        } else {
          window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        }
      })
      .catch(() => {
        typing.remove();
        bubble.remove();
        if (messageInput.type !== "hidden") {
          messageInput.value = text;
          messageInput.focus();
        }
        const note = document.createElement("div");
        note.className = "dim";
        note.style.cssText = "align-self:flex-start; font-size:12px; margin-bottom:10px;";
        note.textContent = "Send failed — the message wasn't delivered. Try again.";
        target.append(note);
      })
      .finally(() => {
        busy = false;
      });
  });
}
