import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./styles.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const STORAGE_PREFIX = "voice-workbook-player:answers:";

const $ = (id) => document.getElementById(id);
const els = {
  dropScreen: $("dropScreen"),
  dropZone: $("dropZone"),
  zipInput: $("zipInput"),
  loadError: $("loadError"),
  player: $("player"),
  changeZipBtn: $("changeZipBtn"),
  workTitle: $("workTitle"),
  currentPageTop: $("currentPageTop"),
  totalPagesTop: $("totalPagesTop"),
  totalPagesBottom: $("totalPagesBottom"),
  pageInput: $("pageInput"),
  pdfStage: $("pdfStage"),
  pageWrap: $("pageWrap"),
  pdfCanvas: $("pdfCanvas"),
  annotationLayer: $("annotationLayer"),
  renderSpinner: $("renderSpinner"),
  prevPageBtn: $("prevPageBtn"),
  nextPageBtn: $("nextPageBtn"),
  prevPageBottomBtn: $("prevPageBottomBtn"),
  nextPageBottomBtn: $("nextPageBottomBtn"),
  fitPageBtn: $("fitPageBtn"),
  fitWidthBtn: $("fitWidthBtn"),
  zoomOutBtn: $("zoomOutBtn"),
  zoomInBtn: $("zoomInBtn"),
  zoomLabel: $("zoomLabel"),
  writeModeBtn: $("writeModeBtn"),
  exportAnswersBtn: $("exportAnswersBtn"),
  fullscreenBtn: $("fullscreenBtn"),
  playPauseBtn: $("playPauseBtn"),
  stopBtn: $("stopBtn"),
  continueBtn: $("continueBtn"),
  narrationState: $("narrationState"),
  narrationCaption: $("narrationCaption"),
  voiceCredit: $("voiceCredit"),
};

const state = {
  zip: null,
  zipPrefix: "",
  manifest: null,
  pdf: null,
  currentPage: 1,
  fitMode: "width",
  zoom: 1,
  renderTask: null,
  renderSerial: 0,
  writeMode: false,
  answers: { pages: {} },
  answerStorageKey: "",
  resizeObservers: [],
  audioUrls: new Map(),
  activeAudio: null,
  activeAudioResolve: null,
  activeUtterance: null,
  cueIndex: 0,
  playbackMode: "idle", // idle | playing | paused | waiting | done
  playbackToken: 0,
};

function makeToast() {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.hidden = true;
  document.body.append(toast);
  return toast;
}
const toast = makeToast();
let toastTimer = 0;

function notify(message, kind = "info") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4200);
}

function normalizePath(path) {
  if (typeof path !== "string" || !path.trim()) throw new Error("ZIP内のファイルパスが空です。");
  const cleaned = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/") || cleaned.split("/").some((part) => part === "..")) {
    throw new Error(`安全でないZIP内パスです: ${path}`);
  }
  return cleaned;
}

function zipEntry(path) {
  const normalized = normalizePath(path);
  const entry = state.zip?.file(`${state.zipPrefix}${normalized}`);
  if (!entry) throw new Error(`ZIP内に「${normalized}」が見つかりません。`);
  return entry;
}

function pageDefinition(pageNumber = state.currentPage) {
  return state.manifest?.pages?.find((page) => Number(page.page) === pageNumber) ?? { page: pageNumber, cues: [] };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("script.json がJSONオブジェクトではありません。");
  if (manifest.version !== 1) throw new Error("script.json の version は 1 にしてください。");
  if (!manifest.title || typeof manifest.title !== "string") throw new Error("script.json に title が必要です。");
  normalizePath(manifest.pdf);
  if (!Array.isArray(manifest.pages)) throw new Error("script.json の pages は配列にしてください。");
  const seen = new Set();
  for (const page of manifest.pages) {
    if (!Number.isInteger(page.page) || page.page < 1) throw new Error("各 page は1以上の整数にしてください。");
    if (seen.has(page.page)) throw new Error(`page ${page.page} が重複しています。`);
    seen.add(page.page);
    if (!Array.isArray(page.cues)) throw new Error(`page ${page.page} の cues は配列にしてください。`);
    for (const cue of page.cues) {
      if (!['speak', 'wait'].includes(cue.type)) throw new Error(`page ${page.page} に不明な cue type があります。`);
      if (cue.type === "speak" && !cue.text && !cue.audio) throw new Error(`page ${page.page} の speak には text または audio が必要です。`);
      if (cue.audio) normalizePath(cue.audio);
    }
  }
}

