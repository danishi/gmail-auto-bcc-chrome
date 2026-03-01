// Gmail Auto BCC - Options Page Script

document.addEventListener('DOMContentLoaded', () => {
	// DOM要素
	const accountsList = document.getElementById('accountsList');
	const emptyState = document.getElementById('emptyState');
	const addAccountBtn = document.getElementById('addAccountBtn');
	const modal = document.getElementById('modal');
	const modalTitle = document.getElementById('modalTitle');
	const accountForm = document.getElementById('accountForm');
	const accountEmail = document.getElementById('accountEmail');
	const bccAddressesList = document.getElementById('bccAddressesList');
	const addBccBtn = document.getElementById('addBccBtn');
	const accountEnabled = document.getElementById('accountEnabled');
	const closeModalBtn = document.getElementById('closeModalBtn');
	const cancelBtn = document.getElementById('cancelBtn');
	const deleteModal = document.getElementById('deleteModal');
	const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
	const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
	const toast = document.getElementById('toast');
	const toastMessage = document.getElementById('toastMessage');

	let accounts = [];
	let editingIndex = -1;
	let deletingIndex = -1;

	// 設定を読み込み
	async function loadSettings() {
		return new Promise((resolve) => {
			chrome.storage.sync.get(['accounts'], (result) => {
				accounts = result.accounts || [];
				resolve();
			});
		});
	}

	// 設定を保存
	async function saveSettings() {
		return new Promise((resolve) => {
			chrome.storage.sync.set({ accounts }, () => {
				resolve();
			});
		});
	}

	// アカウントリストを描画
	function renderAccounts() {
		accountsList.innerHTML = '';

		if (accounts.length === 0) {
			emptyState.classList.remove('hidden');
			return;
		}

		emptyState.classList.add('hidden');

		accounts.forEach((account, index) => {
			const card = document.createElement('div');
			card.className = `account-card ${account.enabled ? '' : 'disabled'}`;

			const bccText = account.bccAddresses.length > 0
				? `BCC: ${account.bccAddresses.join(', ')}`
				: 'BCCアドレス未設定';

			card.innerHTML = `
        <div class="account-info">
          <div class="account-email">
            ${escapeHtml(account.email)}
            <span class="account-status ${account.enabled ? 'status-enabled' : 'status-disabled'}">
              ${account.enabled ? '有効' : '無効'}
            </span>
          </div>
          <div class="account-bcc">${escapeHtml(bccText)}</div>
        </div>
        <div class="account-actions">
          <button class="btn-icon edit" data-index="${index}" title="編集">✏️</button>
          <button class="btn-icon delete" data-index="${index}" title="削除">🗑️</button>
        </div>
      `;

			accountsList.appendChild(card);
		});

		// イベントリスナーを設定
		document.querySelectorAll('.btn-icon.edit').forEach(btn => {
			btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.index)));
		});

		document.querySelectorAll('.btn-icon.delete').forEach(btn => {
			btn.addEventListener('click', () => openDeleteModal(parseInt(btn.dataset.index)));
		});
	}

	// HTMLエスケープ
	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	// BCCアドレス入力欄を追加
	function addBccAddressRow(value = '') {
		const row = document.createElement('div');
		row.className = 'bcc-address-row';
		row.innerHTML = `
      <input type="email" class="bcc-input" placeholder="bcc@example.com" value="${escapeHtml(value)}">
      <button type="button" class="btn-remove" title="削除">✕</button>
    `;

		row.querySelector('.btn-remove').addEventListener('click', () => {
			row.remove();
		});

		bccAddressesList.appendChild(row);
	}

	// モーダルを開く（新規追加）
	function openAddModal() {
		editingIndex = -1;
		modalTitle.textContent = 'アカウントを追加';
		accountEmail.value = '';
		accountEnabled.checked = true;
		bccAddressesList.innerHTML = '';
		addBccAddressRow();
		modal.classList.remove('hidden');
		accountEmail.focus();
	}

	// モーダルを開く（編集）
	function openEditModal(index) {
		editingIndex = index;
		const account = accounts[index];
		modalTitle.textContent = 'アカウントを編集';
		accountEmail.value = account.email;
		accountEnabled.checked = account.enabled;
		bccAddressesList.innerHTML = '';

		if (account.bccAddresses.length > 0) {
			account.bccAddresses.forEach(addr => addBccAddressRow(addr));
		} else {
			addBccAddressRow();
		}

		modal.classList.remove('hidden');
		accountEmail.focus();
	}

	// モーダルを閉じる
	function closeModal() {
		modal.classList.add('hidden');
		editingIndex = -1;
	}

	// 削除確認モーダルを開く
	function openDeleteModal(index) {
		deletingIndex = index;
		deleteModal.classList.remove('hidden');
	}

	// 削除確認モーダルを閉じる
	function closeDeleteModal() {
		deleteModal.classList.add('hidden');
		deletingIndex = -1;
	}

	// アカウントを削除
	async function deleteAccount() {
		if (deletingIndex >= 0) {
			accounts.splice(deletingIndex, 1);
			await saveSettings();
			renderAccounts();
			showToast('アカウントを削除しました');
		}
		closeDeleteModal();
	}

	// フォーム送信
	async function handleSubmit(e) {
		e.preventDefault();

		const email = accountEmail.value.trim();
		const enabled = accountEnabled.checked;
		const bccAddresses = Array.from(bccAddressesList.querySelectorAll('.bcc-input'))
			.map(input => input.value.trim())
			.filter(addr => addr !== '');

		// 重複チェック
		const existingIndex = accounts.findIndex(
			acc => acc.email.toLowerCase() === email.toLowerCase()
		);

		if (existingIndex >= 0 && existingIndex !== editingIndex) {
			showToast('このメールアドレスは既に登録されています', true);
			return;
		}

		const accountData = {
			email,
			enabled,
			bccAddresses
		};

		if (editingIndex >= 0) {
			accounts[editingIndex] = accountData;
			showToast('設定を更新しました');
		} else {
			accounts.push(accountData);
			showToast('アカウントを追加しました');
		}

		await saveSettings();
		renderAccounts();
		closeModal();
	}

	// トースト通知を表示
	function showToast(message, isError = false) {
		toastMessage.textContent = message;
		toast.style.background = isError ? '#ea4335' : '#323232';
		toast.classList.remove('hidden');

		setTimeout(() => {
			toast.classList.add('hidden');
		}, 3000);
	}

	// イベントリスナー
	addAccountBtn.addEventListener('click', openAddModal);
	closeModalBtn.addEventListener('click', closeModal);
	cancelBtn.addEventListener('click', closeModal);
	addBccBtn.addEventListener('click', () => addBccAddressRow());
	accountForm.addEventListener('submit', handleSubmit);
	cancelDeleteBtn.addEventListener('click', closeDeleteModal);
	confirmDeleteBtn.addEventListener('click', deleteAccount);

	// モーダル外クリックで閉じる
	modal.addEventListener('click', (e) => {
		if (e.target === modal) closeModal();
	});

	deleteModal.addEventListener('click', (e) => {
		if (e.target === deleteModal) closeDeleteModal();
	});

	// ESCキーでモーダルを閉じる
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			if (!modal.classList.contains('hidden')) closeModal();
			if (!deleteModal.classList.contains('hidden')) closeDeleteModal();
		}
	});

	// 初期化
	loadSettings().then(renderAccounts);
});
