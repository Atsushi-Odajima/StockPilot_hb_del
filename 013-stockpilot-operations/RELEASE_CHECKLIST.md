# RELEASE_CHECKLIST — 販売前に人間が確認する項目

## 環境・契約（未実施）
- [ ] ホスティング・DB・ストレージ・ドメイン・メール送信の決定と有料契約（無料枠はデータ消失のため不可）
- [ ] 公式料金の再確認と OPERATING_COSTS.md 更新
- [ ] HTTPS・`PUBLIC_ORIGIN`・`REGISTRATION_DEFAULT_ENTITLEMENT=pending`・秘密情報を環境変数で設定
- [ ] DB 自動バックアップ／PITR、写真の複製、復旧訓練を1回実施
- [ ] パスワード再設定メールの実送信確認

## 実機（未実施・TEST_REPORT.md に記録）
- [ ] iPhone Safari：登録・ログイン・日本語入力・キーボードで保存ボタンが隠れない・画面回転
- [ ] iPhone ホーム画面追加（PWA）：起動・更新バナー・オフライン時の外枠表示と確定不可
- [ ] iPhone：背面カメラでJAN・内部QR（印刷物）を読取、権限拒否時の案内、アプリ復帰でカメラ停止
- [ ] iPhone：写真選択（HEIC設定時の挙動）、PDF表示・ファイル保存・共有シート
- [ ] Android Chrome：通常・インストール表示で同上
- [ ] 320px 幅・タブレット・Windows Chrome/Edge・macOS Safari の主要操作
- [ ] 印刷したQRラベル（A4・100%）のサイズと読取、Code128・EAN-8

## 販売条件（未決定）
- [ ] 提供期間、保存容量・件数上限、更新・サポート条件、継続費の負担
- [ ] プライバシー説明の保持期間・保存時暗号化の記載を実契約に合わせる（/privacy 画面・注意事項.txt）
- [ ] 価格（5,980〜9,800円は検証案）

## 表示・販売文
- [ ] 利益管理・EC自動同期・自動発注・完全オフライン・無制限・永久無料・「絶対にミスしない」と書いていない
- [ ] 架空レビュー・販売件数・未実施の実機検証を書いていない
- [ ] 負荷測定値を動作保証として書いていない

## 配布物
- [ ] `release/` の ZIP に秘密情報・実DB・実CSV・node_modules・キャッシュ・ログが含まれない（scripts/make-release.sh の出力一覧を確認）
- [ ] THIRD_PARTY_NOTICES.txt と assets/fonts/OFL.txt を同梱
