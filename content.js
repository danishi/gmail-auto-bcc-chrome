// Gmail Auto BCC - Content Script

(function () {
	'use strict';

	const DEBUG = false;
	function log(...args) {
		if (DEBUG) console.log(...args);
	}

	let _currentAccount = null;

	function getCurrentAccount() {
		if (_currentAccount) return _currentAccount;
		const accountElement = document.querySelector('[data-email]');
		if (accountElement) {
			_currentAccount = accountElement.getAttribute('data-email');
			return _currentAccount;
		}
		const title = document.title;
		const emailMatch = title.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
		if (emailMatch) {
			_currentAccount = emailMatch[0];
			return _currentAccount;
		}
		return null;
	}

	function getSettings() {
		return new Promise((resolve) => {
			chrome.storage.sync.get(['accounts'], (result) => {
				resolve(result.accounts || []);
			});
		});
	}

	function isVisible(el) {
		if (!el) return false;
		return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
	}

	function isSafeBccField(el) {
		if (!el) return false;
		const name = (el.getAttribute('name') || '').toLowerCase();
		const label = (el.getAttribute('aria-label') || '').toLowerCase();
		if (name === 'to' || name === 'subject' || name === 'cc') return false;
		if (label === 'to' || label === '宛先' || label.startsWith('to ') || label.startsWith('宛先 ')) return false;
		if (label === 'subject' || label === '件名') return false;
		return true;
	}

	function findBccField(composeWindow) {
		let field = composeWindow.querySelector('textarea[name="bcc"], input[name="bcc"]');
		if (field && isVisible(field) && isSafeBccField(field)) return field;

		const allTextareas = composeWindow.querySelectorAll('textarea, input[type="text"]');
		for (const el of allTextareas) {
			if (!isVisible(el)) continue;
			const label = (el.getAttribute('aria-label') || '').toLowerCase();
			if (label === 'bcc' || label.startsWith('bcc ')) {
				if (isSafeBccField(el)) return el;
			}
		}

		const rows = composeWindow.querySelectorAll('tr, div[role="row"]');
		for (const row of rows) {
			const text = (row.textContent || '').trim();
			if (text.includes('Bcc') || text.includes('BCC')) {
				if (text.startsWith('To') || text.startsWith('宛先')) continue;
				const input = row.querySelector('textarea, input[type="text"]');
				if (input && isVisible(input) && isSafeBccField(input)) {
					const name = input.getAttribute('name');
					if (!name || name === 'bcc') return input;
				}
			}
		}
		return null;
	}

	function clickBccButton(composeWindow) {
		const candidates = composeWindow.querySelectorAll('[role="button"], span, div[role="button"]');
		for (const el of candidates) {
			if (!isVisible(el)) continue;
			const text = el.textContent.trim();
			const tooltip = el.getAttribute('data-tooltip') || '';
			const label = el.getAttribute('aria-label') || '';
			if (text === 'Bcc' || text === 'BCC' || tooltip.includes('Bcc')) {
				if (el.querySelector('img, svg')) continue;
				if (label.match(/contact|連絡先/i)) continue;
				if (tooltip.match(/contact|連絡先/i)) continue;
				el.click();
				return true;
			}
		}
		return false;
	}

	function findBodyField(root) {
		if (!root) return null;
		const candidates = root.querySelectorAll('[contenteditable="true"], [role="textbox"], [g_editable="true"], .editable');
		let bestCandidate = null;
		let maxScore = -1;

		for (const el of candidates) {
			if (!isVisible(el)) continue;
			let score = 0;
			const label = (el.getAttribute('aria-label') || '').toLowerCase();
			const role = el.getAttribute('role');
			const size = el.offsetWidth * el.offsetHeight;
			const id = (el.id || '').toLowerCase();

			if (label.includes('body') || label.includes('本文') || label.includes('message')) score += 200;
			if (el.getAttribute('g_editable') === 'true') score += 150;
			if (role === 'textbox') score += 50;
			if (size > 10000) score += Math.floor(size / 1000);

			if (el.tagName === 'INPUT') score -= 2000;
			if (el.getAttribute('name') === 'subjectbox') score -= 2000;
			if (id.includes('subject')) score -= 2000;
			if (label.includes('to') || label.includes('宛先')) score -= 2000;
			if (label.includes('bcc') || label.includes('cc')) score -= 2000;

			if (score > maxScore) {
				maxScore = score;
				bestCandidate = el;
			}
		}
		return (maxScore > 20) ? bestCandidate : null;
	}

	async function moveFocusAfterBcc(composeWindow) {
		log('[Gmail BCC] フォーカス移動処理開始');

		const toField = composeWindow.querySelector('textarea[name="to"], input[name="to"], [aria-label*="To"], [aria-label*="宛先"]');
		if (toField && isVisible(toField)) {
			const toVal = (toField.value || toField.textContent || '').trim();
			if (!toVal) {
				log('[Gmail BCC] 新規作成(To空) -> Toへ');
				toField.focus();
				setTimeout(() => {
					const k = { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true };
					toField.dispatchEvent(new KeyboardEvent('keydown', k));
					toField.dispatchEvent(new KeyboardEvent('keyup', k));
				}, 10);
				return;
			}
		}

		let bodyField = findBodyField(composeWindow);
		if (!bodyField) {
			log('[Gmail BCC] 全域探索');
			bodyField = findBodyField(document.body);
		}

		if (bodyField) {
			log('[Gmail BCC] 本文へフォーカス移動');
			bodyField.focus();
			try {
				const range = document.createRange();
				range.selectNodeContents(bodyField);
				range.collapse(false);
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
			} catch (e) { }
			return;
		}

		const subjectField = composeWindow.querySelector('[name="subjectbox"], [name="subject"], [placeholder="件名"], [placeholder="Subject"]');
		if (subjectField && isVisible(subjectField)) {
			log('[Gmail BCC] 件名へフォーカス');
			subjectField.focus();
			return;
		}

		if (toField && isVisible(toField)) {
			log('[Gmail BCC] 最終手段: Toへフォーカス');
			toField.focus();
			return;
		}

		log('[Gmail BCC] フォーカス移動先なし (終了)');
	}

	async function processWindow(composeWindow) {
		if (composeWindow.dataset.bccState === 'done') return;

		const account = getCurrentAccount();
		if (!account) return;

		const settings = await getSettings();
		const config = settings.find(a => a.email.toLowerCase() === account.toLowerCase());
		if (!config || !config.enabled) {
			composeWindow.dataset.bccState = 'done';
			return;
		}
		const bccAddresses = config.bccAddresses || [];
		if (bccAddresses.length === 0) {
			composeWindow.dataset.bccState = 'done';
			return;
		}

		let bccField = findBccField(composeWindow);

		if (!bccField) {
			const clicked = clickBccButton(composeWindow);
			if (clicked) {
				await new Promise(r => setTimeout(r, 500));
				bccField = findBccField(composeWindow);
			} else {
				const toField = composeWindow.querySelector('[name="to"]');
				if (toField) {
					toField.focus();
					const k = { key: 'b', code: 'KeyB', keyCode: 66, which: 66, bubbles: true, shiftKey: true, metaKey: true };
					toField.dispatchEvent(new KeyboardEvent('keydown', k));
					toField.dispatchEvent(new KeyboardEvent('keyup', k));
					k.metaKey = false; k.ctrlKey = true;
					toField.dispatchEvent(new KeyboardEvent('keydown', k));
					toField.dispatchEvent(new KeyboardEvent('keyup', k));
					await new Promise(r => setTimeout(r, 500));
					bccField = findBccField(composeWindow);
				}
			}
		}

		if (bccField) {
			const current = bccField.value || '';
			const existing = current.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
			const toAdd = bccAddresses.filter(a => !existing.includes(a.toLowerCase()));

			if (toAdd.length > 0) {
				bccField.focus();
				const text = toAdd.join(', ') + ', ';

				if (!document.execCommand('insertText', false, text)) {
					bccField.value = current + (current ? ', ' : '') + text;
					bccField.dispatchEvent(new Event('input', { bubbles: true }));
				}
				log('[Gmail BCC] 入力完了');

				setTimeout(() => {
					moveFocusAfterBcc(composeWindow);
				}, 600);

			}
			composeWindow.dataset.bccState = 'done';
		}
	}

	function startObserver() {
		setInterval(() => {
			document.querySelectorAll('[role="dialog"], form').forEach(el => {
				if (el.dataset.bccState !== 'done') {
					if (el.querySelector('[name="to"]') || el.querySelector('[name="subject"]') || el.getAttribute('aria-label')?.includes('作成')) {
						processWindow(el);
					}
				}
			});
		}, 1500);
		log('[Gmail BCC] 監視開始');
	}

	if (document.readyState === 'complete') {
		startObserver();
	} else {
		window.addEventListener('load', startObserver);
	}

})();
