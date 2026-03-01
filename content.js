(function () {
  "use strict";

  const PROCESSED_ATTR = "data-auto-bcc-processed";
  const PROCESSING_ATTR = "data-auto-bcc-processing";
  const CHECK_INTERVAL = 500;
  const MAX_RETRIES = 10;

  let config = { bccAddress: "", enabled: true };

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ bccAddress: "", enabled: true }, (data) => {
        config.bccAddress = data.bccAddress;
        config.enabled = data.enabled;
        resolve();
      });
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
    // Inline reply form container
    if (el.classList.contains("fX")) return true;
    return false;
  }

  function collectComposeContainers(root) {
    const results = new Set();
    if (isComposeContainer(root)) results.add(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('[role="dialog"], .AD, .fX').forEach((el) => results.add(el));
    }

    // Walk up from root to find parent compose containers.
    // This handles mutations inside compose windows (e.g. reply form expansion
    // adds child nodes to an existing container that was not yet processed).
    let parent = root.parentElement;
    while (parent) {
      if (isComposeContainer(parent)) {
        results.add(parent);
        break;
      }
      parent = parent.parentElement;
    }

    // Deduplicate: when a dialog contains an .AD, both are found above.
    // Keep only the outermost containers to avoid processing the same
    // compose window twice (which causes duplicate BCC addresses).
    const arr = [...results];
    const filtered = arr.filter((el) => {
      return !arr.some((other) => other !== el && other.contains(el));
    });

    return new Set(filtered);
  }

  // --- BCC toggle & input helpers ---

  function findBccToggle(container) {
    // Strategy 1: data-tooltip attribute (case-insensitive for locale robustness)
    const tooltip = container.querySelector('[data-tooltip="Bcc" i]');
    if (tooltip) return tooltip;

    // Strategy 2: find a compact span with "Bcc" text acting as a link
    // Limit search depth to avoid scanning the entire compose body
    const headerArea = container.querySelector('.aoD, .fX, .GS') || container;
    for (const span of headerArea.querySelectorAll("span")) {
      if (span.textContent.trim().toLowerCase() === "bcc"
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
      if (span.textContent.trim().toLowerCase() === "bcc" && span.childElementCount === 0) {
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
    // Check if the BCC area already contains the configured email as a
    // confirmed chip. We intentionally do NOT check input.value /
    // input.textContent here because residual (uncommitted) text in the
    // input field is not a confirmed recipient and should not be treated
    // as a duplicate.
    const bccInput = findBccInput(container);
    if (!bccInput) return false;

    // Check chip elements (Gmail creates these for each confirmed recipient)
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

  // --- Keyboard event helper ---

  function dispatchKeyEvent(target, key, code, keyCode) {
    const commonProps = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", commonProps));
    target.dispatchEvent(new KeyboardEvent("keypress", commonProps));
    target.dispatchEvent(new KeyboardEvent("keyup", commonProps));
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
      // Dispatch InputEvent to notify Gmail's framework of the change
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: email,
      }));
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
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    await delay(200);

    // Press Enter to confirm the recipient as a chip/token
    // Full keydown/keypress/keyup sequence for Gmail compatibility
    dispatchKeyEvent(input, "Enter", "Enter", 13);

    await delay(100);

    // Also press Tab as a fallback to confirm
    dispatchKeyEvent(input, "Tab", "Tab", 9);

    await delay(200);

    // Gmail's synthetic event handling may create the chip but leave the input
    // value populated. Explicitly clear it to prevent autocomplete artifacts
    // and to avoid bccAlreadyContains() misreading residual text as a chip.
    if (input.isContentEditable) {
      if (input.textContent.trim()) {
        input.textContent = "";
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "deleteContent",
        }));
      }
    } else {
      if (input.value) {
        const proto = input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(input, "");
        } else {
          input.value = "";
        }
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
    }
  }

  // --- Main processing logic ---

  async function processCompose(container) {
    if (!config.enabled || !config.bccAddress) return;
    // Already successfully processed – nothing to do
    if (container.getAttribute(PROCESSED_ATTR)) return;
    // Another call is currently processing this container – skip
    if (container.getAttribute(PROCESSING_ATTR)) return;
    container.setAttribute(PROCESSING_ATTR, "true");

    try {
      // Retry loop – Gmail may still be rendering the compose UI
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        await delay(CHECK_INTERVAL);

        // Check if BCC already has our address (e.g. draft being re-opened)
        if (bccAlreadyContains(container, config.bccAddress)) {
          container.setAttribute(PROCESSED_ATTR, "true");
          return;
        }

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
          // Re-check right before filling to prevent duplicates when
          // concurrent processCompose calls target overlapping containers
          if (bccAlreadyContains(container, config.bccAddress)) {
            container.setAttribute(PROCESSED_ATTR, "true");
            return;
          }
          await fillInput(bccInput, config.bccAddress);
          container.setAttribute(PROCESSED_ATTR, "true");
          return;
        }
      }
      // All retries exhausted without success. Do NOT mark as processed so
      // the container can be retried when new child mutations occur (e.g.
      // reply form expanding from compact to full compose).
    } finally {
      container.removeAttribute(PROCESSING_ATTR);
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

    // Initial scan for compose windows already present in the DOM
    const existing = collectComposeContainers(document.body);
    existing.forEach((c) => processCompose(c));
  }

  // --- Init ---
  // Wait for config to load before starting the observer to prevent race condition
  loadConfig().then(() => {
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener("DOMContentLoaded", startObserver);
    }
  });
})();
