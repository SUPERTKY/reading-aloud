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
  responseLayer: $("responseLayer"),
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
  compositionBtn: $("compositionBtn"),
  compositionPanel: $("compositionPanel"),
  compositionPrompt: $("compositionPrompt"),
  compositionTitleInput: $("compositionTitleInput"),
  compositionTextInput: $("compositionTextInput"),
  compositionCharacterCount: $("compositionCharacterCount"),
  saveCompositionTextBtn: $("saveCompositionTextBtn"),
  closeCompositionBtn: $("closeCompositionBtn"),
  fieldEditorBtn: $("fieldEditorBtn"),
  fieldEditorPanel: $("fieldEditorPanel"),
  singleLineFieldBtn: $("singleLineFieldBtn"),
  multilineFieldBtn: $("multilineFieldBtn"),
  deleteFieldBtn: $("deleteFieldBtn"),
  clearPageFieldsBtn: $("clearPageFieldsBtn"),
  fieldEditorStatus: $("fieldEditorStatus"),
  exportPackageBtn: $("exportPackageBtn"),
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
  originalZipName: "workbook.zip",
  manifest: null,
  pdf: null,
  currentPage: 1,
  fitMode: "width",
  zoom: 1,
  renderTask: null,
  renderSerial: 0,
  answers: { pages: {} },
  answerStorageKey: "",
  audioUrls: new Map(),
  activeAudio: null,
  activeAudioResolve: null,
  activeUtterance: null,
  cueIndex: 0,
  playbackMode: "idle", // idle | playing | paused | waiting | done
  playbackToken: 0,
  fieldEditor: false,
  fieldType: "single-line",
  selectedFieldId: null,
  fieldInteraction: null,
  layoutDirty: false,
  compositionOpen: false,
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
  return state.manifest?.pages?.find((page) => Number(page.page) === pageNumber) ?? { page: pageNumber, cues: [], fields: [] };
}

function editablePageDefinition(pageNumber = state.currentPage) {
  let page = state.manifest.pages.find((item) => Number(item.page) === pageNumber);
  if (!page) {
    page = { page: pageNumber, cues: [], fields: [] };
    state.manifest.pages.push(page);
    state.manifest.pages.sort((a, b) => a.page - b.page);
  }
  if (!Array.isArray(page.fields)) page.fields = [];
  return page;
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
      if (cue.reading !== undefined && (typeof cue.reading !== "string" || !cue.reading.trim())) {
        throw new Error(`page ${page.page} の reading は空でない文字列にしてください。`);
      }
      if (cue.audio) normalizePath(cue.audio);
    }
    if (page.fields !== undefined && !Array.isArray(page.fields)) {
      throw new Error(`page ${page.page} の fields は配列にしてください。`);
    }
    if (page.composition !== undefined) {
      if (!page.composition || typeof page.composition !== "object" || Array.isArray(page.composition)) {
        throw new Error(`page ${page.page} の composition はオブジェクトにしてください。`);
      }
      for (const key of ["prompt", "titlePlaceholder", "bodyPlaceholder", "filename"]) {
        if (page.composition[key] !== undefined && typeof page.composition[key] !== "string") {
          throw new Error(`page ${page.page} の composition.${key} は文字列にしてください。`);
        }
      }
      if (page.composition.maxLength !== undefined && (!Number.isInteger(page.composition.maxLength) || page.composition.maxLength < 1)) {
        throw new Error(`page ${page.page} の composition.maxLength が不正です。`);
      }
    }
    const fieldIds = new Set();
    for (const field of page.fields || []) {
      if (!field.id || typeof field.id !== "string") throw new Error(`page ${page.page} の入力欄に id が必要です。`);
      if (fieldIds.has(field.id)) throw new Error(`page ${page.page} の field id「${field.id}」が重複しています。`);
      fieldIds.add(field.id);
      if (!["single-line", "multiline"].includes(field.type)) throw new Error(`page ${page.page} の field type が不正です。`);
      for (const key of ["x", "y", "width", "height"]) {
        if (!Number.isFinite(field[key])) throw new Error(`page ${page.page} の field「${field.id}」に ${key} が必要です。`);
      }
      if (field.x < 0 || field.y < 0 || field.width <= 0 || field.height <= 0 || field.x + field.width > 100 || field.y + field.height > 100) {
        throw new Error(`page ${page.page} の field「${field.id}」がページ範囲外です。`);
      }
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1)) {
        throw new Error(`page ${page.page} の field「${field.id}」の maxLength が不正です。`);
      }
      if (field.fontScale !== undefined && (!Number.isFinite(field.fontScale) || field.fontScale <= 0)) {
        throw new Error(`page ${page.page} の field「${field.id}」の fontScale が不正です。`);
      }
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
    state.originalZipName = file.name || "workbook.zip";
    state.manifest = manifest;
    state.layoutDirty = false;
    state.fieldEditor = false;
    state.selectedFieldId = null;
    state.fieldInteraction = null;
    state.compositionOpen = false;
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
  state.fieldEditor = false;
  state.selectedFieldId = null;
  state.fieldInteraction = null;
  state.layoutDirty = false;
  state.compositionOpen = false;
  els.fieldEditorPanel.hidden = true;
  els.fieldEditorBtn.setAttribute("aria-pressed", "false");
  els.fieldEditorBtn.textContent = "▣ 入力欄を配置";
  els.compositionPanel.hidden = true;
  els.compositionBtn.hidden = true;
  els.compositionBtn.setAttribute("aria-pressed", "false");
}

