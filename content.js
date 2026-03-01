(function () {
  "use strict";

  const PROCESSED_ATTR = "data-auto-bcc-processed";
  const PROCESSING_ATTR = "data-auto-bcc-processing";
  const CHECK_INTERVAL = 500;
  const MAX_RETRIES = 10;
  const MAX_PARENT_DEPTH = 20;

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

  /**
   * Validates that an element is an actual Gmail compose/reply window by
   * checking for compose-specific child elements.
   *
   * A real compose window always contains:
   *   - A "To" recipient field (input[name="to"] — locale-independent)
   *   - An editable compose body area (contenteditable div with role/aria attrs)
   *
   * This prevents false positives from settings dialogs, contact pickers,
   * confirmation dialogs, and other role="dialog" elements in Gmail.
   */
  function isActualComposeWindow(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // Must have a recipient "To" field (locale-independent attribute)
    const hasToField = !!el.querySelector(
      'input[name="to"], textarea[name="to"]'
    );
    if (!hasToField) return false;

    // Must have an editable compose body area
    const hasBody = !!el.querySelector(
      '[role="textbox"][contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label], ' +
      'div[contenteditable="true"][g_editable="true"]'
    );

    return hasBody;
  }

  /**
   * Starting from a given node, walks up the DOM to find the smallest
   * ancestor that qualifies as an actual compose window.
   * Stops at document.body and limits traversal depth.
   */
  function findComposeAncestor(node) {
    let el = node.parentElement;
    let depth = 0;
    while (el && depth < MAX_PARENT_DEPTH) {
      if (el === document.body || el === document.documentElement) break;
      if (isActualComposeWindow(el)) return el;
      el = el.parentElement;
      depth++;
    }
    return null;
  }

  /**
   * Collects Gmail compose/reply containers from a given DOM root.
   *
   * Uses a two-phase approach:
   *   Phase 1 — Gather candidates from dialogs, inline compose indicators,
   *             and parent traversal.
   *   Phase 2 — Validate every candidate with isActualComposeWindow() to
   *             filter out non-compose dialogs.
   */
  function collectComposeContainers(root) {
    const candidates = new Set();

    // Phase 1a: Check if root itself is a dialog
    if (root.matches && root.matches('[role="dialog"]')) {
      candidates.add(root);
    }

    // Phase 1b: Find all dialog elements within the root
    if (root.querySelectorAll) {
      root.querySelectorAll('[role="dialog"]').forEach((el) => candidates.add(el));
    }

    // Phase 1c: Walk up from root to find a parent dialog.
    // This handles mutations inside compose windows (e.g. reply form
    // expanding adds child nodes to an existing container).
    let parent = root.parentElement;
    let depth = 0;
    while (parent && depth < MAX_PARENT_DEPTH) {
      if (parent === document.body) break;
      if (parent.matches && parent.matches('[role="dialog"]')) {
        candidates.add(parent);
        break;
      }
      parent = parent.parentElement;
      depth++;
    }

    // Phase 1d: Find inline compose/reply windows (not wrapped in a dialog).
    // Locate To fields and walk up to find their compose container boundary.
    if (root.querySelectorAll) {
      root.querySelectorAll('input[name="to"]').forEach((toField) => {
        const container = findComposeAncestor(toField);
        if (container) candidates.add(container);
      });
    }

    // Also check if root is inside an inline compose window
    const inlineAncestor = findComposeAncestor(root);
    if (inlineAncestor) candidates.add(inlineAncestor);

    // Phase 2: Validate — only keep candidates that are actual compose windows
    const validated = [...candidates].filter(isActualComposeWindow);

    // Deduplicate: keep only outermost containers to avoid processing
    // the same compose window twice (which causes duplicate BCC addresses)
    const filtered = validated.filter((el) => {
      return !validated.some((other) => other !== el && other.contains(el));
    });

    return new Set(filtered);
  }

  // --- BCC toggle & input helpers ---

  function findBccToggle(container) {
    // Strategy 1: data-tooltip attribute (case-insensitive for locale robustness)
    const tooltip = container.querySelector(
      '[data-tooltip="Bcc" i], [data-tooltip*="Bcc" i]'
    );
    if (tooltip) return tooltip;

    // Strategy 2: aria-label containing "Bcc" on interactive elements
    const ariaToggle = container.querySelector(
      '[role="link"][aria-label*="Bcc" i], ' +
      '[role="button"][aria-label*="Bcc" i], ' +
      'span[aria-label*="Bcc" i], ' +
      'a[aria-label*="Bcc" i]'
    );
    if (ariaToggle) return ariaToggle;

    // Strategy 3: Find a compact span/link with "Bcc" text acting as a toggle.
    // Only match leaf elements (no children) that are not input fields.
    for (const el of container.querySelectorAll("span, a")) {
      if (el.textContent.trim().toLowerCase() === "bcc"
          && !el.querySelector("input, textarea, [contenteditable]")
          && el.childElementCount === 0) {
        return el;
      }
    }
    return null;
  }

  function isBccFieldVisible(container) {
    return !!findBccInput(container);
  }

  function findBccInput(container) {
    // Strategy 1: input/textarea with name="bcc" (most reliable, locale-independent)
    const named = container.querySelector('input[name="bcc"], textarea[name="bcc"]');
    if (named) return named;

    // Strategy 2: aria-label containing "Bcc"
    const ariaEl = container.querySelector(
      'input[aria-label*="Bcc" i], textarea[aria-label*="Bcc" i], ' +
      '[contenteditable][aria-label*="Bcc" i], ' +
      '[role="combobox"][aria-label*="Bcc" i]'
    );
    if (ariaEl) return ariaEl;

    // Strategy 3: Walk from a "Bcc" label span to find the editable sibling
    for (const span of container.querySelectorAll("span")) {
      if (span.textContent.trim().toLowerCase() === "bcc" && span.childElementCount === 0) {
        // Walk up to the row-level parent and look for an editable field
        const row = span.closest('[role="group"], div, tr');
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

    // Guard: verify this is truly a compose/reply window before proceeding.
    // This prevents accidental manipulation of non-compose dialogs
    // (e.g. contact pickers, settings dialogs) that could break Gmail's UI.
    if (!isActualComposeWindow(container)) return;

    container.setAttribute(PROCESSING_ATTR, "true");

    try {
      // Retry loop – Gmail may still be rendering the compose UI
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        await delay(CHECK_INTERVAL);

        // Re-validate on each attempt in case the container's content changed
        // (e.g. a dialog was repurposed or the compose elements were removed)
        if (!isActualComposeWindow(container)) {
          return;
        }

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
