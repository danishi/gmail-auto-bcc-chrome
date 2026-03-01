# Gmail Auto BCC

Gmailでメールを作成する際、指定したメールアドレスを自動的にBCCに追加するChrome拡張機能です。

## インストール方法

1. このリポジトリをクローンまたはダウンロードします
   ```bash
   git clone https://github.com/danishi/gmail-auto-bcc-chrome.git
   ```
2. Chromeで `chrome://extensions` を開きます
3. 右上の「デベロッパーモード」を有効にします
4. 「パッケージ化されていない拡張機能を読み込む」をクリックします
5. クローンしたディレクトリを選択します

## 使い方

1. Chrome右上の拡張機能アイコンからGmail Auto BCCのアイコンをクリックします
2. BCCに自動追加したいメールアドレスを入力します
3. 「有効」チェックボックスがオンになっていることを確認します
4. 「保存」をクリックします

以降、Gmailで新規メール作成・返信・転送時にBCCが自動的にセットされます。

## 機能

- Gmailの新規作成、返信、転送すべてに対応
- ポップアップから簡単にBCCアドレスを設定・変更
- 有効/無効の切り替え
- 同じアドレスが既にBCCに設定されている場合は重複追加しない

## 技術仕様

- Chrome Manifest V3
- Gmail DOM監視（MutationObserver）によるリアルタイム検出
- `chrome.storage.sync` による設定の同期保存
