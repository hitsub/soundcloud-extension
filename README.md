# SoundCloud Menu Extension

主に以下の機能を追加するTampermonkey用のスクリプト。
- SoundCloud上でジャケット画像のコピー
- ダウンロード時にファイルに対してメタ情報を書き込む機能

> [!WARNING]
> 利用前に必ず読んで同意をしてください
> - 本スクリプトはSoundCloud, Inc.とは無関係の非公式なツールであり、個人が開発・公開しているものです。
> - 本スクリプトの一部機能はSoundCloudの非公開API（`api-v2.soundcloud.com`）を直接呼び出しており、利用規約に抵触する可能性があります。**すべて自己責任でご利用ください。**
> - 本スクリプトは`@grant none`で動作し、直接ページを読み書きします。現在のバージョンはSoundCloud自身のAPIとライブラリ取得用のCDN以外へは何も送信していませんが、Tampermonkeyはインストール元URLを更新チェック先として使うため、更新は今後も自動的に適用されます。Tampermonkeyの設定で「更新前に差分を表示する」オプションを有効にし、更新内容を確認してから適用することを推奨します。
> - 本リポジトリにおけるコードのうち大半がAI生成によるものです。また、生成を指示した人間はウェブ開発を本業としない人間です。**すべて自己責任でご利用ください。**

# 導入方法

0. 上記事項を読み同意する。
1. TampermonkeyをChromeウェブストアからインストールする。
    - https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo
2. [このリンクを開く](https://github.com/hitsub/soundcloud-extension/raw/refs/heads/main/soundcloud-menu-extension.user.js)。
3. Tampermonkeyが立ち上がるので、インストールする。
   <img width="844" height="425" alt="image" src="https://github.com/user-attachments/assets/a59ac06d-c2f5-4e2c-8938-8851f6bb6baf" />
4. 拡張機能の詳細ページを開く
   - [chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo](chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo)
5. 「ユーザースクリプトを許可する」にチェックを付ける
<img width="756" height="211" alt="image" src="https://github.com/user-attachments/assets/151e8e8d-8105-4c63-b0a6-168d5092d013" />


# 機能

## ジャケット画像のコピーボタン

各画面におけるメニューにジャケット画像をコピーするボタンが増えているので、押せばOK。  
FeedやLikes、プレイリストなど各画面に対応。

<img width="604" height="190" alt="image" src="https://github.com/user-attachments/assets/95b00af1-0daf-4f90-8bca-be76238d8853" />

<details>
<summary> 詳細</summary>

本来のジャケット画像の形式に依らず、PNG形式でクリップボードにコピーされる。

楽曲のサムネが設定されておらず、投稿者のユーザーアイコンがそのまま表示されている楽曲ではコピーできない。  
また、StationやDailyRecommendの画像などもコピーできない。

</details>

## ダウンロード時のメタ情報書き込み

各楽曲のメニューにおいて「Download file」があるとき、その下の行に「Download file with metadata」が追加されるので、そこから実行することができる。  
対応形式は wav、mp3、flac の３種類。

<img width="376" height="233" alt="image" src="https://github.com/user-attachments/assets/4d5d0c3e-9b67-468a-9c01-98572123d616" />

ダウンロード後、AudioShellなど対応したソフトで閲覧するとタグ情報が入っていることが確認できる。

<img width="763" height="419" alt="image" src="https://github.com/user-attachments/assets/16ce94fb-55e9-468a-9952-ae6b745b05b9" />

> [Everything feels warmer now / C4T4L1](https://soundcloud.com/c4t4l1/everything-feels-warmer-now)


> [!NOTE]
> WindowsやiTunesなどの一部ソフトはWAVに書き込まれているメタデータの読み取りに対応していないので注意してください。  
> fre:acなどのソフトを使うことで、読み取りつつメタデータを維持して別の形式(mp3など)に変換ができます。


<details>
<summary> 詳細</summary>

楽曲のダウンロードが可能になっているものに対し、ダウンロード時に以下の情報を埋め込む。  
ただし、すでにある情報に対しては上書きせず、空の場合にのみ以下を上書きする。
- 楽曲タイトル
- アーティスト名
- アルバム名（楽曲タイトル名と同一）
- ジャンル
- ジャケット画像

また、メタ情報の書き込みに失敗した場合は通知しつつ元データの保存のみを行う。

SoundCloud自身が一覧表示のために裏で取得している情報（api-v2のレスポンス、および初回表示時のページ埋め込みデータ）を読み取って判定しており、こちらから追加の通信は行わない。

<details>
<summary>対応形式ごとの詳細</summary>

下記以外の形式（m4aなど）は無加工でダウンロードされる。

- **WAV**
    - `LIST/INFO`チャンク
        - `INAM` : タイトル
        - `IART` : アーティスト
        - `IPRD` : アルバム名
        - `IGNR` : ジャンル
    - `id3 `チャンク
        - `APIC`フレームでジャケット画像を保持

非標準だがffmpeg/mutagenなどが採用している id3 チャンクにジャケット画像を書き込む。  
MP3と共通のID3v2タグ生成ロジックを再利用して実装。

- **MP3**
    - `ID3v2`
        - `TIT2` : タイトル
        - `TPE1` : アーティスト
        - `TALB` : アルバム名
        - `TCON` : ジャンル
        - `APIC` : ジャケット画像

既存タグの読み取りは自前実装、書き込みは外部ライブラリ`browser-id3-writer`（バージョン固定・ソース確認済み、CDNから実行時に取得しSHA-256ハッシュを検証した上で動的import）を使用する。

- **FLAC**

`VORBIS_COMMENT`ブロックと`PICTURE`ブロックに書き込む。  
自前実装（外部ライブラリ不要）。  

</details>

</details>

## ダウンロード可能な楽曲の目立たせ

ダウンロードできる楽曲のMoreボタンはオレンジ色で目立つ表示になる。  
グリッド（Badges）表示ではジャケット画像自体がオレンジのアウトラインで囲まれる。  
プレイリストやStationにおいては、再生数の左に表示がされる。

Likesの表示例:
<img width="913" height="498" alt="image" src="https://github.com/user-attachments/assets/50f8c7e9-9037-44db-adb1-413da20bda94" />

プレイリストの表示例:
<img width="853" height="292" alt="image" src="https://github.com/user-attachments/assets/046e4a9a-2f3c-44ea-9313-bec7ba750617" />


<details>
<summary> 詳細</summary>

上記同様、SoundCloud自身が一覧表示のために裏で取得している情報（api-v2のレスポンス、および初回表示時のページ埋め込みデータ）を読み取って判定しており、こちらから追加の通信は行わない。  
この情報がまだ取得できていないトラックについては、実際に「More」を開いてDownload fileの有無を確認した時点でハイライトされる。

プレイリストページ（`/sets/...`）では、ダウンロード可能なトラックの再生回数の左隣に、ホバーなしで常時表示のダウンロードアイコンも表示される（クリックはできない目印のみ。行にマウスオーバーした際に表示されるSoundCloud側のメニューと重なって押せなくなるため、その間はこのアイコン自体を非表示にする）。

</details>

## 購入リンクの遷移先ドメイン表示

楽曲に Buy link（カートアイコンの外部リンク）が設定されている場合、そのアイコンの右にリンク先のドメイン名を表示する。  
`gate.sc`のようなリダイレクト/ゲートサービス経由のリンクは、URLパラメータに含まれる本来の遷移先（例: `hypeddit.com`）を表示する。

<img width="231" height="300" alt="image" src="https://github.com/user-attachments/assets/ef83ba7a-28c2-4cc0-bec1-26401a94a5d7" />


## BuyLinkの目立たせ表示

SoundCloud純正のカートアイコン（購入リンク）が出ない画面（プレイリストのリストビューなど）でも、BuyLinkが設定されている楽曲は分かるようにする。
- プレイリスト・Stationの「More」ボタンに白いアウトラインが付く（ダウンロード可能でもある楽曲は、そちらが優先されオレンジのままになる）
- グリッド（Badges）表示では、ジャケット画像自体が白いアウトラインで囲まれる（Lightテーマでは黒色。ダウンロード可能でもある楽曲は、そちらが優先されオレンジのままになる）
- プレイリストでは、再生回数の左に（ダウンロードアイコンと同様の）カートアイコンの目印が表示される
- プレイリスト・Station・グリッド（Badges）表示の「More」メニューに「Open BuyLink (ドメイン名)」が追加され、クリックすると新しいタブでBuyLinkが開く

<details>
<summary> 詳細</summary>

「ダウンロード可能な楽曲の目立たせ」と同じ仕組み（SoundCloud自身が裏で取得している情報を読み取るのみ）で判定しており、こちらから追加の通信は行わない。プレイリストのカートアイコン同様、目印はクリックできず、実際にBuyLinkを開くのは「More」メニューの「Open BuyLink」からのみ。白いアウトラインと「Open BuyLink」はどちらも、ネイティブの購入リンクがそもそも表示されないプレイリスト・Station・グリッド（Badges）表示の画面に限定して追加する（それ以外の画面ではネイティブのカートアイコンがすでに見えているため）。

</details>

## 動作条件・制限

- ログイン済みのSoundCloudを対象とする。
- 一覧ページのコピーボタンは、サムネイル画像がまだ遅延読み込みされていない場合は失敗表示になる。
- 「Download file with metadata」は、SoundCloudの非公開API（`api-v2.soundcloud.com`の`/resolve`と`/tracks/{id}/download`）を利用している。認証には`oauth_token`クッキーの値を`Authorization`ヘッダーとして付与している。
- ダウンロード可否のハイライトは、ページ読み込みの最初期（`@run-at document-start`）に`window.fetch`と`XMLHttpRequest`の両方をラップして実現している。SoundCloud自身のスクリプトが読み込まれる前にこの差し替えを済ませる必要があるための措置（一覧取得の通信が`fetch`ではなく`XMLHttpRequest`経由だったため、両方への対応が必要だった）。
- MP3のID3v2タグ書き込みでは、タイトル/アルバム/アーティスト/ジャンル/ジャケット以外の既存タグ（例: コメント）は保持されない（`browser-id3-writer`が既存タグを丸ごと消して新規に書き直す仕様のため）。WAV・FLACは対象外のチャンク/ブロックはそのまま保持される。
