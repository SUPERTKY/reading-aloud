# 音声つきPDFワークプレイヤー

PDFワークを1ページずつ大きく表示し、音声の再生・一時停止・停止と、無期限の「記入待ち」を行えるGitHub Pages向けサイトです。PDFのページは利用者が操作したときだけ切り替わり、音声終了時には自動で進みません。

## できること

- ZIPをドラッグ＆ドロップして、PDF・台本・音声をブラウザ内だけで読み込み
- 1ページを画面いっぱいに表示。全体表示、幅合わせ、拡大縮小、全画面
- ページ番号を常時表示し、矢印・ページ番号入力・キーボードで手動移動
- 読み上げ、一時停止、再開、停止
- `wait` の位置で時間制限なく待機し、「書き終わったら続ける」で再開
- 台本で指定されたPDF上の回答欄へ直接入力
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
      ],
      "fields": [
        {
          "id": "page-01-answer",
          "type": "single-line",
          "label": "一行の回答",
          "x": 10,
          "y": 70,
          "width": 80,
          "height": 4,
          "maxLength": 60
        }
      ]
    }
  ]
}
```

完全な例は `examples/horror-workbook-script.json`、JSON Schemaは `examples/script.schema.json` にあります。

## 回答欄をスクリプトで配置する

各ページの `fields` に、PDFページ全体を100とした割合で位置と大きさを指定します。利用者は指定欄だけに入力でき、自由な位置へ欄を追加・移動・削除する機能はありません。

| 項目 | 内容 |
|---|---|
| `id` | ページ内で重複しない回答欄ID |
| `type` | `single-line` は改行不可、`multiline` は改行可 |
| `x`, `y` | 左上の位置（0〜100%） |
| `width`, `height` | 欄の大きさ（0〜100%） |
| `label` | 読み上げ支援用の欄名 |
| `placeholder` | 未入力時に表示する案内 |
| `maxLength` | 任意の最大文字数 |

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
| PDF上の入力欄 | 台本で指定された場所へ回答を入力 |
| 「回答を保存」 | 全ページの回答をJSONで保存 |

## VOICEVOX利用時の注意

- サイトや教材ZIPにはVOICEVOX本体・Engineを同梱せず、手元で生成した音声ファイルだけを使います。
- `voiceCredit` に `VOICEVOX:キャラクター名` など、利用した音声ライブラリの条件に合うクレジットを記載します。プレイヤー画面下部に常時表示されます。
- VOICEVOX全体の規約だけでなく、選んだキャラクター／音声ライブラリ個別の規約も確認してください。

## ライセンス

サイトのソースコードは [MIT License](LICENSE) です。PDF、台本、画像、VOICEVOX生成音声など、読み込ませる教材素材の権利は別途確認してください。