function loadAnswers() {
  try {
    const saved = JSON.parse(localStorage.getItem(state.answerStorageKey));
    if (saved?.pages && typeof saved.pages === "object") return saved;
  } catch (error) {
    console.warn("Saved answers could not be read", error);
  }
  return { version: 2, workbookId: state.manifest.id || state.manifest.title, title: state.manifest.title, pages: {}, compositions: {} };
}

function persistAnswers() {
  try {
    localStorage.setItem(state.answerStorageKey, JSON.stringify(state.answers));
  } catch {
    notify("回答の自動保存容量を超えました。『回答を保存』でJSONを書き出してください。", "warning");
  }
}

function currentPageAnswers() {
  const key = String(state.currentPage);
  if (!state.answers.pages[key] || Array.isArray(state.answers.pages[key])) state.answers.pages[key] = {};
  return state.answers.pages[key];
}

function currentComposition() {
  if (!state.answers.compositions || typeof state.answers.compositions !== "object" || Array.isArray(state.answers.compositions)) {
    state.answers.compositions = {};
  }
  const key = String(state.currentPage);
  if (!state.answers.compositions[key] || typeof state.answers.compositions[key] !== "object") {
    state.answers.compositions[key] = { title: "", text: "" };
  }
  return state.answers.compositions[key];
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
    els.responseLayer.style.width = `${viewport.width}px`;
    els.responseLayer.style.height = `${viewport.height}px`;
    state.renderTask = page.render({ canvasContext: context, viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] });
    await state.renderTask.promise;
    if (serial !== state.renderSerial) return;
    renderResponseFields();
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
  updateFieldEditorUI();
  updateCompositionAvailability();
}

