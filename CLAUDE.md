# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## これは何か

soundcloud.comにジャケット画像コピーボタンとメタデータタグ付きダウンロード機能を追加する、単一ファイルのTampermonkeyユーザースクリプト（`soundcloud-menu-extension.user.js`）。ビルドシステム、package.json、バンドラー、リンター、テストスイートは無い — 1つのIIFEにまとめたプレーンなvanilla JSで、Tampermonkeyが直接読み込む。ユーザー向けの機能一覧と日本語の利用メモは`README.md`を参照。

## 開発ワークフロー

ビルド/lint/testコマンドは無い — このプロジェクトにはそれらが存在しない。変更を確認する手順:
1. `soundcloud-menu-extension.user.js`を直接編集する。
2. Tampermonkeyのダッシュボードで、スクリプトの中身を更新後の内容に貼り替える（ディスクからインストールしている場合はリロード）。
3. soundcloud.com上で手動テストする — どの機能もログイン済みセッションが必要。

このスクリプトを実ブラウザの外で実行・型チェックする手段は無い（このリポジトリに`node`/バンドラーは無い）。開発環境で`node`が使えない場合は、コードを注意深く読み、バイナリオフセットやDOMセレクタを手で追って検証すること。

## アーキテクチャ

### 2つの機能領域と、共通のボタン/フィードバック基盤

1. **タイル/行オーバーレイのジャケットコピーボタン**（`insertTileButtons`/`createTileButton`） — ネイティブのLike/Follow/More（グリッドタイル）、Like/Repost/Share/Copy Link/More（リスト行、プレイリストのトラック行）、Like/Repost/Share/Copy Link/More（トラック自身の単体ページ）の各ボタンの隣、`.sc-button-more`の直前に挿入される。`ACTION_ROW_CONFIGS`は4種類の異なるDOM形状（グリッド「Badges」表示用の`.playableTile__actionWrapper`、「List」表示用の`.soundActions .sc-button-group`、プレイリスト（`/sets/...`）のトラック行用の`.trackItem .soundActions .sc-button-group`、単体ページ用の`.listenEngagement__footer .soundActions .sc-button-group`）を保持している。これはSoundCloudが文脈によって同じトラックを異なる形でレンダリングするため — 特にプレイリスト行は「List」表示の行とまったく同じボタングループのマークアップを再利用しているが、`.sound__body`/`.sound__artwork`ではなく`.trackItem`/`.trackItem__image`で包まれている。これが`permalinkFromScope()`と各configの`resolveCopy`が、1つの形状だけを前提にせず複数の包み方をチェックする必要がある理由。グリッド/リスト/プレイリストのconfigはタイル/行自身のDOMからジャケット画像のURLを取り出す（`copyArtworkFromTile`）。単体ページのconfigは代わりに`copyArtwork()`（api-v2ベースの取得。そこには読み取れる`.sound__body`タイル/行が無いため）を再利用する。グリッド（「Badges」）タイルのconfigだけがFont Awesomeの塗りつぶしクリップボードアイコン（`ICON_CLIPBOARD_SOLID`）を使う（ジャケット画像の真上に乗るため）。それ以外のconfig（リスト、プレイリスト、単体ページ）はすべて素のアウトラインアイコン（`ICON_IDLE`）を使う。
2. **「Download file with metadata」**（`insertDownloadButtons`/`createDownloadButton`） — ネイティブの`.sc-button-download`ボタンの直後、`.moreActions__group`内に挿入される。`downloadFileWithMetadata()`を呼び出す。

両者は`attachCopyHandler()`を共有しており、これがロード中→成功/失敗のアイコン状態遷移（`showFeedback`、`setIcon`）を制御し、エラー時にはローカライズされた失敗理由をトーストで表示する（`showToast`）。各ボタンは自分自身のアイドル時アイコンを`button._idleIcon`で覚えている（`showFeedback`が全ボタン共通で1つのアイコンにハードコーディングしないように — 実際に一度バグになったことがある）。タイルコピーボタンのホバー時ラベルは、ネイティブの`title`属性ではなく`attachSoundCloudTooltip()`を使っている — SoundCloud自身のツールチップが使うのと同じクラス（`tooltip`/`tooltip__arrow`/`tooltip__content`）でツールチップの吹き出しを組み立てるため、サイト自身のCSSを継承し、ネイティブのLike/Repost/Share/Copy Link/Moreのツールチップと同じ見た目になる（ブラウザの素のOSツールチップではなく）。

