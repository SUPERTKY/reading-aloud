# 音声つきPDFワークプレイヤー

PDFワークを1ページずつ大きく表示し、音声の再生・一時停止・停止と、無期限の「記入待ち」を行えるGitHub Pages向けサイトです。PDFのページは利用者が操作したときだけ切り替わり、音声終了時には自動で進みません。

## できること

- ZIPをドラッグ＆ドロップして、PDF・台本・音声をブラウザ内だけで読み込み
- 1ページを画面いっぱいに表示。全体表示、幅合わせ、拡大縮小、全画面
- ページ番号を常時表示し、矢印・ページ番号入力・キーボードで手動移動
- 読み上げ、一時停止、再開、停止
- `wait` の位置で時間制限なく待機し、「書き終わったら続ける」で再開
- PDF上をドラッグして回答欄を手動配置し、移動・サイズ変更・削除
- 回答欄ごとに「1行・改行なし」「複数行・改行あり」「○印・あり／なし」を選択
- 編集した `script.json` をPDF・音声と一緒に新しいZIPとして保存
- 配置モードを終了すると、作った回答欄へ直接入力
- 回答をブラウザに自動保存し、JSONとして書き出し
- VOICEVOXの生成済みWAVを優先し、WAVがなければブラウザ音声で試聴

## 教材ZIPの形式

```text
workbook.zip
├─ workbook.pdf
├─ script.json
└─ audio/
   ├─ page-001-cue-001.wav
   └─ ...
```

`script.json` の最小例です。

```json
{
  "version": 1,
  "id": "my-workbook-v1",
  "title": "私のワーク",
  "pdf": "workbook.pdf",
  "voiceCredit": "VOICEVOX:使用キャラクター名",
  "pages": [
    {
      "page": 1,
      "cues": [
        {"type": "speak", "text": "最初の説明です。", "audio": "audio/page-001-cue-001.wav"},
        {"type": "wait", "label": "ここを書いてください。"},
        {"type": "speak", "text": "続きの説明です。", "audio": "audio/page-001-cue-003.wav"}
      ]
    }
  ]
}
```

完全な例は `examples/horror-workbook-script.json`、JSON Schemaは `examples/script.schema.json` にあります。

## 画面で回答欄を手動配置する

1. 教材ZIPをプレイヤーへ読み込みます。
2. 回答欄を置きたいPDFページへ移動します。
3. 上部の **「入力欄を配置」** を押します。
4. **「1行・改行なし」**、**「複数行・改行あり」**、**「○印・あり／なし」** から種類を選びます。
5. PDF上をドラッグすると、その大きさで入力欄が作られます。
6. 欄の中央をドラッグすると移動、右下の丸いハンドルをドラッグするとサイズ変更できます。選択した欄の種類変更・削除もできます。
7. **「ZIPを保存」** を押すと、編集後の `script.json`、元のPDF、元の音声を含む新しいZIPが保存されます。

保存前に別のZIPを開いたりページを閉じたりすると確認が表示されます。回答欄の配置は、ZIPとして保存して初めてファイルへ残ります。

画面で作った欄は、`script.json` の各ページの `fields` に保存されます。位置と大きさは、PDFページ全体を100とした割合です。必要ならJSONを直接編集することもできます。

| 項目 | 内容 |
|---|---|
| `id` | ページ内で重複しない回答欄ID |
| `type` | `single-line` は改行不可、`multiline` は改行可、`circle-toggle` は○印のオン／オフ |
| `x`, `y` | 左上の位置（0〜100%） |
| `width`, `height` | 欄の大きさ（0〜100%） |
| `label` | 読み上げ支援用の欄名 |
| `placeholder` | 未入力時に表示する案内 |
| `maxLength` | 任意の最大文字数 |
| `fontScale` | 任意の文字サイズ倍率 |

`circle-toggle` は、配置モードを終了したあとにクリックすると○印が付き、もう一度クリックすると消えます。回答JSONには○ありを `true`、○なしを `false` として保存します。選択肢や確認項目の上へ小さく配置して使えます。