async function loadPackage(file) {
  if (!file) return;
  els.loadError.hidden = true;
  if (file.size > MAX_ZIP_BYTES) {
    showLoadError("ZIPは500MB以下にしてください。音声をMP3へ変換すると小さくできます。");
    return;
  }
  try {
    els.dropZone.classList.add("loading");
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    if (names.length > MAX_ENTRIES) throw new Error("ZIP内のファイル数が多すぎます（上限2000）。");
    const scripts = names.filter((name) => name === "script.json" || name.endsWith("/script.json"));
    if (scripts.length !== 1) throw new Error("ZIP内には script.json を1つだけ入れてください。");
    const scriptName = scripts[0];
    const prefix = scriptName.slice(0, -"script.json".length);
    const scriptText = await zip.file(scriptName).async("string");
    if (scriptText.length > 2_000_000) throw new Error("script.json が大きすぎます。");
    const manifest = JSON.parse(scriptText);
    validateManifest(manifest);

    unloadCurrentPackage();
    state.zip = zip;
    state.zipPrefix = prefix;
    state.manifest = manifest;
    const pdfData = await zipEntry(manifest.pdf).async("uint8array");
    state.pdf = await getDocument({ data: pdfData }).promise;
    const outOfRange = manifest.pages.find((page) => page.page > state.pdf.numPages);
    if (outOfRange) throw new Error(`script.json の page ${outOfRange.page} はPDFのページ数を超えています。`);

    state.answerStorageKey = STORAGE_PREFIX + (manifest.id || manifest.title);
    state.answers = loadAnswers();
    const savedPage = Number(localStorage.getItem(`${state.answerStorageKey}:last-page`));
    state.currentPage = savedPage >= 1 && savedPage <= state.pdf.numPages ? savedPage : 1;
    state.cueIndex = 0;

    els.workTitle.textContent = manifest.title;
    els.voiceCredit.textContent = manifest.voiceCredit || "音声: ブラウザ内蔵音声（音声ファイル未収録時）";
    els.dropScreen.hidden = true;
    els.player.hidden = false;
    updatePageUI();
    await renderCurrentPage();
    els.pdfStage.scrollTo({ top: 0, left: 0 });

    const hasAudio = manifest.pages.some((p) => p.cues.some((cue) => cue.audio));
    if (hasAudio && !manifest.voiceCredit) {
      notify("音声ファイルがあります。script.json に voiceCredit を記載してください。", "warning");
    }
  } catch (error) {
    console.error(error);
    showLoadError(error instanceof Error ? error.message : "ZIPを読み込めませんでした。");
  } finally {
    els.dropZone.classList.remove("loading");
    els.zipInput.value = "";
  }
}

function showLoadError(message) {
  els.loadError.textContent = message;
  els.loadError.hidden = false;
}

function unloadCurrentPackage() {
  stopNarration(true);
  for (const url of state.audioUrls.values()) URL.revokeObjectURL(url);
  state.audioUrls.clear();
  state.pdf?.destroy?.();
  state.zip = null;
  state.manifest = null;
  state.pdf = null;
}

function loadAnswers() {
  try {
    const saved = JSON.parse(localStorage.getItem(state.answerStorageKey));
    if (saved?.pages && typeof saved.pages === "object") return saved;
  } catch (error) {
    console.warn("Saved answers could not be read", error);
  }
  return { version: 1, workbookId: state.manifest.id || state.manifest.title, title: state.manifest.title, pages: {} };
}