3つ目の、これらとは無関係な処理 — `insertPurchaseLinkDomains()` — はそもそもボタンではないので`attachCopyHandler()`を経由しない。あらゆる`.soundActions__purchaseLink`（「OUT NOW」形式の外部購入リンク）を見つけ、そのリンクの遷移先ドメインを表示するプレーンなテキストspanを追加する。`extractLinkDomain()`は、リダイレクト/ゲートサービス（例: `gate.sc?url=<エンコードされた本来のURL>`）を`url`クエリパラメータの有無で判定して解きほぐし、ゲート自身のホスト名の代わりにそちらのホスト名を使う（無ければhref自身のホスト名にフォールバックする）。

### SoundCloudはReact SPA — あらゆるものが継続的に再挿入される

`document.body`に対する単一の`MutationObserver`が、DOMの変更のたびに`insertTileButtons`/`insertDownloadButtons`/`insertPurchaseLinkDomains`を再実行する。理由:
- トラック一覧はユーザーがスクロールするたびに、より多くのタイル/行を遅延読み込みする。
- 「More」ドロップダウンメニューは、開かれるたびに新しくDOMへポータルされる（開いたタイル/行の近くにネストされるわけではない）。

ドロップダウンはトリガーから離れた場所にポータルされるため、`resolveTrackPermalink()`はトリガーボタンの`aria-owns`属性（ドロップダウンの`id`と一致する）を使って、ドロップダウンを自身のタイル/行に対応付け直し、そのタイル/行のジャケット画像リンクまたはタイトルリンクからトラックのpermalinkを読み取る。トリガー/スコープが見つからない場合（つまりそのドロップダウンがトラック自身の単体ページに属する場合）は`location.href`にフォールバックする。これはその場合には正しい答えになる。

### SoundCloudのページHTMLを直接fetchしない — 代わりにapi-v2のAJAXエンドポイントを使う

`fetch(someTrackPageUrl)`は断続的に`m.soundcloud.com`へリダイレクトされCORSでブロックされる — これはSoundCloudのbot対策（DataDome）が、今まさに見ているページであってもスクリプト発のHTML fetchにフラグを立てているため。トラックデータの取得（`fetchTrackData`、`GET api-v2.soundcloud.com/resolve?url=...`経由）とダウンロード処理（`fetchDownloadFile`、`GET api-v2.soundcloud.com/tracks/{id}/download`経由）は両方とも、代わりにこれを引き起こさないapi-v2のJSONエンドポイントを経由する。

これらの呼び出しの認証: `client_id`と`app_version`は、現在のページのライブなグローバル変数（`window.__sc_hydration`の`apiClient`エントリ、`window.__sc_version` — セッション単位でトラックごとではないため、SPAナビゲーションに関わらず常に最新）から`getSessionCredentials()`経由で取得する。それに加えて`Authorization: OAuth <token>`ヘッダー（`authHeaders()`）が必要で、これはhttpOnlyではない`oauth_token`クッキーから取得する — `client_id` + クッキーだけでは401が返る。

### ジャケット画像URLの解決とクリップボードの癖

- `getHighResUrl()`はトラックのサムネイルサイズのURLを最高解像度の`-original`に置き換える。**2種類の異なるサフィックス表記**にマッチさせる必要がある: Webアプリ自身が描画するDOMは`-t{width}x{height}`（例: `-t500x500`）を使うが、api-v2の`/resolve`レスポンスの`artwork_url`フィールドはSoundCloudの古い`-large`表記を使う。どちらか一方でも見逃すと、アップグレードが静かにスキップされ、小さくPNGでないことが多い画像にフォールバックしてしまう。
- Chromeのクリップボード APIが`navigator.clipboard.write()`で保証しているのは`image/png`のみ — 一部のジャケット画像（特に`-original`版が存在しないもの）は`image/jpeg`で配信されており、書き込みがそのまま拒否されることがある（`NotAllowedError: ... Type image/jpeg not supported on write`）。`resolveArtworkBlob()`は、PNGでないblobを書き込み前に`OffscreenCanvas`/`createImageBitmap`経由で変換する。この変換は意図的に、ダウンロード＆タグ付け機能側のジャケット画像取得（`fetchArtworkBuffer`）には適用していない — そちらは別のコードパスであり、クリップボードのフォーマット制約を受けないため。
- `navigator.clipboard.write()`は「呼び出された瞬間にドキュメントがフォーカスされていること」も要求する（フォーカスが外れていると`NotAllowedError: Document is not focused.`）。クリックした後にウィンドウを切り替えられてもコピーが成立するように、`copyArtworkFromBaseUrl()`/`copyArtwork()`は実際のfetch/PNG変換（`resolveArtworkBlob()`/`resolveHeroArtworkBlob()`）を`ClipboardItem`に**解決前のPromiseのまま**渡し、`.write()`自体はawaitを一切挟まずクリックと同じ同期呼び出しの中で呼ぶ。この経路（`attachCopyHandler`のクリックハンドラ→`copyFn()`→…→`.write()`）のどこかに`await`を挟むと、この対策は静かに効かなくなる。