async function goToPage(pageNumber) {
  if (!state.pdf) return;
  const next = Math.max(1, Math.min(state.pdf.numPages, Number(pageNumber) || 1));
  if (next === state.currentPage) return;
  if (state.compositionOpen) closeComposition();
  stopNarration(true);
  state.selectedFieldId = null;
  state.fieldInteraction = null;
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

function renderResponseFields() {
  els.responseLayer.replaceChildren();
  els.responseLayer.classList.toggle("editor-active", state.fieldEditor);
  const answers = currentPageAnswers();
  for (const field of pageDefinition().fields || []) {
    const shell = document.createElement("div");
    shell.className = `response-field-shell ${field.type}`;
    shell.dataset.fieldId = field.id;
    shell.classList.toggle("selected", state.fieldEditor && state.selectedFieldId === field.id);
    Object.assign(shell.style, {
      left: `${field.x}%`,
      top: `${field.y}%`,
      width: `${field.width}%`,
      height: `${field.height}%`,
    });

    const control = document.createElement(field.type === "single-line" ? "input" : "textarea");
    if (control instanceof HTMLInputElement) control.type = "text";
    control.className = `response-field ${field.type}`;
    control.value = answers[field.id] || "";
    control.placeholder = field.placeholder || "ここに入力";
    control.setAttribute("aria-label", field.label || `ページ${state.currentPage}の回答`);
    control.dataset.fieldId = field.id;
    if (field.maxLength) control.maxLength = field.maxLength;
    control.spellcheck = true;
    control.readOnly = state.fieldEditor;
    control.tabIndex = state.fieldEditor ? -1 : 0;
    control.style.fontSize = `${Math.max(12, els.pageWrap.clientWidth * (field.fontScale || 0.014))}px`;
    control.addEventListener("input", () => {
      answers[field.id] = control.value;
      persistAnswers();
    });
    shell.append(control);

    if (state.fieldEditor) {
      const typeLabel = document.createElement("span");
      typeLabel.className = "field-type-label";
      typeLabel.textContent = field.type === "single-line" ? "1行" : "複数行";
      shell.append(typeLabel);

      const resizeHandle = document.createElement("button");
      resizeHandle.type = "button";
      resizeHandle.className = "field-resize-handle";
      resizeHandle.setAttribute("aria-label", "入力欄のサイズを変更");
      resizeHandle.textContent = "↘";
      resizeHandle.addEventListener("pointerdown", (event) => beginFieldInteraction(event, field, "resize"));
      shell.append(resizeHandle);
      shell.addEventListener("pointerdown", (event) => {
        if (event.target !== resizeHandle) beginFieldInteraction(event, field, "move");
      });
    }

    els.responseLayer.append(shell);
  }

  if (state.fieldInteraction?.kind === "create") {
    const rect = normalizedFieldRect(state.fieldInteraction.start, state.fieldInteraction.current);
    const preview = document.createElement("div");
    preview.className = `field-create-preview ${state.fieldType}`;
    Object.assign(preview.style, {
      left: `${rect.x}%`,
      top: `${rect.y}%`,
      width: `${rect.width}%`,
      height: `${rect.height}%`,
    });
    els.responseLayer.append(preview);
  }
  updateFieldEditorUI();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}

function pointerPercent(event) {
  const rect = els.responseLayer.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
    y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
  };
}