function persistAnswers() {
  try {
    localStorage.setItem(state.answerStorageKey, JSON.stringify(state.answers));
  } catch {
    notify("回答の自動保存容量を超えました。『回答を保存』でJSONを書き出してください。", "warning");
  }
}

function currentNotes() {
  const key = String(state.currentPage);
  state.answers.pages[key] ||= [];
  return state.answers.pages[key];
}

async function renderCurrentPage() {
  if (!state.pdf) return;
  const serial = ++state.renderSerial;
  els.renderSpinner.hidden = false;
  try {
    state.renderTask?.cancel?.();
    const page = await state.pdf.getPage(state.currentPage);
    const base = page.getViewport({ scale: 1 });
    const stageWidth = Math.max(240, els.pdfStage.clientWidth - 36);
    const stageHeight = Math.max(240, els.pdfStage.clientHeight - 36);
    const fitScale = state.fitMode === "width"
      ? stageWidth / base.width
      : Math.min(stageWidth / base.width, stageHeight / base.height);
    const scale = Math.max(0.25, fitScale * state.zoom);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = els.pdfCanvas;
    const context = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    els.pageWrap.style.width = `${viewport.width}px`;
    els.pageWrap.style.height = `${viewport.height}px`;
    els.annotationLayer.style.width = `${viewport.width}px`;
    els.annotationLayer.style.height = `${viewport.height}px`;
    state.renderTask = page.render({ canvasContext: context, viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] });
    await state.renderTask.promise;
    if (serial !== state.renderSerial) return;
    renderAnnotations();
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      console.error(error);
      notify("PDFページの描画に失敗しました。", "error");
    }
  } finally {
    if (serial === state.renderSerial) els.renderSpinner.hidden = true;
  }
}

function updatePageUI() {
  if (!state.pdf) return;
  const total = state.pdf.numPages;
  els.currentPageTop.textContent = state.currentPage;
  els.totalPagesTop.textContent = total;
  els.totalPagesBottom.textContent = total;
  els.pageInput.max = total;
  els.pageInput.value = state.currentPage;
  const atStart = state.currentPage === 1;
  const atEnd = state.currentPage === total;
  for (const el of [els.prevPageBtn, els.prevPageBottomBtn]) el.disabled = atStart;
  for (const el of [els.nextPageBtn, els.nextPageBottomBtn]) el.disabled = atEnd;
  els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  els.fitPageBtn.classList.toggle("active", state.fitMode === "page");
  els.fitWidthBtn.classList.toggle("active", state.fitMode === "width");
  els.fitPageBtn.setAttribute("aria-pressed", String(state.fitMode === "page"));
  els.fitWidthBtn.setAttribute("aria-pressed", String(state.fitMode === "width"));
  els.pdfStage.classList.toggle("fit-width", state.fitMode === "width");
  const cues = pageDefinition().cues;
  els.narrationCaption.textContent = cues.length ? `このページには ${cues.length} 個の読み上げ・待機指示があります。` : "このページには読み上げ指示がありません。";
  updatePlaybackUI();
}

async function goToPage(pageNumber) {
  if (!state.pdf) return;
  const next = Math.max(1, Math.min(state.pdf.numPages, Number(pageNumber) || 1));
  if (next === state.currentPage) return;
  stopNarration(true);
  state.currentPage = next;
  localStorage.setItem(`${state.answerStorageKey}:last-page`, String(next));
  updatePageUI();
  await renderCurrentPage();
  els.pdfStage.scrollTo({ top: 0, left: 0 });
}

async function setFitMode(mode) {
  state.fitMode = mode;
  state.zoom = 1;
  updatePageUI();
  await renderCurrentPage();
  els.pdfStage.scrollTo({ top: 0, left: 0 });
}

function changeZoom(delta) {
  state.zoom = Math.max(0.5, Math.min(2.5, Number((state.zoom + delta).toFixed(2))));
  updatePageUI();
  renderCurrentPage();
}

