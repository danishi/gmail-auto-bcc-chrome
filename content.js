(function () {
  "use strict";

  const PROCESSED_ATTR = "data-auto-bcc-processed";
  const CHECK_INTERVAL = 500;
  const MAX_RETRIES = 10;

  let config = { bccAddress: "", enabled: true };

  function loadConfig() {
    chrome.storage.sync.get({ bccAddress: "", enabled: true }, (data) => {
      config.bccAddress = data.bccAddress;
      config.enabled = data.enabled;
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.bccAddress) config.bccAddress = changes.bccAddress.newValue;
    if (changes.enabled) config.enabled = changes.enabled.newValue;
  });

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Compose window detection ---

  function isComposeContainer(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    // Popup compose dialog
    if (el.matches('[role="dialog"]')) return true;
    // Inline compose / reply – Gmail wraps these in specific containers
    if (el.classList.contains("AD")) return true;
    return false;
  }

  function collectComposeContainers(root) {
    const results = new Set();
    if (isComposeContainer(root)) results.add(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('[role="dialog"], .AD').forEach((el) => results.add(el));
    }
    return results;
  }

  // --- BCC toggle & input helpers ---

  function findBccToggle(container) {
    // Strategy 1: span with exact "Bcc" text acting as a link
    for (const span of container.querySelectorAll("span")) {
      if (span.textContent.trim() === "Bcc" && !span.querySelector("input, textarea, [contenteditable]")) {
        // Ensure this span is small (toggle link), not a row label that is already expanded
        const rect = span.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 200) {
          return span;
        }
      }
    }
    // Strategy 2: data-tooltip attribute
    const tooltip = container.querySelector('[data-tooltip="Bcc"]');
    if (tooltip) return tooltip;
    return null;
  }

  function isBccFieldVisible(container) {
    // If we can already find a Bcc input, the field is visible
    return !!findBccInput(container);
  }

  function findBccInput(container) {
    // Strategy 1: input/textarea with name="bcc"
    const named = container.querySelector('input[name="bcc"], textarea[name="bcc"]');
    if (named) return named;

    // Strategy 2: aria-label containing "Bcc"
    const ariaEl = container.querySelector(
      'input[aria-label*="Bcc" i], textarea[aria-label*="Bcc" i], [contenteditable][aria-label*="Bcc" i]'
    );
    if (ariaEl) return ariaEl;

    // Strategy 3: Look for a row that has "Bcc" label and then find the editable element inside
    const allRows = container.querySelectorAll("div, tr, td");
    for (const row of allRows) {
      // Only check direct text, not deep text content (to avoid matching too broadly)
      for (const child of row.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() === "Bcc") {
          const editable = row.querySelector(
            'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="combobox"]'
          );
          if (editable) return editable;
        }
      }
      // Also check if the row has a <span> label "Bcc"
      const labelSpan = row.querySelector(":scope > span, :scope > div > span");
      if (labelSpan && labelSpan.textContent.trim() === "Bcc") {
        const editable = row.querySelector(
          'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="combobox"]'
        );
        if (editable && editable !== labelSpan) return editable;
      }
    }

    return null;
  }

  function bccAlreadyContains(container, email) {
    // Check if the BCC area already contains the configured email
    // Gmail represents added recipients as "chips" (spans/divs with the email)
    const bccInput = findBccInput(container);
    if (!bccInput) return false;

    // Check the value of the input itself
    const value = bccInput.value || bccInput.textContent || "";
    if (value.toLowerCase().includes(email.toLowerCase())) return true;

    // Check sibling chip elements (Gmail creates these for each recipient)
    const parent = bccInput.closest("div");
    if (parent) {
      const chips = parent.querySelectorAll('[data-hovercard-id], [email], [data-name]');
      for (const chip of chips) {
        const chipEmail = chip.getAttribute("email") || chip.getAttribute("data-hovercard-id") || chip.textContent;
        if (chipEmail && chipEmail.toLowerCase().includes(email.toLowerCase())) return true;
      }
    }

    return false;
  }

  // --- Input filling ---

  async function fillInput(input, email) {
    input.focus();
    await delay(100);

    if (input.isContentEditable) {
      // For contenteditable, use execCommand for proper event handling
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, email);
    } else {
      // For regular input/textarea, use native setter to trigger React/Gmail handlers
      const proto = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(input, email);
      } else {
        input.value = email;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await delay(200);

    // Press Enter to confirm the recipient as a chip/token
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enterEvent);

    await delay(100);

    // Also press Tab as a fallback to confirm
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      keyCode: 9,
      which: 9,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(tabEvent);
  }

  // --- Main processing logic ---

  async function processCompose(container) {
    if (!config.enabled || !config.bccAddress) return;
    if (container.getAttribute(PROCESSED_ATTR)) return;
    container.setAttribute(PROCESSED_ATTR, "true");

    // Retry loop – Gmail may still be rendering the compose UI
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await delay(CHECK_INTERVAL);

      // Check if BCC already has our address (e.g. draft being re-opened)
      if (bccAlreadyContains(container, config.bccAddress)) return;

      // If BCC field is not visible, try to open it
      if (!isBccFieldVisible(container)) {
        const toggle = findBccToggle(container);
        if (toggle) {
          toggle.click();
          await delay(400);
        } else {
          // Toggle not found yet, retry
          continue;
        }
      }

      const bccInput = findBccInput(container);
      if (bccInput) {
        await fillInput(bccInput, config.bccAddress);
        return;
      }
    }
  }

  // --- MutationObserver ---

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!config.enabled || !config.bccAddress) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const containers = collectComposeContainers(node);
          containers.forEach((c) => processCompose(c));
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // --- Init ---
  loadConfig();
  if (document.body) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver);
  }
})();