function normalizedFieldRect(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function fieldById(id) {
  return (pageDefinition().fields || []).find((field) => field.id === id);
}

function nextFieldId() {
  const prefix = `page-${String(state.currentPage).padStart(3, "0")}-field-`;
  const used = new Set((pageDefinition().fields || []).map((field) => field.id));
  let number = 1;
  while (used.has(`${prefix}${String(number).padStart(2, "0")}`)) number += 1;
  return `${prefix}${String(number).padStart(2, "0")}`;
}

function setFieldEditor(enabled) {
  if (!state.manifest) return;
  if (enabled && state.compositionOpen) closeComposition();
  state.fieldEditor = enabled;
  state.selectedFieldId = null;
  state.fieldInteraction = null;
  stopNarration(true);
  els.fieldEditorPanel.hidden = !enabled;
  els.fieldEditorBtn.setAttribute("aria-pressed", String(enabled));
  els.fieldEditorBtn.textContent = enabled ? "✓ 配置を終了" : "▣ 入力欄を配置";
  renderResponseFields();
  if (enabled) notify("PDF上をドラッグすると、入力欄を作れます。", "info");
}

function setFieldType(type) {
  state.fieldType = type;
  const selected = fieldById(state.selectedFieldId);
  if (selected) {
    selected.type = type;
    if (type === "multiline" && selected.height < 4) selected.height = Math.min(4, 100 - selected.y);
    if (type === "single-line") {
      const answers = currentPageAnswers();
      if (typeof answers[selected.id] === "string") answers[selected.id] = answers[selected.id].replace(/[\r\n]+/g, " ");
      persistAnswers();
    }
    state.layoutDirty = true;
    renderResponseFields();
    return;
  }
  updateFieldEditorUI();
}

function updateFieldEditorUI() {
  const fields = state.manifest ? (pageDefinition().fields || []) : [];
  const selected = fieldById(state.selectedFieldId);
  if (state.selectedFieldId && !selected) state.selectedFieldId = null;
  els.singleLineFieldBtn.classList.toggle("active", state.fieldType === "single-line");
  els.multilineFieldBtn.classList.toggle("active", state.fieldType === "multiline");
  els.singleLineFieldBtn.setAttribute("aria-pressed", String(state.fieldType === "single-line"));
  els.multilineFieldBtn.setAttribute("aria-pressed", String(state.fieldType === "multiline"));
  els.deleteFieldBtn.disabled = !selected;
  els.clearPageFieldsBtn.disabled = fields.length === 0;
  if (!state.fieldEditor) return;
  els.fieldEditorStatus.textContent = selected
    ? `選択中: ${selected.type === "single-line" ? "1行・改行なし" : "複数行・改行あり"}。ドラッグで移動、右下でサイズ変更。`
    : `ページ${state.currentPage}: ${fields.length}個。種類を選び、PDF上をドラッグしてください。`;
}

function beginFieldInteraction(event, field, kind) {
  if (!state.fieldEditor || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  state.selectedFieldId = field.id;
  state.fieldType = field.type;
  state.fieldInteraction = {
    kind,
    pointerId: event.pointerId,
    start: pointerPercent(event),
    current: pointerPercent(event),
    original: { x: field.x, y: field.y, width: field.width, height: field.height },
    changed: false,
  };
  els.responseLayer.setPointerCapture?.(event.pointerId);
  renderResponseFields();
}

function beginFieldCreation(event) {
  if (!state.fieldEditor || event.button !== 0 || event.target !== els.responseLayer) return;
  event.preventDefault();
  const point = pointerPercent(event);
  state.selectedFieldId = null;
  state.fieldInteraction = { kind: "create", pointerId: event.pointerId, start: point, current: point, changed: false };
  els.responseLayer.setPointerCapture?.(event.pointerId);
  renderResponseFields();
}

function moveFieldInteraction(event) {
  const interaction = state.fieldInteraction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  event.preventDefault();
  const current = pointerPercent(event);
  interaction.current = current;
  if (interaction.kind === "create") {
    interaction.changed = true;
    renderResponseFields();
    return;
  }

  const field = fieldById(state.selectedFieldId);
  if (!field) return;
  const dx = current.x - interaction.start.x;
  const dy = current.y - interaction.start.y;
  if (interaction.kind === "move") {
    field.x = roundPercent(clamp(interaction.original.x + dx, 0, 100 - field.width));
    field.y = roundPercent(clamp(interaction.original.y + dy, 0, 100 - field.height));
  } else {
    const minHeight = field.type === "single-line" ? 2.5 : 4;
    field.width = roundPercent(clamp(interaction.original.width + dx, 3, 100 - field.x));
    field.height = roundPercent(clamp(interaction.original.height + dy, minHeight, 100 - field.y));
  }
  interaction.changed = Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05;
  renderResponseFields();
}

function endFieldInteraction(event) {
  const interaction = state.fieldInteraction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  if (interaction.kind === "create") {
    const rect = normalizedFieldRect(interaction.start, pointerPercent(event));
    if (rect.width >= 2 && rect.height >= 1.5) {
      const minHeight = state.fieldType === "single-line" ? 2.5 : 4;
      const width = Math.min(100, Math.max(3, rect.width));
      const height = Math.min(100, Math.max(minHeight, rect.height));
      const page = editablePageDefinition();
      const field = {
        id: nextFieldId(),
        type: state.fieldType,
        label: `ページ${state.currentPage}の回答欄${page.fields.length + 1}`,
        x: roundPercent(Math.min(rect.x, 100 - width)),
        y: roundPercent(Math.min(rect.y, 100 - height)),
        width: roundPercent(width),
        height: roundPercent(height),
      };
      page.fields.push(field);
      state.selectedFieldId = field.id;
      state.layoutDirty = true;
    } else {
      notify("入力欄が小さすぎます。もう少し大きくドラッグしてください。", "warning");
    }
  } else if (interaction.changed) {
    state.layoutDirty = true;
  }
  if (els.responseLayer.hasPointerCapture?.(event.pointerId)) els.responseLayer.releasePointerCapture(event.pointerId);
  state.fieldInteraction = null;
  renderResponseFields();
}

function deleteSelectedField() {
  const page = editablePageDefinition();
  const index = page.fields.findIndex((field) => field.id === state.selectedFieldId);
  if (index < 0) return;
  const [removed] = page.fields.splice(index, 1);
  delete currentPageAnswers()[removed.id];
  persistAnswers();
  state.selectedFieldId = null;
  state.layoutDirty = true;
  renderResponseFields();
}

function clearCurrentPageFields() {
  const page = editablePageDefinition();
  if (!page.fields.length) return;
  if (!window.confirm(`ページ${state.currentPage}の入力欄をすべて削除しますか？`)) return;
  const answers = currentPageAnswers();
  for (const field of page.fields) delete answers[field.id];
  page.fields = [];
  persistAnswers();
  state.selectedFieldId = null;
  state.layoutDirty = true;
  renderResponseFields();
}

async function exportEditedPackage() {
  if (!state.zip || !state.manifest) return;
  try {
    validateManifest(state.manifest);
    els.exportPackageBtn.disabled = true;
    els.exportPackageBtn.textContent = "ZIP作成中…";
    state.zip.file(`${state.zipPrefix}script.json`, `${JSON.stringify(state.manifest, null, 2)}\n`);
    const blob = await state.zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const originalBase = state.originalZipName.replace(/\.zip$/i, "") || safeFilename(state.manifest.title);
    downloadBlob(blob, `${safeFilename(originalBase)}-fields.zip`);
    state.layoutDirty = false;
    notify("入力欄を含むZIPを保存しました。", "info");
  } catch (error) {
    console.error(error);
    notify("ZIPを作成できませんでした。", "error");
  } finally {
    els.exportPackageBtn.disabled = false;
    els.exportPackageBtn.textContent = "⇩ ZIPを保存";
  }
}

function updateCompositionAvailability() {
  const available = Boolean(state.manifest && pageDefinition().composition);
  els.compositionBtn.hidden = !available;
  if (!available && state.compositionOpen) closeComposition();
}

function updateCompositionCharacterCount() {
  els.compositionCharacterCount.textContent = `${Array.from(els.compositionTextInput.value).length}文字`;
}

function openComposition() {
  const config = pageDefinition().composition;
  if (!config) return;
  if (state.fieldEditor) setFieldEditor(false);
  stopNarration(true);
  const composition = currentComposition();
  els.compositionPrompt.textContent = config.prompt || "これまでの設計を使って、物語の本文を書きましょう。";
  els.compositionTitleInput.placeholder = config.titlePlaceholder || "作品タイトルを入力";
  els.compositionTextInput.placeholder = config.bodyPlaceholder || "ここに物語を書きます。改行も使えます。";
  els.compositionTextInput.maxLength = config.maxLength || 50000;
  els.compositionTitleInput.value = composition.title || "";
  els.compositionTextInput.value = composition.text || "";
  state.compositionOpen = true;
  els.compositionPanel.hidden = false;
  els.compositionBtn.setAttribute("aria-pressed", "true");
  updateCompositionCharacterCount();
  requestAnimationFrame(() => els.compositionTextInput.focus());
}

function closeComposition() {
  if (!state.compositionOpen) return;
  persistAnswers();
  state.compositionOpen = false;
  els.compositionPanel.hidden = true;
  els.compositionBtn.setAttribute("aria-pressed", "false");
}

function saveCompositionInput() {
  const composition = currentComposition();
  composition.title = els.compositionTitleInput.value;
  composition.text = els.compositionTextInput.value;
  composition.updatedAt = new Date().toISOString();
  persistAnswers();
  updateCompositionCharacterCount();
}

function exportCompositionText() {
  const composition = currentComposition();
  composition.title = els.compositionTitleInput.value;
  composition.text = els.compositionTextInput.value;
  composition.updatedAt = new Date().toISOString();
  persistAnswers();
  const config = pageDefinition().composition || {};
  const content = composition.title.trim()
    ? `${composition.title.trim()}\n\n${composition.text}`
    : composition.text;
  const requestedName = config.filename || composition.title || `${state.manifest.title}-作文`;
  const baseName = safeFilename(String(requestedName).replace(/\.txt$/i, ""));
  downloadBlob(new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" }), `${baseName}.txt`);
  notify("作文をTXTで保存しました。", "info");
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
  await speakInBrowser(cue.reading || cue.text, cue, token);
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
    if (state.layoutDirty && !window.confirm("ZIPへ保存していない入力欄の変更があります。別のZIPを開きますか？")) return;
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
  els.compositionBtn.addEventListener("click", () => state.compositionOpen ? closeComposition() : openComposition());
  els.closeCompositionBtn.addEventListener("click", closeComposition);
  els.saveCompositionTextBtn.addEventListener("click", exportCompositionText);
  els.compositionTitleInput.addEventListener("input", saveCompositionInput);
  els.compositionTextInput.addEventListener("input", saveCompositionInput);
  els.fieldEditorBtn.addEventListener("click", () => setFieldEditor(!state.fieldEditor));
  els.singleLineFieldBtn.addEventListener("click", () => setFieldType("single-line"));
  els.multilineFieldBtn.addEventListener("click", () => setFieldType("multiline"));
  els.deleteFieldBtn.addEventListener("click", deleteSelectedField);
  els.clearPageFieldsBtn.addEventListener("click", clearCurrentPageFields);
  els.exportPackageBtn.addEventListener("click", exportEditedPackage);
  els.exportAnswersBtn.addEventListener("click", exportAnswers);
  els.fullscreenBtn.addEventListener("click", async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.player.requestFullscreen();
  });
  els.playPauseBtn.addEventListener("click", togglePlayback);
  els.stopBtn.addEventListener("click", () => stopNarration(true));
  els.continueBtn.addEventListener("click", continueAfterWait);
  els.responseLayer.addEventListener("pointerdown", beginFieldCreation);
  els.responseLayer.addEventListener("pointermove", moveFieldInteraction);
  els.responseLayer.addEventListener("pointerup", endFieldInteraction);
  els.responseLayer.addEventListener("pointercancel", () => {
    state.fieldInteraction = null;
    renderResponseFields();
  });
  window.addEventListener("resize", debounce(() => renderCurrentPage(), 180));
  window.addEventListener("beforeunload", (event) => {
    stopNarration(false);
    persistAnswers();
    if (state.layoutDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  document.addEventListener("keydown", (event) => {
    if (state.compositionOpen && event.key === "Escape") {
      event.preventDefault();
      closeComposition();
      return;
    }
    const tag = event.target?.tagName?.toLowerCase();
    if (["input", "textarea", "button"].includes(tag)) return;
    if (state.fieldEditor) {
      if ((event.key === "Delete" || event.key === "Backspace") && state.selectedFieldId) {
        event.preventDefault();
        deleteSelectedField();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (state.selectedFieldId) {
          state.selectedFieldId = null;
          renderResponseFields();
        } else {
          setFieldEditor(false);
        }
      }
      return;
    }
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