function setWriteMode(enabled) {
  state.writeMode = enabled;
  els.writeModeBtn.setAttribute("aria-pressed", String(enabled));
  els.writeModeBtn.textContent = enabled ? "✓ 書き込み中" : "✎ 書き込む";
  els.annotationLayer.classList.toggle("write-mode", enabled);
  if (enabled) notify("PDFの書きたい場所をクリックすると入力欄を置けます。", "info");
}

function renderAnnotations() {
  for (const observer of state.resizeObservers) observer.disconnect();
  state.resizeObservers = [];
  els.annotationLayer.replaceChildren();
  for (const note of currentNotes()) mountNote(note);
  els.annotationLayer.classList.toggle("write-mode", state.writeMode);
}

function createNoteAt(clientX, clientY) {
  const rect = els.annotationLayer.getBoundingClientRect();
  const x = Math.max(0, Math.min(82, ((clientX - rect.left) / rect.width) * 100));
  const y = Math.max(0, Math.min(90, ((clientY - rect.top) / rect.height) * 100));
  const note = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    x, y, w: 34, h: 9, text: "",
  };
  currentNotes().push(note);
  persistAnswers();
  const textarea = mountNote(note);
  textarea.focus();
}

function mountNote(note) {
  const shell = document.createElement("div");
  shell.className = "note-shell";
  shell.dataset.noteId = note.id;
  Object.assign(shell.style, {
    left: `${note.x}%`, top: `${note.y}%`, width: `${note.w}%`, height: `${note.h}%`,
  });

  const toolbar = document.createElement("div");
  toolbar.className = "note-toolbar";
  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "移動";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete-note";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "この入力欄を削除");
  toolbar.append(handle, remove);

  const textarea = document.createElement("textarea");
  textarea.className = "note-text";
  textarea.value = note.text || "";
  textarea.placeholder = "回答を入力";
  textarea.setAttribute("aria-label", `ページ${state.currentPage}の回答`);
  shell.append(toolbar, textarea);
  els.annotationLayer.append(shell);

  textarea.addEventListener("input", () => { note.text = textarea.value; persistAnswers(); });
  remove.addEventListener("click", () => {
    const notes = currentNotes();
    const index = notes.findIndex((item) => item.id === note.id);
    if (index >= 0) notes.splice(index, 1);
    persistAnswers();
    shell.remove();
  });

  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const rect = els.annotationLayer.getBoundingClientRect();
    drag = { startX: event.clientX, startY: event.clientY, x: note.x, y: note.y, rect };
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    note.x = Math.max(0, Math.min(100 - note.w, drag.x + ((event.clientX - drag.startX) / drag.rect.width) * 100));
    note.y = Math.max(0, Math.min(100 - note.h, drag.y + ((event.clientY - drag.startY) / drag.rect.height) * 100));
    shell.style.left = `${note.x}%`;
    shell.style.top = `${note.y}%`;
  });
  handle.addEventListener("pointerup", () => { drag = null; persistAnswers(); });
  handle.addEventListener("pointercancel", () => { drag = null; persistAnswers(); });

  const observer = new ResizeObserver(() => {
    const layerRect = els.annotationLayer.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    if (!layerRect.width || !layerRect.height) return;
    note.w = Math.min(100 - note.x, (shellRect.width / layerRect.width) * 100);
    note.h = Math.min(100 - note.y, (shellRect.height / layerRect.height) * 100);
    persistAnswers();
  });
  observer.observe(shell);
  state.resizeObservers.push(observer);
  return textarea;
}

function exportAnswers() {
  if (!state.manifest) return;
  const output = {
    ...state.answers,
    exportedAt: new Date().toISOString(),
  };
  downloadBlob(
    new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }),
    `${safeFilename(state.manifest.title)}-answers.json`,
  );
  notify("回答JSONを保存しました。ブラウザ内にも引き続き自動保存されます。", "info");
}

function safeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "workbook";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function updatePlaybackUI() {
  const mode = state.playbackMode;
  const labels = {
    idle: "停止中", playing: "読み上げ中", paused: "一時停止", waiting: "ワーク待機中", done: "このページは完了",
  };
  els.narrationState.textContent = labels[mode];
  els.narrationState.className = `state-pill ${mode}`;
  els.continueBtn.hidden = mode !== "waiting";
  els.playPauseBtn.disabled = mode === "waiting" || pageDefinition().cues.length === 0;
  els.stopBtn.disabled = mode === "idle";
  if (mode === "playing") els.playPauseBtn.textContent = "⏸ 一時停止";
  else if (mode === "paused") els.playPauseBtn.textContent = "▶ 再開";
  else if (mode === "done") els.playPauseBtn.textContent = "↺ もう一度";
  else els.playPauseBtn.textContent = "▶ 読み上げる";
}

async function togglePlayback() {
  if (state.playbackMode === "playing") {
    pauseNarration();
    return;
  }
  if (state.playbackMode === "paused") {
    state.playbackMode = "playing";
    if (state.activeAudio) await state.activeAudio.play();
    else if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    updatePlaybackUI();
    return;
  }
  if (state.playbackMode === "done") state.cueIndex = 0;
  const token = ++state.playbackToken;
  runCues(token);
}

function pauseNarration() {
  state.activeAudio?.pause();
  if (state.activeUtterance) window.speechSynthesis.pause();
  state.playbackMode = "paused";
  updatePlaybackUI();
}

function stopNarration(resetCue = true) {
  state.playbackToken += 1;
  if (state.activeAudio) {
    state.activeAudio.pause();
    state.activeAudio.currentTime = 0;
    state.activeAudio = null;
  }
  state.activeAudioResolve?.();
  state.activeAudioResolve = null;
  if (state.activeUtterance) {
    window.speechSynthesis.cancel();
    state.activeUtterance = null;
  }
  if (resetCue) state.cueIndex = 0;
  state.playbackMode = "idle";
  if (state.manifest) {
    els.narrationCaption.textContent = pageDefinition().cues.length ? "停止しました。再生するとページの最初から始まります。" : "このページには読み上げ指示がありません。";
    updatePlaybackUI();
  }
}

async function continueAfterWait() {
  if (state.playbackMode !== "waiting") return;
  state.cueIndex += 1;
  const token = ++state.playbackToken;
  runCues(token);
}

async function runCues(token) {
  const cues = pageDefinition().cues;
  state.playbackMode = "playing";
  updatePlaybackUI();
  while (state.cueIndex < cues.length && token === state.playbackToken) {
    const cue = cues[state.cueIndex];
    if (cue.type === "wait") {
      state.playbackMode = "waiting";
      els.narrationCaption.textContent = cue.label || "ここでワークを書きます。終わったら続けてください。";
      updatePlaybackUI();
      return;
    }
    els.narrationCaption.textContent = cue.caption || cue.text || "音声を再生しています。";
    try {
      await playSpeakCue(cue, token);
    } catch (error) {
      if (token !== state.playbackToken) return;
      console.error(error);
      notify("音声を再生できませんでした。", "error");
      state.playbackMode = "paused";
      updatePlaybackUI();
      return;
    }
    if (token !== state.playbackToken) return;
    state.cueIndex += 1;
  }
  if (token !== state.playbackToken) return;
  state.activeAudio = null;
  state.activeUtterance = null;
  state.playbackMode = "done";
  els.narrationCaption.textContent = "このページの読み上げは完了しました。ページは自動では切り替わりません。";
  updatePlaybackUI();
}

async function playSpeakCue(cue, token) {
  if (cue.audio) {
    try {
      const path = normalizePath(cue.audio);
      let url = state.audioUrls.get(path);
      if (!url) {
        const blob = await zipEntry(path).async("blob");
        url = URL.createObjectURL(blob);
        state.audioUrls.set(path, url);
      }
      if (token !== state.playbackToken) return;
      await playAudioUrl(url, token);
      return;
    } catch (error) {
      if (!cue.text) throw error;
      notify("音声ファイルが見つからないため、ブラウザ音声で読みます。", "warning");
    }
  }
  if (!cue.text) throw new Error("読み上げるテキストがありません。");
  await speakInBrowser(cue.text, cue, token);
}

