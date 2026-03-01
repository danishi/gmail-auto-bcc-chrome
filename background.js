// Gmail Auto BCC - Background Service Worker

// 拡張機能インストール時の初期化
chrome.runtime.onInstalled.addListener((details) => {
	if (details.reason === 'install') {
		// 初期設定を保存
		chrome.storage.sync.set({
			accounts: []
		});

		// 設定ページを開く
		chrome.runtime.openOptionsPage();
	}
});

// メッセージハンドラ
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === 'getSettings') {
		chrome.storage.sync.get(['accounts'], (result) => {
			sendResponse({ accounts: result.accounts || [] });
		});
		return true; // 非同期レスポンスを示す
	}

	if (request.action === 'saveSettings') {
		chrome.storage.sync.set({ accounts: request.accounts }, () => {
			sendResponse({ success: true });
		});
		return true;
	}
});
