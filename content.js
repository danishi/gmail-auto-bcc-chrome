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
    // Strategy 1: data-tooltip attribute (most stable selector)
    const tooltip = container.querySelector('[data-tooltip="Bcc"]');
    if (tooltip) return tooltip;

    // Strategy 2: find a compact span with exact "Bcc" text acting as a link
    // Limit search depth to avoid scanning the entire compose body
    const headerArea = container.querySelector('.aoD, .fX, .GS') || container;
    for (const span of headerArea.querySelectorAll("span")) {
      if (span.textContent.trim() === "Bcc"
          && !span.querySelector("input, textarea, [contenteditable]")
          && span.childElementCount === 0) {
        return span;
      }
    }
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

    // Strategy 3: Walk up from a "Bcc" label span to find the editable sibling
    // Scoped to header area to avoid scanning the compose body
    const headerArea = container.querySelector('.aoD, .fX, .GS') || container;
    for (const span of headerArea.querySelectorAll("span")) {
      if (span.textContent.trim() === "Bcc" && span.childElementCount === 0) {
        // Walk up to the row-level parent and look for an editable field
        const row = span.closest("div, tr");
        if (row) {
          const editable = row.querySelector(
            'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="combobox"]'
          );
          if (editable) return editable;
        }
      }
    }

    return null;
  }

  function emailEquals(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  function bccAlreadyContains(container, email) {
    // Check if the BCC area already contains the configured email
    // Gmail represents added recipients as "chips" (spans/divs with the email)
    const bccInput = findBccInput(container);
    if (!bccInput) return false;

    // Check the value of the input itself
    const value = bccInput.value || bccInput.textContent || "";
    if (emailEquals(value, email)) return true;

    // Check sibling chip elements (Gmail creates these for each recipient)
    const parent = bccInput.closest("div");
    if (parent) {
      const chips = parent.querySelectorAll('[data-hovercard-id], [email], [data-name]');
      for (const chip of chips) {
        const chipEmail = chip.getAttribute("email") || chip.getAttribute("data-hovercard-id") || "";
        if (emailEquals(chipEmail, email)) return true;
      }
    }

    return false;
  }

  // --- Input filling ---

  async function fillInput(input, email) {
    input.focus();
    await delay(100);

    if (input.isContentEditable) {
      // For contenteditable, collapse selection to end and insert (don't clear existing content)
      const sel = window.getSelection();
      sel.selectAllChildren(input);
      sel.collapseToEnd();
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
    let pendingNodes = [];
    let debounceTimer = null;

    function flushPendingNodes() {
      if (!config.enabled || !config.bccAddress) {
        pendingNodes = [];
        return;
      }
      const nodes = pendingNodes;
      pendingNodes = [];
      for (const node of nodes) {
        const containers = collectComposeContainers(node);
        containers.forEach((c) => processCompose(c));
      }
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          pendingNodes.push(node);
        }
      }
      if (pendingNodes.length > 0) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flushPendingNodes, 100);
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