function playAudioUrl(url, token) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    state.activeAudio = audio;
    const finish = () => {
      if (state.activeAudio === audio) state.activeAudio = null;
      if (state.activeAudioResolve === finish) state.activeAudioResolve = null;
      resolve();
    };
    state.activeAudioResolve = finish;
    audio.onended = finish;
    audio.onerror = () => {
      if (state.activeAudioResolve === finish) state.activeAudioResolve = null;
      reject(new Error("Audio playback failed"));
    };
    if (token !== state.playbackToken) return resolve();
    audio.play().catch(reject);
  });
}

function speakInBrowser(text, cue, token) {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) return reject(new Error("Speech synthesis is unavailable"));
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = cue.lang || "ja-JP";
    utterance.rate = Number(cue.rate) || 0.92;
    utterance.pitch = Number(cue.pitch) || 1;
    utterance.onend = () => { if (state.activeUtterance === utterance) state.activeUtterance = null; resolve(); };
    utterance.onerror = (event) => event.error === "canceled" ? resolve() : reject(new Error(event.error));
    state.activeUtterance = utterance;
    if (token !== state.playbackToken) return resolve();
    window.speechSynthesis.speak(utterance);
  });
}

function bindEvents() {
  els.zipInput.addEventListener("change", (event) => loadPackage(event.target.files?.[0]));
  for (const type of ["dragenter", "dragover"]) {
    els.dropZone.addEventListener(type, (event) => { event.preventDefault(); els.dropZone.classList.add("dragover"); });
  }
  for (const type of ["dragleave", "drop"]) {
    els.dropZone.addEventListener(type, (event) => { event.preventDefault(); els.dropZone.classList.remove("dragover"); });
  }
  els.dropZone.addEventListener("drop", (event) => loadPackage(event.dataTransfer?.files?.[0]));
  els.changeZipBtn.addEventListener("click", () => {
    unloadCurrentPackage();
    els.player.hidden = true;
    els.dropScreen.hidden = false;
  });
  els.prevPageBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
  els.prevPageBottomBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
  els.nextPageBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
  els.nextPageBottomBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
  els.pageInput.addEventListener("change", () => goToPage(els.pageInput.value));
  els.pageInput.addEventListener("keydown", (event) => { if (event.key === "Enter") goToPage(els.pageInput.value); });
  els.fitPageBtn.addEventListener("click", () => setFitMode("page"));
  els.fitWidthBtn.addEventListener("click", () => setFitMode("width"));
  els.zoomOutBtn.addEventListener("click", () => changeZoom(-0.1));
  els.zoomInBtn.addEventListener("click", () => changeZoom(0.1));
  els.writeModeBtn.addEventListener("click", () => setWriteMode(!state.writeMode));
  els.annotationLayer.addEventListener("click", (event) => {
    if (state.writeMode && event.target === els.annotationLayer) createNoteAt(event.clientX, event.clientY);
  });
  els.exportAnswersBtn.addEventListener("click", exportAnswers);
  els.fullscreenBtn.addEventListener("click", async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.player.requestFullscreen();
  });
  els.playPauseBtn.addEventListener("click", togglePlayback);
  els.stopBtn.addEventListener("click", () => stopNarration(true));
  els.continueBtn.addEventListener("click", continueAfterWait);
  window.addEventListener("resize", debounce(() => renderCurrentPage(), 180));
  window.addEventListener("beforeunload", () => { stopNarration(false); persistAnswers(); });
  document.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName?.toLowerCase();
    if (["input", "textarea", "button"].includes(tag)) return;
    if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
    if (event.key === "ArrowLeft") goToPage(state.currentPage - 1);
    if (event.key === "ArrowRight") goToPage(state.currentPage + 1);
  });
}

function debounce(fn, wait) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

bindEvents();
