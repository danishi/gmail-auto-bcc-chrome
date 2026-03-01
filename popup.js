document.addEventListener("DOMContentLoaded", () => {
  const bccInput = document.getElementById("bccAddress");
  const enabledCheckbox = document.getElementById("enabled");
  const saveButton = document.getElementById("save");
  const statusEl = document.getElementById("status");

  // Load saved settings
  chrome.storage.sync.get({ bccAddress: "", enabled: true }, (data) => {
    bccInput.value = data.bccAddress;
    enabledCheckbox.checked = data.enabled;
  });

  // Save settings
  saveButton.addEventListener("click", () => {
    const bccAddress = bccInput.value.trim();
    const enabled = enabledCheckbox.checked;

    if (bccAddress && !isValidEmail(bccAddress)) {
      statusEl.style.color = "#d93025";
      statusEl.textContent = "有効なメールアドレスを入力してください";
      return;
    }

    chrome.storage.sync.set({ bccAddress, enabled }, () => {
      statusEl.style.color = "#188038";
      statusEl.textContent = "保存しました";
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2000);
    });
  });

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
});