### メタデータタグの書き込み（WAV / MP3 / FLAC）

各フォーマットの「既に設定されていればそのまま、無ければタイトル/アーティスト/アルバム/ジャンル（/ジャケット画像）を埋める」というロジックは、フォーマットごとに手書きしたバイナリパース処理であり、コンテナフォーマット同士に関連が無いためフォーマット間で共有する抽象化は無い:

- **WAV**: `parseWavChunks`/`buildInfoChunk`/`mergeWavMetadata`が、タイトル/アーティスト/アルバム/ジャンル用の`LIST/INFO` RIFFチャンク（`INAM`/`IART`/`IPRD`/`IGNR`）を読み書きする。WAV自体のINFOチャンクにはジャケット画像の規約が無いため、ジャケット画像は*さらに*、非標準だがffmpeg/mutagenが認識する、丸ごとID3v2タグを保持する`id3 ` RIFFチャンクにも入れる（MP3のタグ生成ロジックを再利用 — `buildId3Tag`を空のseedバッファで呼び出してタグ単体のバイト列を得て、`buildRiffChunk`で包む）。
- **MP3**: `parseExistingId3`（手書きのID3v2リーダー — `TIT2`/`TALB`/`TPE1`/`TCON`/`APIC`のみを理解し、それ以外は扱わない）+ `buildId3Tag`。実際のタグ書き込みは`browser-id3-writer`（**バージョン固定**のunpkg URLから動的に`import()`する — 固定前にソースを手動でレビュー済み。バージョンを上げる際は再レビューすること）に委譲する。`browser-id3-writer`は常にタグをゼロから再構築するため、*それ以外*の既存ID3フレーム（コメントなど）は静かに失われる — これは受け入れ済みの意図的なトレードオフであり、修正すべきバグではない。
- **FLAC**: `parseFlacBlocks`/`buildVorbisCommentBlock`/`buildPictureBlock`/`mergeFlacMetadata` — 外部ライブラリ無しの完全な手書き実装。Vorbisコメントのフィールドはリトルエンディアンだが、メタデータブロックのヘッダーと`PICTURE`ブロックのフィールドはビッグエンディアン（Ogg Vorbisから引き継いだ癖で、逆にしがちなので注意）。`STREAMINFO`は必ず先頭のブロックのままにしておく必要があり、「最後のメタデータブロック」フラグはブロックの挿入/削除のたびにブロック連鎖全体にわたって再計算する必要がある。

`downloadFileWithMetadata()`は`detectAudioFormat()`（マジックバイト＋content-typeの判定）の結果で処理を振り分ける。それ以外の形式（m4aなど）は無加工でダウンロードされる。ファイル本体（`fetchDownloadFile`）の取得はこの時点ですでに成功している（SoundCloud側のダウンロード数もすでに消費されている可能性がある）ため、その後のタグ埋め込み（`mergeMetadata`）が失敗してもダウンロード全体を失敗扱いにはしない — `try/catch`で囲み、失敗時はタグ無しの元`buffer`のまま`triggerFileDownload()`に進め、その旨をトーストで通知する（`taggingFailed`フラグ）。

### 「Moreボタンにダウンロードがあるか」の受動的な判定（`document-start` + fetch/XHRパッチ）

