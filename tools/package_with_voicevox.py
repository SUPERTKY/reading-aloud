#!/usr/bin/env python3
"""Build a browser-ready workbook ZIP, optionally synthesizing VOICEVOX WAV files."""

from __future__ import annotations

import argparse
import copy
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


def request_json(url: str, *, method: str = "GET", body: object | None = None) -> object:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as error:
        raise RuntimeError(f"VOICEVOX Engineへ接続できません: {url}\n{error}") from error


def request_bytes(url: str, *, body: object) -> bytes:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.read()
    except urllib.error.URLError as error:
        raise RuntimeError(f"VOICEVOX Engineで音声を生成できません: {url}\n{error}") from error


def engine_url(base: str, path: str, **query: object) -> str:
    return f"{base.rstrip('/')}{path}?{urllib.parse.urlencode(query)}"


def speaker_map(engine: str) -> dict[int, str]:
    speakers = request_json(f"{engine.rstrip('/')}/speakers")
    result: dict[int, str] = {}
    for speaker in speakers:
        for style in speaker.get("styles", []):
            result[int(style["id"])] = f'{speaker["name"]}（{style["name"]}）'
    return result


def list_speakers(args: argparse.Namespace) -> None:
    for style_id, name in sorted(speaker_map(args.engine).items()):
        print(f"{style_id:>4}  {name}")


def safe_zip_path(value: str) -> str:
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"安全でないZIP内パスです: {value}")
    return path.as_posix()


def validate_manifest(manifest: object) -> dict:
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise ValueError("script.json の version は 1 にしてください。")
    if not isinstance(manifest.get("title"), str) or not manifest["title"].strip():
        raise ValueError("script.json に title が必要です。")
    pages = manifest.get("pages")
    if not isinstance(pages, list):
        raise ValueError("script.json の pages は配列にしてください。")
    seen: set[int] = set()
    for page in pages:
        number = page.get("page") if isinstance(page, dict) else None
        if not isinstance(number, int) or number < 1 or number in seen:
            raise ValueError("page は重複しない1以上の整数にしてください。")
        seen.add(number)
        if not isinstance(page.get("cues"), list):
            raise ValueError(f"page {number} の cues は配列にしてください。")
        for cue in page["cues"]:
            if not isinstance(cue, dict) or cue.get("type") not in {"speak", "wait"}:
                raise ValueError(f"page {number} に不正な cue があります。")
            if cue["type"] == "speak" and not cue.get("text"):
                raise ValueError(f"page {number} の speak に text が必要です。")
    return manifest


def build(args: argparse.Namespace) -> None:
    pdf_path = args.pdf.resolve()
    script_path = args.script.resolve()
    if not pdf_path.is_file() or pdf_path.suffix.lower() != ".pdf":
        raise ValueError("--pdf には存在するPDFファイルを指定してください。")
    if not script_path.is_file():
        raise ValueError("--script のJSONファイルが見つかりません。")

    manifest = validate_manifest(json.loads(script_path.read_text(encoding="utf-8")))
    manifest = copy.deepcopy(manifest)
    manifest["pdf"] = pdf_path.name
    generated: dict[str, bytes] = {}

    if args.browser_voice:
        manifest["voiceCredit"] = args.credit or "音声: ブラウザ内蔵音声"
        for page in manifest["pages"]:
            for cue in page["cues"]:
                cue.pop("audio", None)
    else:
        speakers = speaker_map(args.engine)
        if args.speaker not in speakers:
            raise ValueError(f"speaker {args.speaker} が見つかりません。list-speakers で確認してください。")
        speaker_name = speakers[args.speaker].split("（", 1)[0]
        manifest["voiceCredit"] = args.credit or f"VOICEVOX:{speaker_name}"
        speak_count = sum(cue.get("type") == "speak" for page in manifest["pages"] for cue in page["cues"])
        current = 0
        for page in manifest["pages"]:
            for cue_number, cue in enumerate(page["cues"], start=1):
                if cue["type"] != "speak":
                    continue
                current += 1
                print(f"[{current}/{speak_count}] page {page['page']} cue {cue_number}", flush=True)
                query = request_json(
                    engine_url(args.engine, "/audio_query", text=cue["text"], speaker=args.speaker),
                    method="POST",
                )
                query["speedScale"] = args.speed_scale
                query["volumeScale"] = args.volume_scale
                wav = request_bytes(
                    engine_url(args.engine, "/synthesis", speaker=args.speaker),
                    body=query,
                )
                audio_path = f"audio/page-{page['page']:03d}-cue-{cue_number:03d}.wav"
                cue["audio"] = audio_path
                generated[audio_path] = wav

    output = args.out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.write(pdf_path, safe_zip_path(pdf_path.name))
        archive.writestr("script.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for path, wav in generated.items():
            archive.writestr(safe_zip_path(path), wav)
    print(f"作成しました: {output}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="PDFワーク教材ZIPを作成します。")
    subcommands = root.add_subparsers(dest="command", required=True)

    listing = subcommands.add_parser("list-speakers", help="VOICEVOXの話者IDを一覧表示")
    listing.add_argument("--engine", default="http://127.0.0.1:50021")
    listing.set_defaults(handler=list_speakers)

    builder = subcommands.add_parser("build", help="教材ZIPを作成")
    builder.add_argument("--pdf", type=Path, required=True)
    builder.add_argument("--script", type=Path, required=True)
    builder.add_argument("--out", type=Path, required=True)
    voice = builder.add_mutually_exclusive_group(required=True)
    voice.add_argument("--speaker", type=int, help="VOICEVOXのスタイルID")
    voice.add_argument("--browser-voice", action="store_true", help="WAVを作らずブラウザ音声を使用")
    builder.add_argument("--engine", default="http://127.0.0.1:50021")
    builder.add_argument("--speed-scale", type=float, default=1.0)
    builder.add_argument("--volume-scale", type=float, default=1.0)
    builder.add_argument("--credit", help="表示するクレジット。例: VOICEVOX:四国めたん")
    builder.set_defaults(handler=build)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        args.handler(args)
        return 0
    except (ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