読み方だけを直す場合は、表示文を `text` に残し、音声合成へ送る文を `reading` に書けます。

```json
{"type": "speak", "text": "怪異は全部見せない", "reading": "かいいは、ぜんぶみせない"}
```

## ページ内のVOICEVOXクレジット

`script.json` の `voiceCredit` は、プレイヤー画面の下部に常時表示されます。音声を再生していない間やページを移動した後も消えません。

```json
"voiceCredit": "VOICEVOX:四国めたん"
```

VOICEVOX自動生成スクリプトを使う場合、選択した話者名からこの項目も自動設定されます。表記を個別に指定したい場合は `--credit` を追加できます。

```bash
python tools/package_with_voicevox.py build \
  --pdf path/to/workbook.pdf \
  --script script.json \
  --speaker STYLE_ID \
  --credit "VOICEVOX:使用キャラクター名" \
  --out workbook.zip
```

キャラクターごとに指定された表記がある場合は、その利用規約を優先してください。

## VOICEVOX音声入りZIPを作る

1. VOICEVOXを起動します。
2. 話者のスタイルIDを調べます。

```bash
python tools/package_with_voicevox.py list-speakers
```

3. PDF、台本、話者IDを指定して教材ZIPを作ります。

```bash
python tools/package_with_voicevox.py build \
  --pdf path/to/workbook.pdf \
  --script examples/horror-workbook-script.json \
  --speaker STYLE_ID \
  --out horror-workbook.zip
```

補助スクリプトはローカルの `http://127.0.0.1:50021` にだけ接続し、`speak` ごとのWAVと正しい音声パスをZIPへ入れます。VOICEVOXを使わず動作を試す場合は、`--speaker STYLE_ID` の代わりに `--browser-voice` を使います。

## ローカルで開発する

Node.js 22以上を用意します。

```bash
npm install
npm run dev
```

本番ビルドは `npm run build`、確認は `npm run preview` です。

## GitHub Pagesへ公開する

1. このフォルダーの内容をGitHubリポジトリの `main` ブランチへ置きます。
2. リポジトリの **Settings → Pages → Build and deployment** で **GitHub Actions** を選びます。
3. `main` へpushすると `.github/workflows/pages.yml` がビルドして公開します。

サイトは静的です。PDFや回答はサーバーへ送信されず、選んだZIPは利用者のブラウザ内で処理されます。ただし、教材ZIPそのものをリポジトリへ置くと公開物になるため、公開したくない教材はサイト上で利用者自身に選ばせてください。

## 操作

| 操作 | 内容 |
|---|---|
| Space | 読み上げ／一時停止／再開 |
| ← / → | 前／次ページ（音声は停止） |
| 「入力欄を配置」 | 現在のページに回答欄を追加・編集 |
| 配置中にPDFをドラッグ | 選んだ種類の回答欄を作成 |
| 配置中に欄をドラッグ | 回答欄を移動 |
| 配置中に欄の右下をドラッグ | 回答欄のサイズを変更 |
| 「ZIPを保存」 | 入力欄を含む新しい教材ZIPを保存 |
| PDF上の入力欄 | 配置モード終了後、回答を入力 |
| PDF上の○印ボックス | クリックして○印のあり／なしを切り替え |
| 「回答を保存」 | 全ページの回答をJSONで保存 |

## VOICEVOX利用時の注意

- サイトや教材ZIPにはVOICEVOX本体・Engineを同梱せず、手元で生成した音声ファイルだけを使います。
- `voiceCredit` に `VOICEVOX:キャラクター名` など、利用した音声ライブラリの条件に合うクレジットを記載します。プレイヤー画面下部に常時表示されます。
- VOICEVOX全体の規約だけでなく、選んだキャラクター／音声ライブラリ個別の規約も確認してください。

## ライセンス

サイトのソースコードは [MIT License](LICENSE) です。PDF、台本、画像、VOICEVOX生成音声など、読み込ませる教材素材の権利は別途確認してください。