表示中の各トラックについてダウンロード可否を確認するための追加のapi-v2リクエストを発行するのではなく、`patchFetchForDownloadableInfo()`/`patchXhrForDownloadableInfo()`が`window.fetch`と`XMLHttpRequest`の両方をラップし、SoundCloud自身のアプリがトラック一覧の描画のためにすでに取得しているJSON（stream/likes/playlist/searchはすべて内部的にapi-v2を経由する）を横から読み取る。**両方**へのパッチが必要で`fetch`だけでは足りない — 例えばlikes一覧（`/users/{id}/track_likes`）は`fetch`ではなく`XMLHttpRequest`経由であることが判明した。これは一時的なデバッグログを追加し、受動的なハイライトが一向に発火しない際にNetworkタブの「Type」列を確認して発見した。`recordDownloadableInfo()`は、パースしたJSONの中から`permalink_url`と`downloadable`の両方を持つオブジェクトを再帰的にスキャンする — エンドポイントごとに異なるレスポンス形状をハードコーディングするのではなく、この方法で`downloadableByPath`にURLのパス名をキーとして記録する。`downloadable`だけでは不十分: トラックのダウンロード数上限（`download_count`）を使い切った後も`true`のままになりうるため、実際に記録される値は`downloadable && has_downloads_left !== false`である — `downloadable: true, has_downloads_left: false`のトラックは、`downloadable`がそう言っているにも関わらず、ネイティブの「Download file」項目がまったく出ない。`highlightDownloadableTriggers()`は、各`.sc-button-more`トリガー自身のタイル/行のpermalinkをこのマップと突き合わせ、`markTriggerDownloadable()`を呼び出す。これが`MORE_BUTTON_HIGHLIGHT_CLASS`/`MORE_BUTTON_ICON_HIGHLIGHT_CLASS`を付与し、プレイリスト（`/sets/...`）の行に限っては、`insertInlinePlaylistDownloadIcon()`経由で`.trackItem__playCount`の左に常時表示（非ホバー）のダウンロードインジケーターも挿入する — プレイリストの行は密集していて、ホバーで出る「More」ボタンだけでは見つけにくいと判断したため。これは`trigger.dataset.scDownloadPath`（そのトリガーが最後に評価されたときの解決済みpermalink）をキーにしており、「一度見たら終わり」の一方向ラッチではない — SPAナビゲーションはまったく同じトリガー要素を別のトラックのために使い回すことがある（例えばある単体ページから別の単体ページへ直接遷移する場合）ため、毎回のチェックで*現在*解決したpermalinkを保存済みのものと比較し、両者が異なれば`clearTriggerDownloadableState()`を呼んで古いハイライトを消してから再評価する（過去の一致を永久に信用するのではなく）。このインジケーターはボタンではなく素の`<span>`である: `.trackItem`行にホバーすると、SoundCloud自身のネイティブなオーバーレイ/メニューが同じ場所に表示されクリックを奪ってしまうため、`.trackItem:hover .scArtworkCopy__inlineDownloadIcon { display: none }`でその間だけ隠す（クリックの奪い合いはしない）。`downloadFileWithMetadata(trackUrl)`（現在はMoreメニュー項目からのみ使われる）はドロップダウン要素ではなく解決済みのトラックURLを受け取る — `createDownloadButton()`は呼び出し前に`resolveTrackPermalink(dropdownEl)`経由で自分でそのURLを解決する。

これが機能するのは、SoundCloud自身のスクリプトがこれらの呼び出しを始める**前に**パッチを組み込んだ場合のみであり、それが`@run-at document-start`にしている理由。その結果、スクリプトのトップレベルコードが実行される時点では`document.body`/`document.head`がまだ存在しない可能性があるため、DOMに触れるセットアップ（スタイルの挿入、`MutationObserver`、初回のボタン挿入呼び出し）はすべて`whenDomReady()`経由で遅延させている（`document.readyState === 'loading'`なら`DOMContentLoaded`を待ち、そうでなければ即実行する）。初回ページ読み込み時の最初のトラック一覧は、横取り可能なAJAX呼び出し経由ではなく`window.__sc_hydration`に直接埋め込まれていることが多いため、そちらは同じ`whenDomReady`コールバック内で一度きりのフォールバックとしてスキャンする。SPAナビゲーションや遅延読み込みスクロールは、代わりにライブのfetch/XHRパッチでカバーされる。

`insertDownloadButtons()`は、トラックのトリガーを別途、その「More」ドロップダウンが実際に開かれてネイティブの`.sc-button-download`を含んでいると分かった最初のタイミングでもマークする — 受動的なスキャンがデータを捕捉できなかったトラックのためのフォールバック。

### エラー処理・ローカライズ

すべての失敗経路は、生の文字列メッセージではなく`failWith(code, params)`経由で例外を投げる。これにより、ユーザーに表示されるトースト（`localizeError`、`navigator.language`をキーに英語/日本語のみ対応）が、`console.error`に今も使われる英語の`err.message`から独立した状態を保てる。新しい失敗ケースを追加する際は、`failWith('SOME_CODE', {...})`の呼び出しと`ERROR_MESSAGES`への対応するエントリの両方を追加すること — `throw new Error('...')`を直接使うと、汎用的な「Something went wrong」トーストにフォールバックしてしまう。
