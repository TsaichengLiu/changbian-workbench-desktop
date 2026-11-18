import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type RefObject,
  Fragment,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { ExportScope } from "./exporters";
import { applyLightMarkup } from "./light-markup";
import { isIgnorableChar, toSimplified } from "./text-fold";
import type { SearchCriteria, SearchResult } from "./search-engine";
import {
  compareTexts,
  DEFAULT_GRAM_SIZE,
  DEFAULT_MAX_GAP,
  DEFAULT_MIN_BLOCK_CHARS,
  DEFAULT_MIN_SHARED_CHARS,
  FREQUENT_FRAGMENT_MIN_ENTRIES,
  FREQUENT_FRAGMENT_SHARE,
  markedRanges,
  MAX_GRAM_SIZE,
  MAX_MAX_GAP,
  MAX_MIN_BLOCK_CHARS,
  MAX_MIN_SHARED_CHARS,
  MIN_GRAM_SIZE,
  MIN_MAX_GAP,
  MIN_MIN_BLOCK_CHARS,
  MIN_MIN_SHARED_CHARS,
  type ComparableText,
  type FrequentFragment,
  type SimilarMatch,
} from "./similarity";
import type {
  SimilarPairResult,
  SimilarityWorkerRequest,
  SimilarityWorkerResponse,
} from "./similarity-worker";
import {
  assignEntryRefIds,
  collectEntryRefs,
  entryRefToken,
  isEntryRefId,
  nextFreeEntryRefId,
  rewriteEntryRefs,
  splitEntryRefs,
} from "./entry-refs";
import type { Chapter, Entry, Project, TrashItem, WorkspaceData } from "./types";
import { createId, reorderById, summarize } from "./utils";

const STORAGE_KEY = "longform_history_workbench_v3";
const APPEARANCE_KEY = "longform_history_workbench_appearance_v1";
const WORKSPACE_SCHEMA_VERSION = 1;
const WORKSPACE_SAVE_DEBOUNCE_MS = 450;
const LOCAL_BACKUP_FAILED_STATUS = "本機瀏覽器備份寫入失敗（儲存空間可能已滿）";
const READING_FONT_KEY = "longform_history_workbench_reading_font_v1";
const READING_FONT_DEFAULT = 16;
const READING_FONT_MIN = 13;
const READING_FONT_MAX = 24;
const SIMILAR_GRAM_KEY = "longform_history_workbench_similar_gram_v1";
const SIMILAR_MIN_SHARED_KEY = "longform_history_workbench_similar_min_shared_v1";
const SIMILAR_IGNORE_FREQUENT_KEY = "longform_history_workbench_similar_ignore_frequent_v1";
// 語序一致度下限，以百分比保存；0 為不限。
const SIMILAR_MIN_ORDER_KEY = "longform_history_workbench_similar_min_order_v1";
const SIMILAR_MIN_ORDER_OPTIONS = [0, 50, 60, 70, 80, 90];
const SIMILAR_MIN_SHARED_OPTIONS = [4, 6, 8, 10, 12, 15, 20, 30, 40, 60, 100].filter(
  (value) => value >= MIN_MIN_SHARED_CHARS && value <= MAX_MIN_SHARED_CHARS,
);
const SIMILAR_MIN_BLOCK_KEY = "longform_history_workbench_similar_min_block_v1";
const SIMILAR_MAX_GAP_KEY = "longform_history_workbench_similar_max_gap_v1";
const SIMILAR_MAX_GAP_OPTIONS = [6, 8, 12, 16, 24];
const SIMILAR_STRICT_KEY = "longform_history_workbench_similar_strict_v1";
const SIMILAR_MIN_ORDER_DEFAULT = 0;

// 每條史料的相似文本摘要（背景計算），用於卡片與檢視窗中的提示。
interface SimilarSummaryItem {
  entryId: string;
  score: number;
  sharedChars: number;
  identity: number;
  // 兩條原文完全相同。
  copy: boolean;
}

// 「相似文本」提示的圖示：兩頁疊放。
const SIMILAR_ICON = (
  <svg className="similar-icon" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="4.6" width="8.4" height="9.6" rx="1.8" />
    <path d="M5.6 2.2h6.6a1.8 1.8 0 0 1 1.8 1.8v7" />
  </svg>
);

// 相似文本的比對規則標籤：點選標籤即在其下展開調整面板。
type SimilarRuleKey = "fold" | "gram" | "gap" | "length" | "order" | "frequent";
type SimilarRulePlace = "panel" | "overview";
const SIMILAR_MIN_BLOCK_OPTIONS = [4, 6, 8, 10, 12, 15, 20, 30, 40, 60, 100].filter(
  (value) => value >= MIN_MIN_BLOCK_CHARS && value <= MAX_MIN_BLOCK_CHARS,
);
const SIMILAR_GRAM_OPTIONS = Array.from(
  { length: MAX_GRAM_SIZE - MIN_GRAM_SIZE + 1 },
  (_, index) => MIN_GRAM_SIZE + index,
);
const TRASH_ITEM_LIMIT = 100;

type UiThemeId = "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
type UiCardStyleId = "changbian" | "outline" | "frosted";

interface AppearanceState {
  theme: UiThemeId;
  cardStyle: UiCardStyleId;
}

const DEFAULT_APPEARANCE: AppearanceState = {
  theme: "changbian",
  cardStyle: "changbian",
};

const UI_THEME_IDS: UiThemeId[] = ["changbian", "obsidian", "ocean", "graphite", "dusk", "vaporwave"];
const UI_CARD_STYLE_IDS: UiCardStyleId[] = ["changbian", "outline", "frosted"];

function isUiThemeId(value: string): value is UiThemeId {
  return UI_THEME_IDS.includes(value as UiThemeId);
}

function isUiCardStyleId(value: string): value is UiCardStyleId {
  return UI_CARD_STYLE_IDS.includes(value as UiCardStyleId);
}

function normalizeAppearance(candidate: unknown, fallback: AppearanceState = DEFAULT_APPEARANCE): AppearanceState {
  const obj = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
  const theme = typeof obj.theme === "string" && isUiThemeId(obj.theme) ? obj.theme : fallback.theme;
  const cardStyle =
    typeof obj.cardStyle === "string" && isUiCardStyleId(obj.cardStyle) ? obj.cardStyle : fallback.cardStyle;
  return { theme, cardStyle };
}

function loadAppearance(): AppearanceState {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) {
      return DEFAULT_APPEARANCE;
    }
    return normalizeAppearance(JSON.parse(raw), DEFAULT_APPEARANCE);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;

type DragPayload =
  | { type: "project"; id: string }
  | { type: "chapter"; id: string; projectId: string }
  | { type: "entry"; id: string; projectId: string; chapterId: string };

interface EntryDraft {
  timeText: string;
  summary: string;
  sourceText: string;
  note: string;
  citation: string;
}

interface ProjectSnapshot {
  title: string;
  chapters: Array<{
    title: string;
    entries: EntryDraft[];
  }>;
}

interface ChapterSnapshot {
  title: string;
  entries: EntryDraft[];
}

type ClipboardState =
  | { kind: "project"; snapshot: ProjectSnapshot }
  | { kind: "chapter"; snapshots: ChapterSnapshot[] }
  | { kind: "entry"; drafts: EntryDraft[] }
  | null;

type SaveState = "saved" | "pending" | "saving" | "local" | "error";

const SAVE_STATE_LABEL: Record<SaveState, string> = {
  saved: "已儲存",
  pending: "尚未儲存",
  saving: "儲存中…",
  local: "已備份於本機",
  error: "儲存失敗",
};

type ModalState =
  | { kind: "project-create"; value: string; insertAfterProjectId: string | null }
  | { kind: "project-rename"; projectId: string; value: string }
  | { kind: "chapter-create"; projectId: string; value: string; insertAfterChapterId: string | null }
  | { kind: "chapter-rename"; chapterId: string; value: string }
  | {
      kind: "entry-create";
      projectId: string;
      chapterId: string;
      insertAfterEntryId: string | null;
      draft: EntryDraft;
    }
  | { kind: "entry-edit"; entryId: string; draft: EntryDraft }
  | null;

interface ProjectMenuState {
  kind: "project";
  projectId: string;
  x: number;
  y: number;
}

interface ChapterMenuState {
  kind: "chapter";
  chapterId: string;
  x: number;
  y: number;
}

interface EntryMenuState {
  kind: "entry";
  entryId: string;
  x: number;
  y: number;
}

type ContextMenuState = ProjectMenuState | ChapterMenuState | EntryMenuState;

interface ModalDragState {
  key: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// 一個「檢視史料」窗口。可同時打開多個；它們浮在主界面上，不阻擋主界面操作。
interface EntryViewWindow {
  winId: string;
  entryId: string;
  editing: boolean;
  draft: EntryDraft;
  highlightQuery: string;
}

const ENTRY_VIEW_WINDOW_LIMIT = 8;

function entryViewKey(winId: string): string {
  return `view:${winId}`;
}

type OverlayModalKey =
  | "storage"
  | "trash"
  | "storage-save-as"
  | "storage-format-info"
  | "form"
  | "entry-form"
  | "advanced"
  | "merge-project"
  | "merge-chapter"
  | "compare"
  | "similar-overview";

const OVERLAY_MODAL_KEYS: OverlayModalKey[] = [
  "storage",
  "trash",
  "storage-save-as",
  "storage-format-info",
  "form",
  "entry-form",
  "advanced",
  "merge-project",
  "merge-chapter",
  "compare",
  "similar-overview",
];

type RightPaneTab = "search" | "similar";

interface CompareState {
  leftEntryId: string;
  rightEntryId: string;
  strict: boolean;
}

// 比勘著色：same 標出兩段共有的文字（綠），diff 標出各自獨有的文字。
type CompareMarkMode = "same" | "diff";

const COMPARE_MARK_MODE_KEY = "longform_history_workbench_compare_mark_v1";

function loadCompareMarkMode(): CompareMarkMode {
  try {
    return localStorage.getItem(COMPARE_MARK_MODE_KEY) === "diff" ? "diff" : "same";
  } catch {
    return "same";
  }
}

// 比勘範圍：aligned 只比對齊段落（段落外的文字淡化、不參與比較），full 整條對整條。
type CompareScope = "aligned" | "full";

const COMPARE_SCOPE_KEY = "longform_history_workbench_compare_scope_v1";

function loadCompareScope(): CompareScope {
  try {
    return localStorage.getItem(COMPARE_SCOPE_KEY) === "full" ? "full" : "aligned";
  } catch {
    return "aligned";
  }
}

// 比勘窗兩欄各自捲到第 index 個對齊段落。
function scrollCompareToBlock(index: number, behavior: ScrollBehavior = "smooth"): void {
  document.querySelectorAll<HTMLElement>(".compare-modal .compare-pane").forEach((pane) => {
    const target = pane.querySelector<HTMLElement>(`[data-block="${index}"]`);
    if (target) {
      const top = pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
      pane.scrollTo({ top, behavior });
    }
  });
}

const MODAL_BASE_Z_INDEX = 130;
const MODAL_Z_INDEX_STEP = 4;

function createOverlayModalMap<T>(value: T): Record<OverlayModalKey, T> {
  return {
    storage: value,
    trash: value,
    "storage-save-as": value,
    "storage-format-info": value,
    form: value,
    "entry-form": value,
    advanced: value,
    "merge-project": value,
    "merge-chapter": value,
    compare: value,
    "similar-overview": value,
  };
}

interface MergeModalState {
  open: boolean;
  mode: "into-active" | "as-new";
  selectedProjectIds: string[];
  newProjectTitle: string;
}

type AdvancedTargetMode =
  | "new-project"
  | "new-chapter"
  | "existing-chapter";

type AdvancedQueryScope =
  | "project"
  | "chapter"
  | "time"
  | "summary"
  | "source"
  | "note"
  | "citation"
  | "refId";

const ADVANCED_QUERY_SCOPE_OPTIONS: Array<{ value: AdvancedQueryScope; label: string }> = [
  { value: "project", label: "專案" },
  { value: "chapter", label: "章節" },
  { value: "time", label: "時間" },
  { value: "summary", label: "摘要" },
  { value: "source", label: "史料" },
  { value: "note", label: "備註" },
  { value: "citation", label: "引文" },
  { value: "refId", label: "編號" },
];

const DEFAULT_ADVANCED_QUERY_SCOPES: AdvancedQueryScope[] = ADVANCED_QUERY_SCOPE_OPTIONS.map(
  (option) => option.value,
);

interface AdvancedSearchModalState {
  open: boolean;
  query: string;
  queryScopes: AdvancedQueryScope[];
  tag: string;
  citationTitle: string;
  targetMode: AdvancedTargetMode;
  newProjectTitle: string;
  newChapterTitle: string;
  existingProjectId: string;
  existingChapterId: string;
}

interface ChapterMergeModalState {
  open: boolean;
  selectedChapterIds: string[];
  targetProjectId: string;
  newChapterTitle: string;
}

interface WorkspaceStorageInfo {
  path: string;
  defaultPath: string;
  envLocked: boolean;
  envPath: string | null;
}

function entryToDraft(entry: Entry): EntryDraft {
  return {
    timeText: entry.timeText,
    summary: entry.summary ?? "",
    sourceText: entry.sourceText,
    note: entry.note,
    citation: entry.citation,
  };
}

function createEmptyEntryDraft(): EntryDraft {
  return {
    timeText: "",
    summary: "",
    sourceText: "",
    note: "",
    citation: "",
  };
}

function entryDraftsEqual(a: EntryDraft, b: EntryDraft): boolean {
  return (
    a.timeText === b.timeText &&
    a.summary === b.summary &&
    a.sourceText === b.sourceText &&
    a.note === b.note &&
    a.citation === b.citation
  );
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TAG_REGEX)) {
    const token = `#${(match[1] ?? "").trim()}`;
    if (!token || token === "#") {
      continue;
    }
    const key = token.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(token);
  }
  return tags;
}

function firstEntryInProject(workspace: WorkspaceData, projectId: string | null): string | null {
  if (!projectId) {
    return null;
  }

  const project = workspace.projects[projectId];
  if (!project) {
    return null;
  }

  for (const chapterId of project.chapterIds) {
    const chapter = workspace.chapters[chapterId];
    if (chapter && chapter.entryIds.length > 0) {
      return chapter.entryIds[0] ?? null;
    }
  }

  return null;
}

function activeEntryIds(workspace: WorkspaceData): string[] {
  const activeProjectId = workspace.activeProjectId;
  if (!activeProjectId) {
    return [];
  }

  const project = workspace.projects[activeProjectId];
  if (!project) {
    return [];
  }

  if (workspace.activeChapterId) {
    const chapter = workspace.chapters[workspace.activeChapterId];
    return chapter?.entryIds ?? [];
  }

  return [];
}

function ensureRepairChapterId(workspace: WorkspaceData, projectId: string): string {
  const chapterId = `chapter-ungrouped-${projectId}`;
  if (!workspace.chapters[chapterId]) {
    workspace.chapters[chapterId] = {
      id: chapterId,
      projectId,
      title: "未分章",
      entryIds: [],
      createdAt: Date.now(),
    };
  }
  const project = workspace.projects[projectId];
  if (project && !project.chapterIds.includes(chapterId)) {
    project.chapterIds.push(chapterId);
  }
  return chapterId;
}

function resolveInsertAfterEntryId(
  workspace: WorkspaceData,
  projectId: string,
  chapterId: string,
  selectedEntryId: string | null,
): string | null {
  if (!selectedEntryId) {
    return null;
  }
  const selected = workspace.entries[selectedEntryId];
  if (!selected) {
    return null;
  }
  if (selected.projectId !== projectId) {
    return null;
  }
  if (selected.chapterId !== chapterId) {
    return null;
  }
  return selectedEntryId;
}

function buildIdRange(orderedIds: string[], anchorId: string, targetId: string): string[] {
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) {
    return [targetId];
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return orderedIds.slice(start, end + 1);
}

// 寫入系統剪貼簿：桌面版經由主程序；瀏覽器用 Clipboard API，不可用時退回 execCommand。
async function writeTextToClipboard(text: string): Promise<boolean> {
  try {
    if (window.workspaceBridge?.writeClipboardText) {
      return await window.workspaceBridge.writeClipboardText(text);
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

const ENTRY_REF_ICON =
  '<svg class="entry-ref-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/></svg>';

// 回收站中條目的編號：恢復時要用回，不能分給新條目。
function trashedEntryRefIds(workspace: WorkspaceData): string[] {
  const refIds: string[] = [];
  for (const item of workspace.trash) {
    const payload = item.payload;
    const entries = payload.kind === "entry" ? payload.entries.map(({ entry }) => entry) : payload.entries;
    for (const entry of entries) {
      if (entry.refId) {
        refIds.push(entry.refId);
      }
    }
  }
  return refIds;
}

function usedEntryRefIds(workspace: WorkspaceData): Set<string> {
  const used = new Set(trashedEntryRefIds(workspace));
  for (const entry of Object.values(workspace.entries)) {
    if (entry.refId) {
      used.add(entry.refId);
    }
  }
  return used;
}

function appendEntryDraft(
  workspace: WorkspaceData,
  projectId: string,
  chapterId: string,
  draft: EntryDraft,
  insertAfterEntryId: string | null = null,
): string {
  const entryId = createId("entry");
  const now = Date.now();
  workspace.entries[entryId] = {
    id: entryId,
    refId: nextFreeEntryRefId(now, usedEntryRefIds(workspace)),
    projectId,
    chapterId,
    timeText: draft.timeText,
    summary: draft.summary,
    sourceText: draft.sourceText,
    note: draft.note,
    citation: draft.citation,
    createdAt: now,
    updatedAt: now,
  };

  const targetEntryIds = workspace.chapters[chapterId]?.entryIds;

  if (!targetEntryIds) {
    return entryId;
  }

  if (insertAfterEntryId) {
    const index = targetEntryIds.indexOf(insertAfterEntryId);
    if (index >= 0) {
      targetEntryIds.splice(index + 1, 0, entryId);
      return entryId;
    }
  }

  targetEntryIds.push(entryId);

  return entryId;
}

function appendChapterWithEntries(
  workspace: WorkspaceData,
  projectId: string,
  chapterTitle: string,
  drafts: EntryDraft[],
): string | null {
  if (!workspace.projects[projectId] || drafts.length === 0) {
    return null;
  }

  const chapterId = createId("chapter");
  workspace.chapters[chapterId] = {
    id: chapterId,
    projectId,
    title: chapterTitle,
    entryIds: [],
    createdAt: Date.now(),
  };
  workspace.projects[projectId].chapterIds.push(chapterId);

  for (const draft of drafts) {
    appendEntryDraft(workspace, projectId, chapterId, draft);
  }

  return chapterId;
}

function ensureUniqueProjectTitle(
  workspace: WorkspaceData,
  base: string,
  ignoreProjectId?: string,
): string {
  const normalized = base.trim() || "新建專案";
  const existing = new Set(
    Object.values(workspace.projects)
      .filter((project) => project.id !== ignoreProjectId)
      .map((project) => project.title),
  );
  if (!existing.has(normalized)) {
    return normalized;
  }

  let counter = 2;
  while (existing.has(`${normalized} (${counter})`)) {
    counter += 1;
  }
  return `${normalized} (${counter})`;
}

function ensureUniqueChapterTitle(
  workspace: WorkspaceData,
  projectId: string,
  base: string,
  ignoreChapterId?: string,
): string {
  const project = workspace.projects[projectId];
  const normalized = base.trim() || "新章節";
  if (!project) {
    return normalized;
  }
  const existing = new Set(
    project.chapterIds
      .map((chapterId) => workspace.chapters[chapterId])
      .filter((chapter): chapter is NonNullable<typeof chapter> => Boolean(chapter))
      .filter((chapter) => chapter.id !== ignoreChapterId)
      .map((chapter) => chapter.title),
  );
  if (!existing.has(normalized)) {
    return normalized;
  }

  let counter = 2;
  while (existing.has(`${normalized} (${counter})`)) {
    counter += 1;
  }
  return `${normalized} (${counter})`;
}

function collectProjectSnapshot(workspace: WorkspaceData, projectId: string): ProjectSnapshot | null {
  const project = workspace.projects[projectId];
  if (!project) {
    return null;
  }

  const chapters = project.chapterIds
    .map((chapterId) => workspace.chapters[chapterId])
    .filter(Boolean)
    .map((chapter) => ({
      title: chapter.title,
      entries: chapter.entryIds
        .map((entryId) => workspace.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map(entryToDraft),
    }));

  return {
    title: project.title,
    chapters,
  };
}

function collectChapterSnapshot(workspace: WorkspaceData, chapterId: string): ChapterSnapshot | null {
  const chapter = workspace.chapters[chapterId];
  if (!chapter) {
    return null;
  }
  const entries = chapter.entryIds
    .map((entryId) => workspace.entries[entryId])
    .filter((entry): entry is Entry => Boolean(entry))
    .map(entryToDraft);
  return {
    title: chapter.title,
    entries,
  };
}

function appendSnapshotToProject(
  workspace: WorkspaceData,
  targetProjectId: string,
  snapshot: ProjectSnapshot,
  prefixSourceTitle: boolean,
): string | null {
  if (!workspace.projects[targetProjectId]) {
    return null;
  }

  let firstEntryId: string | null = null;

  for (const chapter of snapshot.chapters) {
    if (chapter.entries.length === 0) {
      continue;
    }

    const title = prefixSourceTitle ? `${snapshot.title}｜${chapter.title}` : chapter.title;
    const chapterId = appendChapterWithEntries(workspace, targetProjectId, title, chapter.entries);
    if (chapterId) {
      const first = workspace.chapters[chapterId]?.entryIds[0] ?? null;
      if (!firstEntryId && first) {
        firstEntryId = first;
      }
    }
  }

  return firstEntryId;
}

function isTrashItem(value: unknown): value is TrashItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<TrashItem> & { payload?: unknown };
  if (
    typeof item.id !== "string" ||
    typeof item.deletedAt !== "number" ||
    typeof item.label !== "string" ||
    !item.payload ||
    typeof item.payload !== "object"
  ) {
    return false;
  }
  const payload = item.payload as unknown as Record<string, unknown>;
  if (payload.kind === "project") {
    return Boolean(
      payload.project &&
      typeof payload.project === "object" &&
      Array.isArray(payload.chapters) &&
      Array.isArray(payload.entries),
    );
  }
  if (payload.kind === "chapter") {
    return Array.isArray(payload.chapters) && Array.isArray(payload.entries);
  }
  return payload.kind === "entry" && Array.isArray(payload.entries);
}

function prependTrashItem(workspace: WorkspaceData, item: TrashItem): void {
  workspace.trash = [item, ...workspace.trash].slice(0, TRASH_ITEM_LIMIT);
}

// owned 為 true 表示傳入的已是可以直接修改的副本（如 mutateWorkspace 的草稿），不再複製一份。
function cleanupWorkspace(workspace: WorkspaceData, owned = false): WorkspaceData {
  const next = owned ? workspace : structuredClone(workspace);
  next.schemaVersion = WORKSPACE_SCHEMA_VERSION;
  next.revision = Number.isInteger(next.revision) && next.revision >= 0 ? next.revision : 0;
  next.trash = (Array.isArray(next.trash) ? next.trash : [])
    .filter(isTrashItem)
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, TRASH_ITEM_LIMIT);

  next.projectOrder = next.projectOrder.filter((projectId) => Boolean(next.projects[projectId]));

  for (const chapterId of Object.keys(next.chapters)) {
    const chapter = next.chapters[chapterId];
    if (!next.projects[chapter.projectId]) {
      delete next.chapters[chapterId];
    }
  }

  for (const entryId of Object.keys(next.entries)) {
    const entry = next.entries[entryId];
    if (typeof entry.summary !== "string") {
      entry.summary = "";
    }
    const project = next.projects[entry.projectId];
    if (!project) {
      delete next.entries[entryId];
      continue;
    }

    // 章節已不存在時，遷入該專案的「未分章」修復章節（與 workspace-store 的遷移規則一致），
    // 史料不再允許脫離章節存在。
    if (!entry.chapterId || !next.chapters[entry.chapterId]) {
      entry.chapterId = ensureRepairChapterId(next, project.id);
    }
  }

  // 舊資料沒有編號時按建立時間補上；重複的（如恢復、匯入後）先到先得，後者順延。
  assignEntryRefIds(next.entries, trashedEntryRefIds(next));

  for (const projectId of Object.keys(next.projects)) {
    const project = next.projects[projectId];
    project.chapterIds = project.chapterIds.filter((chapterId) => {
      const chapter = next.chapters[chapterId];
      return Boolean(chapter && chapter.projectId === project.id);
    });

    const missingChapters = Object.values(next.chapters)
      .filter((chapter) => chapter.projectId === project.id && !project.chapterIds.includes(chapter.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((chapter) => chapter.id);
    project.chapterIds.push(...missingChapters);
  }

  for (const chapterId of Object.keys(next.chapters)) {
    const chapter = next.chapters[chapterId];
    chapter.entryIds = chapter.entryIds.filter((entryId) => {
      const entry = next.entries[entryId];
      return Boolean(entry && entry.projectId === chapter.projectId && entry.chapterId === chapter.id);
    });

    const missingChapterEntries = Object.values(next.entries)
      .filter(
        (entry) =>
          entry.projectId === chapter.projectId &&
          entry.chapterId === chapter.id &&
          !chapter.entryIds.includes(entry.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => entry.id);
    chapter.entryIds.push(...missingChapterEntries);
  }

  if (next.projectOrder.length === 0) {
    const projectId = createId("project");
    next.projects[projectId] = {
      id: projectId,
      title: "新建專案",
      chapterIds: [],
      createdAt: Date.now(),
    };
    next.projectOrder.push(projectId);
    next.activeProjectId = projectId;
    next.activeChapterId = null;
    next.selectedEntryId = null;
    return next;
  }

  if (!next.activeProjectId || !next.projects[next.activeProjectId]) {
    next.activeProjectId = next.projectOrder[0] ?? null;
    next.activeChapterId = null;
  }

  if (next.activeChapterId) {
    const chapter = next.chapters[next.activeChapterId];
    if (!chapter || chapter.projectId !== next.activeProjectId) {
      next.activeChapterId = null;
    }
  }

  if (next.selectedEntryId && !next.entries[next.selectedEntryId]) {
    next.selectedEntryId = null;
  }

  const visibleIds = activeEntryIds(next);
  if (!next.selectedEntryId || !visibleIds.includes(next.selectedEntryId)) {
    next.selectedEntryId = visibleIds[0] ?? firstEntryInProject(next, next.activeProjectId);
  }

  return next;
}

function createInitialWorkspace(): WorkspaceData {
  const projectId = createId("project");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    projectOrder: [projectId],
    projects: {
      [projectId]: {
        id: projectId,
        title: "我的長編專案",
        chapterIds: [],
        createdAt: Date.now(),
      },
    },
    chapters: {},
    entries: {},
    trash: [],
    activeProjectId: projectId,
    activeChapterId: null,
    selectedEntryId: null,
  };
}

// 工作區的內容物件一經產生就不再原地修改（改動都經 mutateWorkspace 產生新物件），
// 所以只要條目、專案、章節、回收站與專案次序都還是同一批物件，簽名就不變。
// 切換選中條目等只換外層物件的操作，不必重新序列化整個工作區。
interface CachedSignature {
  projectOrder: WorkspaceData["projectOrder"];
  projects: WorkspaceData["projects"];
  chapters: WorkspaceData["chapters"];
  trash: WorkspaceData["trash"];
  signature: string;
}

const workspaceSignatureCache = new WeakMap<object, CachedSignature>();

function workspaceContentSignature(workspace: WorkspaceData): string {
  const cached = workspace.entries ? workspaceSignatureCache.get(workspace.entries) : undefined;
  if (
    cached &&
    cached.projectOrder === workspace.projectOrder &&
    cached.projects === workspace.projects &&
    cached.chapters === workspace.chapters &&
    cached.trash === workspace.trash
  ) {
    return cached.signature;
  }
  const signature = JSON.stringify({
    projectOrder: workspace.projectOrder,
    projects: workspace.projects,
    chapters: workspace.chapters,
    entries: workspace.entries,
    trash: workspace.trash,
  });
  if (workspace.entries) {
    workspaceSignatureCache.set(workspace.entries, {
      projectOrder: workspace.projectOrder,
      projects: workspace.projects,
      chapters: workspace.chapters,
      trash: workspace.trash,
      signature,
    });
  }
  return signature;
}

// localStorage 超出配額時 setItem 會拋錯；不能讓它中斷資料檔存檔。
function writeLocalStorage(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// 本機備份讀入時補上了條目編號：啟動後儘快寫回一次，使編號固定下來。
let localWorkspaceNeedsSave = false;

function workspaceLacksRefIds(workspace: WorkspaceData): boolean {
  return Object.values(workspace.entries ?? {}).some((entry) => !isEntryRefId(entry?.refId));
}

function loadWorkspace(): WorkspaceData {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createInitialWorkspace();
  }

  try {
    const parsed = JSON.parse(raw) as WorkspaceData;
    localWorkspaceNeedsSave = workspaceLacksRefIds(parsed);
    return cleanupWorkspace(parsed);
  } catch {
    return createInitialWorkspace();
  }
}

function normalizeTagInput(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

interface SourceFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

const EMPTY_SOURCE_FORMAT_STATE: SourceFormatState = {
  bold: false,
  italic: false,
  underline: false,
};

function selectionIsInsideMarker(value: string, start: number, end: number, token: string): boolean {
  let openingIndex = -1;
  for (let index = 0; index <= value.length - token.length; index += 1) {
    if (value.slice(index, index + token.length) !== token) {
      continue;
    }
    if (token === "*" && (value[index - 1] === "*" || value[index + 1] === "*")) {
      continue;
    }
    if (openingIndex < 0) {
      openingIndex = index;
      index += token.length - 1;
      continue;
    }
    const contentStart = openingIndex + token.length;
    if (start >= contentStart && end <= index) {
      return true;
    }
    openingIndex = -1;
    index += token.length - 1;
  }
  return false;
}

function resolveSourceFormatState(textarea: HTMLTextAreaElement): SourceFormatState {
  const { value, selectionStart, selectionEnd } = textarea;
  return {
    bold: selectionIsInsideMarker(value, selectionStart, selectionEnd, "**"),
    italic: selectionIsInsideMarker(value, selectionStart, selectionEnd, "*"),
    underline: selectionIsInsideMarker(value, selectionStart, selectionEnd, "__"),
  };
}

function formatEntryHeadline(timeText: string, summaryText: string): string {
  const timeLabel = timeText.trim() || "未著錄時間";
  const summaryLabel = summaryText.trim();
  return summaryLabel ? `${timeLabel}｜${summaryLabel}` : timeLabel;
}

function formatDateTimeLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "未記錄";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "未記錄";
  }
  return date.toLocaleString("zh-Hant-TW", { hour12: false });
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHighlightTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLocaleLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length);
}

// 高亮與檢索一致：原文與關鍵字都去掉標點、逐字轉成簡體並轉小寫後比對，再把位置對應回原文。
// 逐字轉換保證位置一一對應，也讓「爲」「説」等舊字形能對上簡體輸入；
// 命中範圍跨過的標點一併標出，所以無句讀的關鍵字也能標出有句讀的原文。
const highlightFoldCache = new Map<string, string>();

function foldHighlightChar(char: string): string {
  let folded = highlightFoldCache.get(char);
  if (folded === undefined) {
    folded = toSimplified(char).toLocaleLowerCase();
    highlightFoldCache.set(char, folded);
  }
  return folded;
}

function foldForHighlight(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    if (!isIgnorableChar(char)) {
      const piece = foldHighlightChar(char);
      for (let index = 0; index < piece.length; index += 1) {
        starts.push(offset);
        ends.push(offset + char.length);
      }
      folded += piece;
    }
    offset += char.length;
  }
  return { folded, starts, ends };
}

function findHighlightRanges(text: string, tokens: string[]): Array<{ start: number; end: number }> {
  if (!text || tokens.length === 0) {
    return [];
  }
  const { folded, starts, ends } = foldForHighlight(text);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    const needle = foldForHighlight(token).folded;
    if (!needle) {
      continue;
    }
    let index = folded.indexOf(needle);
    while (index >= 0) {
      ranges.push({ start: starts[index], end: ends[index + needle.length - 1] });
      index = folded.indexOf(needle, index + needle.length);
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function wrapTextRanges(text: string, ranges: Array<{ start: number; end: number }>, className: string): string {
  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<mark class="${className}">${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeHtml(text.slice(cursor));
}

// 有對齊段落時的一欄：段落內標出相同或不同的字，每段包一層 data-block，供跳轉。
// 只比段落時（dimOutside）段落以外的文字淡化；比全文時段落以外照樣標出，段落加淡淡的底線。
// blocks 為此欄的 token 區間及其段號。
function renderAlignedText(
  text: string,
  comparable: ComparableText,
  ranges: Array<{ start: number; end: number }>,
  blocks: Array<{ start: number; end: number; index: number }>,
  className: string,
  dimOutside: boolean,
): string {
  const spans = blocks
    .map((block) => ({
      index: block.index,
      start: comparable.starts[block.start],
      end: comparable.ends[block.end - 1],
    }))
    .sort((x, y) => x.start - y.start);
  const piece = (start: number, end: number) =>
    wrapTextRanges(
      text.slice(start, end),
      ranges
        .filter((range) => range.start < end && range.end > start)
        .map((range) => ({ start: Math.max(range.start, start) - start, end: Math.min(range.end, end) - start })),
      className,
    );
  const outside = (start: number, end: number) =>
    dimOutside ? `<span class="diff-outside">${escapeHtml(text.slice(start, end))}</span>` : piece(start, end);
  const blockClass = dimOutside ? "align-block" : "align-block align-block-whole";
  let html = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      html += outside(cursor, span.start);
    }
    html += `<span class="${blockClass}" data-block="${span.index}">${piece(span.start, span.end)}</span>`;
    cursor = span.end;
  }
  if (cursor < text.length) {
    html += outside(cursor, text.length);
  }
  return html;
}

function wrapHighlightRanges(text: string, tokens: string[]): string {
  return wrapTextRanges(text, findHighlightRanges(text, tokens), "match-highlight");
}


// 切片時不要把擴展區漢字的代理對切成兩半。
function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

// 相似文本列表中的摘錄：標出對方文本中最長的共有片段。
function renderSimilarExcerpt(text: string, run: { start: number; end: number } | null): string {
  if (!run) {
    return escapeHtml(summarize(text, 80));
  }
  const runEnd = codePointBoundary(text, Math.min(run.end, run.start + 60));
  const before = codePointBoundary(text, Math.max(0, run.start - 16));
  const after = runEnd < run.end ? runEnd : codePointBoundary(text, Math.min(text.length, run.end + 16));
  // 摘錄會切斷 **粗體** 等標記，直接去掉標記符號。
  const plain = (start: number, end: number) => escapeHtml(text.slice(start, end).replace(/\*\*|__|\*/g, ""));
  return (
    (before > 0 ? "…" : "") +
    plain(before, run.start) +
    `<mark class="match-highlight">${plain(run.start, runEnd)}</mark>` +
    (runEnd < run.end ? "…" : plain(runEnd, after) + (after < text.length ? "…" : ""))
  );
}

// 「反向鏈接」列表中的摘錄：鏈接處前後各取一段。
function excerptAroundRef(note: string, refId: string, radius = 28): string {
  const token = entryRefToken(refId);
  const index = note.indexOf(token);
  if (index < 0) {
    return summarize(note, radius * 2);
  }
  const start = codePointBoundary(note, Math.max(0, index - radius));
  const end = codePointBoundary(note, Math.min(note.length, index + token.length + radius));
  return (start > 0 ? "…" : "") + note.slice(start, end).replace(/\s+/g, " ") + (end < note.length ? "…" : "");
}

// 比勘時標示史料來源：優先取引文註釋中的第一個書名，其次是出處開頭，沒有出處才用摘要。
function shortSourceLabel(entry: Entry): string {
  const citation = entry.citation.trim();
  return (
    citation.match(/《[^》\n]+》/)?.[0] ??
    summarize(citation || entry.summary || entry.timeText || "未命名史料", 12)
  );
}

function loadStoredInteger(key: string, min: number, max: number, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    // 未保存過時用默認值；Number(null) 會得到 0，不能直接轉換。
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// 相似度各項指標的文字說明，用於滑鼠懸停提示。first 為比較對象（或總覽中的左條）。
function describeSimilarMatch(match: SimilarMatch, first = "比較對象", second = "此條"): string {
  const parts = [
    `${first}有 ${formatPercent(match.anchorCoverage)} 的文字落在對齊段落中，${second}有 ${formatPercent(match.candidateCoverage)}。`,
    `對齊段落中相同 ${match.sharedChars} 字，佔段落長度的 ${formatPercent(match.identity)}（其餘爲異文、脫文、衍文）。`,
  ];
  if (match.blocks.length > 1 && match.orderConsistency !== null) {
    parts.push(`共對上 ${match.blocks.length} 段，其中 ${formatPercent(match.orderConsistency)}（按字數）先後次序一致。`);
  }
  parts.push("相似度 = 較高一側的落入比例 × 段內一致率。");
  return parts.join("\n");
}

function findFirstTokenMatch(text: string, tokens: string[]): { index: number; length: number } | null {
  const [first] = findHighlightRanges(text, tokens);
  return first ? { index: first.start, length: first.end - first.start } : null;
}

function hasHighlightMatch(text: string, query: string): boolean {
  return findHighlightRanges(text, buildHighlightTokens(query)).length > 0;
}

// 檢索結果卡上的備註摘錄：標籤已另以標籤顯示，摘錄只取標籤以外的文字。
function noteTextWithoutTags(note: string): string {
  return note.replace(TAG_REGEX, " ").replace(/\s+/g, " ").trim();
}

function summarizeAroundMatch(text: string, query: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= max) {
    return normalized;
  }

  const tokens = buildHighlightTokens(query);
  const match = findFirstTokenMatch(normalized, tokens);
  if (!match) {
    return summarize(normalized, max);
  }

  const safeMax = Math.max(24, max);
  const halfWindow = Math.max(8, Math.floor((safeMax - match.length) / 2));
  let start = Math.max(0, match.index - halfWindow);
  let end = Math.min(normalized.length, match.index + match.length + halfWindow);

  if (end - start < safeMax) {
    const shortfall = safeMax - (end - start);
    const extendLeft = Math.min(start, Math.floor(shortfall / 2));
    start -= extendLeft;
    end = Math.min(normalized.length, end + (shortfall - extendLeft));
  }

  if (end - start < safeMax && start > 0) {
    start = Math.max(0, end - safeMax);
  }
  if (end - start < safeMax && end < normalized.length) {
    end = Math.min(normalized.length, start + safeMax);
  }

  const snippet = normalized.slice(start, end).trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < normalized.length ? "..." : ""}`;
}

function renderHighlightedPlainText(text: string, query: string): string {
  const html = wrapHighlightRanges(text || "", buildHighlightTokens(query));
  return html.replace(/\r?\n/g, "<br />");
}

function renderHighlightedLightMarkup(text: string, query: string): string {
  return applyLightMarkup(wrapHighlightRanges(text || "", buildHighlightTokens(query)));
}

const SEARCH_DEBOUNCE_MS = 160;
const ENTRY_VIRTUAL_ROW_HEIGHT = 256;
const SEARCH_RESULT_VIRTUAL_ROW_HEIGHT = 188;
const ADVANCED_RESULT_VIRTUAL_ROW_HEIGHT = 236;
const VIRTUAL_OVERSCAN_COUNT = 6;
const ENTRY_VIRTUALIZE_THRESHOLD = 80;
const SEARCH_RESULT_VIRTUALIZE_THRESHOLD = 80;
const ADVANCED_RESULT_VIRTUALIZE_THRESHOLD = 80;

type NavigationScope = "entry" | "chapter" | "project" | "search" | "advanced";
type SearchLocationScope = "global" | "project" | "chapter";

type SearchWorkerChannel = "global" | "advanced";

type SearchWorkerRequest =
  | { type: "index"; payload: WorkspaceData }
  | {
      type: "search";
      payload: { requestId: number; channel: SearchWorkerChannel; criteria: SearchCriteria };
    };

type SearchWorkerResponse =
  | {
      type: "result";
      payload: { requestId: number; channel: SearchWorkerChannel; results: SearchResult[] };
    }
  | {
      type: "error";
      payload: { requestId: number; channel: SearchWorkerChannel; message: string };
    };

function useDebouncedValue<T>(value: T, delay = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debounced;
}

function useContainerHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  const element = ref.current;

  useEffect(() => {
    if (!element) {
      setHeight(0);
      return;
    }

    const update = () => setHeight(element.clientHeight);
    update();

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            update();
          })
        : null;
    observer?.observe(element);
    window.addEventListener("resize", update);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [element]);

  return height;
}

interface VirtualRange {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
}

function computeVirtualRange(
  totalCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = VIRTUAL_OVERSCAN_COUNT,
): VirtualRange {
  if (totalCount <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 };
  }

  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewport = Math.max(1, viewportHeight);
  const visibleCount = Math.ceil(safeViewport / rowHeight);
  const maxStart = Math.max(0, totalCount - visibleCount);
  const start = Math.min(maxStart, Math.max(0, Math.floor(safeScrollTop / rowHeight) - overscan));
  const end = Math.min(totalCount, start + visibleCount + overscan * 2);
  const topSpacer = start * rowHeight;
  const bottomSpacer = Math.max(0, (totalCount - end) * rowHeight);
  return { start, end, topSpacer, bottomSpacer };
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceData>(() => loadWorkspace());
  const [appearance, setAppearance] = useState<AppearanceState>(() => loadAppearance());
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [searchLocationScope, setSearchLocationScope] = useState<SearchLocationScope>("global");
  const [sourceFormatState, setSourceFormatState] = useState<SourceFormatState>(
    EMPTY_SOURCE_FORMAT_STATE,
  );
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [navigationScope, setNavigationScope] = useState<NavigationScope>("entry");
  const [modalOffsets, setModalOffsets] = useState<Record<string, { x: number; y: number }>>({});
  // 鍵為固定彈窗名，或檢視窗的 view:<winId>。
  const [modalOrders, setModalOrders] = useState<Record<string, number>>(() => createOverlayModalMap(0));
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [advancedResults, setAdvancedResults] = useState<SearchResult[]>([]);
  const [selectedSearchResultEntryId, setSelectedSearchResultEntryId] = useState<string | null>(null);
  const [selectedAdvancedResultEntryId, setSelectedAdvancedResultEntryId] = useState<string | null>(null);
  const [entryListScrollTop, setEntryListScrollTop] = useState(0);
  const [searchResultsScrollTop, setSearchResultsScrollTop] = useState(0);
  const [advancedResultsScrollTop, setAdvancedResultsScrollTop] = useState(0);
  const [entryHighlightContext, setEntryHighlightContext] = useState<{
    entryId: string;
    query: string;
  } | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>("active");
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [expandedChapterIds, setExpandedChapterIds] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>(() =>
    window.workspaceBridge?.saveSharedWorkspace ? "saved" : "local",
  );
  const [modalState, setModalState] = useState<ModalState>(null);
  const [entryViews, setEntryViews] = useState<EntryViewWindow[]>([]);
  const entryViewsRef = useRef(entryViews);
  entryViewsRef.current = entryViews;
  // 剛打開或提到最前的檢視窗：渲染後把焦點移進去（Esc 才會關到它）。
  const pendingViewFocusRef = useRef<string | null>(null);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>("search");
  const [similarAnchorEntryId, setSimilarAnchorEntryId] = useState<string | null>(null);
  const [compareState, setCompareState] = useState<CompareState | null>(null);
  const [compareMarkMode, setCompareMarkMode] = useState<CompareMarkMode>(loadCompareMarkMode);
  const [compareScope, setCompareScope] = useState<CompareScope>(loadCompareScope);
  const [readingFontSize, setReadingFontSize] = useState(() =>
    loadStoredInteger(READING_FONT_KEY, READING_FONT_MIN, READING_FONT_MAX, READING_FONT_DEFAULT),
  );
  const [similarGramSize, setSimilarGramSize] = useState(() =>
    loadStoredInteger(SIMILAR_GRAM_KEY, MIN_GRAM_SIZE, MAX_GRAM_SIZE, DEFAULT_GRAM_SIZE),
  );
  const [similarStrict, setSimilarStrict] = useState(() => loadStoredInteger(SIMILAR_STRICT_KEY, 0, 1, 0) === 1);
  const [similarMaxGap, setSimilarMaxGap] = useState(() =>
    loadStoredInteger(SIMILAR_MAX_GAP_KEY, MIN_MAX_GAP, MAX_MAX_GAP, DEFAULT_MAX_GAP),
  );
  const [openSimilarRule, setOpenSimilarRule] = useState<{ place: SimilarRulePlace; key: SimilarRuleKey } | null>(
    null,
  );
  const [similarMinBlock, setSimilarMinBlock] = useState(() =>
    loadStoredInteger(SIMILAR_MIN_BLOCK_KEY, MIN_MIN_BLOCK_CHARS, MAX_MIN_BLOCK_CHARS, DEFAULT_MIN_BLOCK_CHARS),
  );
  const [similarMinShared, setSimilarMinShared] = useState(() =>
    loadStoredInteger(SIMILAR_MIN_SHARED_KEY, MIN_MIN_SHARED_CHARS, MAX_MIN_SHARED_CHARS, DEFAULT_MIN_SHARED_CHARS),
  );
  const [similarIgnoreFrequent, setSimilarIgnoreFrequent] = useState(
    () => loadStoredInteger(SIMILAR_IGNORE_FREQUENT_KEY, 0, 1, 1) === 1,
  );
  const [similarMinOrder, setSimilarMinOrder] = useState(() =>
    loadStoredInteger(SIMILAR_MIN_ORDER_KEY, 0, 100, SIMILAR_MIN_ORDER_DEFAULT),
  );
  const [similarOverviewOpen, setSimilarOverviewOpen] = useState(false);
  const [similarOverviewFilter, setSimilarOverviewFilter] = useState({
    minScore: 0,
    hideCopies: true,
    crossChapterOnly: false,
    sortBy: "score" as "score" | "shared" | "order",
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [sharedSyncReady, setSharedSyncReady] = useState<boolean>(
    () => !window.workspaceBridge?.loadSharedWorkspace,
  );
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [trashModalOpen, setTrashModalOpen] = useState(false);
  const [storageSaveAsModalOpen, setStorageSaveAsModalOpen] = useState(false);
  const [storageFormatInfoModalOpen, setStorageFormatInfoModalOpen] = useState(false);
  const [storageInfo, setStorageInfo] = useState<WorkspaceStorageInfo | null>(null);
  const [storagePathDraft, setStoragePathDraft] = useState("");
  const [storageStatus, setStorageStatus] = useState("");
  const [storageBusy, setStorageBusy] = useState(false);
  const [mergeModal, setMergeModal] = useState<MergeModalState>({
    open: false,
    mode: "as-new",
    selectedProjectIds: [],
    newProjectTitle: "合併專案",
  });
  const [advancedModal, setAdvancedModal] = useState<AdvancedSearchModalState>({
    open: false,
    query: "",
    queryScopes: DEFAULT_ADVANCED_QUERY_SCOPES,
    tag: "",
    citationTitle: "",
    targetMode: "new-project",
    newProjectTitle: "按檢索結果分類",
    newChapterTitle: "檢索結果",
    existingProjectId: workspace.activeProjectId ?? workspace.projectOrder[0] ?? "",
    existingChapterId: "",
  });
  const [chapterMergeModal, setChapterMergeModal] = useState<ChapterMergeModalState>({
    open: false,
    selectedChapterIds: [],
    targetProjectId: workspace.activeProjectId ?? workspace.projectOrder[0] ?? "",
    newChapterTitle: "合併章節",
  });
  const [isSearchPending, startSearchTransition] = useTransition();
  const [nativeSearchAvailable, setNativeSearchAvailable] = useState<boolean>(
    () => Boolean(window.searchBridge?.query),
  );

  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const entrySourceTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const leftPaneScrollRef = useRef<HTMLDivElement | null>(null);
  const centerPaneScrollRef = useRef<HTMLElement | null>(null);
  const rightPaneScrollRef = useRef<HTMLElement | null>(null);
  const searchResultsRef = useRef<HTMLDivElement | null>(null);
  const advancedResultsRef = useRef<HTMLDivElement | null>(null);
  const searchWorkerRef = useRef<Worker | null>(null);
  const globalSearchRequestRef = useRef(0);
  const advancedSearchRequestRef = useRef(0);
  const chapterSelectionAnchorRef = useRef<string | null>(null);
  const entrySelectionAnchorRef = useRef<string | null>(null);
  const modalDragStateRef = useRef<ModalDragState | null>(null);
  // 從相似列表跳到某條時，不改變「與哪一條比較」的錨點。
  const keepSimilarAnchorRef = useRef(false);
  const modalOrderCounterRef = useRef(0);
  const modalOpenStateRef = useRef<Record<string, boolean>>(createOverlayModalMap(false));
  const previousFocusedElementRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef(workspace);
  const sharedRevisionRef = useRef(workspace.revision);
  // useRef 的參數每次渲染都會求值；簽名要序列化整個工作區，只在首次渲染時算一次。
  const [initialPersistedSignature] = useState(() =>
    localWorkspaceNeedsSave ? "" : workspaceContentSignature(workspace),
  );
  const lastPersistedSignatureRef = useRef(initialPersistedSignature);
  const workspaceSaveTimerRef = useRef<number | null>(null);
  const workspaceSaveInFlightRef = useRef(false);
  const workspaceSaveQueuedRef = useRef(false);
  workspaceRef.current = workspace;
  const modalOrdersRef = useRef(modalOrders);
  modalOrdersRef.current = modalOrders;
  const modalStateRef = useRef(modalState);
  modalStateRef.current = modalState;

  const activeProject = workspace.activeProjectId
    ? workspace.projects[workspace.activeProjectId] ?? null
    : null;
  const activeChapter = workspace.activeChapterId
    ? workspace.chapters[workspace.activeChapterId] ?? null
    : null;

  const currentEntryIds = useMemo(() => activeEntryIds(workspace), [workspace]);
  const currentEntries = useMemo(
    () => currentEntryIds.map((entryId) => workspace.entries[entryId]).filter(Boolean) as Entry[],
    [currentEntryIds, workspace.entries],
  );

  const selectedEntry = workspace.selectedEntryId
    ? workspace.entries[workspace.selectedEntryId] ?? null
    : null;
  const selectedChapterIdSet = useMemo(() => new Set(selectedChapterIds), [selectedChapterIds]);
  const selectedEntryIdSet = useMemo(() => new Set(selectedEntryIds), [selectedEntryIds]);
  const chapterSelectionForMenu = useMemo(() => {
    if (!contextMenu || contextMenu.kind !== "chapter") {
      return [];
    }
    if (selectedChapterIdSet.has(contextMenu.chapterId)) {
      return selectedChapterIds.filter((chapterId) => Boolean(workspace.chapters[chapterId]));
    }
    return workspace.chapters[contextMenu.chapterId] ? [contextMenu.chapterId] : [];
  }, [contextMenu, selectedChapterIdSet, selectedChapterIds, workspace.chapters]);
  const entrySelectionForMenu = useMemo(() => {
    if (!contextMenu || contextMenu.kind !== "entry") {
      return [];
    }
    if (selectedEntryIdSet.has(contextMenu.entryId)) {
      return selectedEntryIds.filter((entryId) => Boolean(workspace.entries[entryId]));
    }
    return workspace.entries[contextMenu.entryId] ? [contextMenu.entryId] : [];
  }, [contextMenu, selectedEntryIdSet, selectedEntryIds, workspace.entries]);

  const allTags = useMemo(() => {
    const seen = new Set<string>();
    const tags: string[] = [];

    for (const entry of Object.values(workspace.entries)) {
      for (const tag of extractTags(entry.note)) {
        const key = tag.toLocaleLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        tags.push(tag);
      }
    }

    return tags.sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [workspace.entries]);

  useEffect(() => {
    if (
      advancedModal.tag &&
      !allTags.some((tag) => tag.toLocaleLowerCase() === advancedModal.tag.toLocaleLowerCase())
    ) {
      setAdvancedModal((state) => ({ ...state, tag: "" }));
    }
  }, [advancedModal.tag, allTags]);

  useEffect(() => {
    if (searchLocationScope === "project" && !activeProject) {
      setSearchLocationScope("global");
    } else if (searchLocationScope === "chapter" && !activeChapter) {
      setSearchLocationScope(activeProject ? "project" : "global");
    }
  }, [activeChapter, activeProject, searchLocationScope]);

  useEffect(() => {
    setSelectedChapterIds((previous) => {
      const next = previous.filter((chapterId) => Boolean(workspace.chapters[chapterId]));
      return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next;
    });
    setSelectedEntryIds((previous) => {
      const next = previous.filter((entryId) => Boolean(workspace.entries[entryId]));
      return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next;
    });
  }, [workspace.chapters, workspace.entries]);

  useEffect(() => {
    setCollapsedProjectIds((previous) =>
      previous.filter((projectId) => Boolean(workspace.projects[projectId])),
    );
    setExpandedChapterIds((previous) =>
      previous.filter((chapterId) => Boolean(workspace.chapters[chapterId])),
    );
  }, [workspace.chapters, workspace.projects]);

  useEffect(() => {
    if (!workspaceMenuOpen) {
      return undefined;
    }

    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && workspaceMenuRef.current?.contains(target)) {
        return;
      }
      setWorkspaceMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuOpen]);

  useEffect(() => {
    const fallbackProjectId = workspace.activeProjectId ?? workspace.projectOrder[0] ?? "";
    setAdvancedModal((state) => {
      if (!state.open) {
        return state;
      }

      const projectId =
        state.existingProjectId && workspace.projects[state.existingProjectId]
          ? state.existingProjectId
          : fallbackProjectId;
      const chapterId =
        state.existingChapterId &&
        workspace.chapters[state.existingChapterId] &&
        workspace.chapters[state.existingChapterId].projectId === projectId
          ? state.existingChapterId
          : workspace.projects[projectId]?.chapterIds[0] ?? "";

      if (projectId === state.existingProjectId && chapterId === state.existingChapterId) {
        return state;
      }

      return {
        ...state,
        existingProjectId: projectId,
        existingChapterId: chapterId,
      };
    });

    setChapterMergeModal((state) => {
      if (!state.open) {
        return state;
      }

      const projectId =
        state.targetProjectId && workspace.projects[state.targetProjectId]
          ? state.targetProjectId
          : fallbackProjectId;
      const selectedChapterIds = state.selectedChapterIds.filter((chapterId) =>
        Boolean(workspace.chapters[chapterId]),
      );

      if (
        projectId === state.targetProjectId &&
        selectedChapterIds.length === state.selectedChapterIds.length
      ) {
        return state;
      }

      return {
        ...state,
        targetProjectId: projectId,
        selectedChapterIds,
      };
    });
  }, [workspace]);

  useEffect(() => {
    if (!advancedModal.open && navigationScope === "advanced") {
      setNavigationScope("search");
    }
  }, [advancedModal.open, navigationScope]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent): void {
      const dragState = modalDragStateRef.current;
      if (!dragState) {
        return;
      }
      const nextX = Math.min(
        dragState.maxX,
        Math.max(dragState.minX, dragState.originX + (event.clientX - dragState.startX)),
      );
      const nextY = Math.min(
        dragState.maxY,
        Math.max(dragState.minY, dragState.originY + (event.clientY - dragState.startY)),
      );
      setModalOffsets((previous) => {
        const current = previous[dragState.key] ?? { x: 0, y: 0 };
        if (current.x === nextX && current.y === nextY) {
          return previous;
        }
        return {
          ...previous,
          [dragState.key]: { x: nextX, y: nextY },
        };
      });
    }

    function handlePointerRelease(): void {
      modalDragStateRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerRelease);
    window.addEventListener("pointercancel", handlePointerRelease);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerRelease);
      window.removeEventListener("pointercancel", handlePointerRelease);
    };
  }, []);

  useEffect(() => {
    const elements = [
      leftPaneScrollRef.current,
      centerPaneScrollRef.current,
      rightPaneScrollRef.current,
      searchResultsRef.current,
      advancedResultsRef.current,
    ].filter((node): node is HTMLElement => Boolean(node));
    if (elements.length === 0) {
      return;
    }

    const timers = new Map<HTMLElement, number>();
    const listeners: Array<{ element: HTMLElement; handleScroll: () => void }> = [];

    for (const element of elements) {
      const handleScroll = () => {
        element.dataset.scrolling = "true";
        const activeTimer = timers.get(element);
        if (activeTimer) {
          window.clearTimeout(activeTimer);
        }
        const timer = window.setTimeout(() => {
          delete element.dataset.scrolling;
          timers.delete(element);
        }, 680);
        timers.set(element, timer);
      };

      element.addEventListener("scroll", handleScroll, { passive: true });
      listeners.push({ element, handleScroll });
    }

    return () => {
      for (const { element, handleScroll } of listeners) {
        element.removeEventListener("scroll", handleScroll);
        delete element.dataset.scrolling;
      }
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
    };
  }, [advancedModal.open]);

  const contentSignature = useMemo(
    () => workspaceContentSignature(workspace),
    [workspace.projectOrder, workspace.projects, workspace.chapters, workspace.entries],
  );

  const debouncedGlobalQuery = useDebouncedValue(globalQuery);
  const debouncedAdvancedQuery = useDebouncedValue(advancedModal.query);
  const debouncedAdvancedTag = useDebouncedValue(advancedModal.tag);

  const deferredGlobalQuery = useDeferredValue(debouncedGlobalQuery);
  const deferredAdvancedQuery = useDeferredValue(debouncedAdvancedQuery);
  const deferredAdvancedTag = useDeferredValue(debouncedAdvancedTag);
  const deferredAdvancedQueryScopes = useDeferredValue(advancedModal.queryScopes);

  const hasSearch = Boolean(deferredGlobalQuery.trim());
  const searchHighlightQuery = globalQuery.trim();
  const advancedHighlightQuery =
    advancedModal.query.trim() || normalizeTagInput(advancedModal.tag);
  const centerEntryHighlightQuery = advancedModal.open
    ? advancedHighlightQuery
    : searchHighlightQuery;

  useEffect(() => {
    const selectedId = workspace.selectedEntryId;
    if (keepSimilarAnchorRef.current) {
      keepSimilarAnchorRef.current = false;
      return;
    }
    if (selectedId) {
      setSimilarAnchorEntryId(selectedId);
    }
  }, [workspace.selectedEntryId]);

  // 相似文本在背景線程計算（見 similarity-worker.ts）：界面只送出改動過的原文，收回結果。
  const similarOptions = useMemo(
    () => ({
      gramSize: similarGramSize,
      minBlockChars: similarMinBlock,
      minSharedChars: similarMinShared,
      maxGap: similarMaxGap,
      strict: similarStrict,
      minOrderConsistency: similarMinOrder / 100,
      ignoreFrequentFragments: similarIgnoreFrequent,
    }),
    [
      similarGramSize,
      similarMinBlock,
      similarMinShared,
      similarMaxGap,
      similarStrict,
      similarMinOrder,
      similarIgnoreFrequent,
    ],
  );
  const similarityWorkerRef = useRef<Worker | null>(null);
  // 已送進背景線程的各條原文與規則，用來算出這次要送的增量。
  const similaritySentTextsRef = useRef(new Map<string, string>());
  const similaritySentOptionsRef = useRef<typeof similarOptions | null>(null);
  const similarPairsRequestRef = useRef(0);
  const similarAnchorRequestRef = useRef(0);
  // 每送一次增量加一，右欄據此重新查詢當前條目的相似文本。
  const [similarityVersion, setSimilarityVersion] = useState(0);
  const [similarPairs, setSimilarPairs] = useState<SimilarPairResult[]>([]);
  const [frequentFragments, setFrequentFragments] = useState<FrequentFragment[]>([]);
  const [similarAnchorResult, setSimilarAnchorResult] = useState<{
    anchorId: string;
    matches: SimilarMatch[];
  } | null>(null);

  useEffect(() => {
    if (typeof Worker === "undefined") {
      return;
    }
    const worker = new Worker(new URL("./similarity-worker.ts", import.meta.url), { type: "module" });
    similarityWorkerRef.current = worker;
    const handleMessage = (event: MessageEvent<SimilarityWorkerResponse>) => {
      const message = event.data;
      if (message?.type === "pairs" && message.requestId === similarPairsRequestRef.current) {
        setSimilarPairs(message.pairs);
        setFrequentFragments(message.frequentFragments);
      } else if (message?.type === "similar" && message.requestId === similarAnchorRequestRef.current) {
        setSimilarAnchorResult({ anchorId: message.anchorId, matches: message.matches });
        setFrequentFragments(message.frequentFragments);
      }
    };
    worker.addEventListener("message", handleMessage);
    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      similarityWorkerRef.current = null;
      // 線程重建後須重新送全部原文。
      similaritySentTextsRef.current = new Map();
      similaritySentOptionsRef.current = null;
    };
  }, []);

  // 停止改動片刻後，把改過的原文送去重算；改章名、排序等不動原文的操作不觸發計算。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const worker = similarityWorkerRef.current;
      if (!worker) {
        return;
      }
      const sent = similaritySentTextsRef.current;
      const upserts: Array<{ id: string; text: string }> = [];
      const removes: string[] = [];
      for (const entry of Object.values(workspace.entries)) {
        if (sent.get(entry.id) !== entry.sourceText) {
          upserts.push({ id: entry.id, text: entry.sourceText });
        }
      }
      for (const id of sent.keys()) {
        if (!workspace.entries[id]) {
          removes.push(id);
        }
      }
      if (!upserts.length && !removes.length && similaritySentOptionsRef.current === similarOptions) {
        return;
      }
      for (const { id, text } of upserts) {
        sent.set(id, text);
      }
      for (const id of removes) {
        sent.delete(id);
      }
      similaritySentOptionsRef.current = similarOptions;
      const sync: SimilarityWorkerRequest = { type: "sync", upserts, removes, options: similarOptions };
      worker.postMessage(sync);
      similarPairsRequestRef.current += 1;
      const request: SimilarityWorkerRequest = { type: "pairs", requestId: similarPairsRequestRef.current };
      worker.postMessage(request);
      setSimilarityVersion((version) => version + 1);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [workspace.entries, similarOptions]);

  // 全庫每條的相似文本，供卡片與檢視窗顯示提示。
  const similarSummary = useMemo(() => {
    const summary = new Map<string, SimilarSummaryItem[]>();
    const add = (fromId: string, item: SimilarSummaryItem) => {
      const list = summary.get(fromId);
      if (list) {
        list.push(item);
      } else {
        summary.set(fromId, [item]);
      }
    };
    for (const { aId, bId, match, copy } of similarPairs) {
      const shared = { score: match.score, sharedChars: match.sharedChars, identity: match.identity, copy };
      add(aId, { entryId: bId, ...shared });
      add(bId, { entryId: aId, ...shared });
    }
    // 相似的排前面，完全相同的副本排在後面。
    for (const list of summary.values()) {
      list.sort((x, y) => Number(x.copy) - Number(y.copy) || y.score - x.score);
    }
    return summary;
  }, [similarPairs]);

  function renderSimilarBadge(entryId: string, onActivate: () => void, hint: string) {
    const list = similarSummary.get(entryId);
    if (!list?.length) {
      return null;
    }
    const copies = list.filter((item) => item.copy).length;
    const best = Math.max(...list.map((item) => item.score));
    return (
      <button
        type="button"
        className={best >= 0.8 ? "similar-badge is-strong" : "similar-badge"}
        title={`有 ${list.length} 條相似文本${copies ? `（其中 ${copies} 條完全相同）` : ""}，最高相似度 ${formatPercent(best)}。${hint}`}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {SIMILAR_ICON}
        <span>相似</span>
        <strong>{list.length}</strong>
      </button>
    );
  }

  // 編號 → 條目；條目 → 在備註中鏈接到它的條目（不含自引）。
  const entryByRefId = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const entry of Object.values(workspace.entries)) {
      map.set(entry.refId, entry);
    }
    return map;
  }, [workspace.entries]);
  const backlinksByRefId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of Object.values(workspace.entries)) {
      for (const refId of collectEntryRefs(entry.note)) {
        if (refId === entry.refId) {
          continue;
        }
        const list = map.get(refId);
        if (list) {
          list.push(entry.id);
        } else {
          map.set(refId, [entry.id]);
        }
      }
    }
    return map;
  }, [workspace.entries]);

  // 「複製鏈接」後按鈕短暫顯示「已複製」。
  const [copiedRefKey, setCopiedRefKey] = useState<string | null>(null);
  const copiedRefTimerRef = useRef<number | null>(null);
  async function copyEntryRefs(entryIds: string[], feedbackKey: string): Promise<void> {
    const tokens = entryIds
      .map((entryId) => workspace.entries[entryId]?.refId)
      .filter((refId): refId is string => Boolean(refId))
      .map(entryRefToken);
    if (tokens.length === 0 || !(await writeTextToClipboard(tokens.join("、")))) {
      return;
    }
    setCopiedRefKey(feedbackKey);
    if (copiedRefTimerRef.current) {
      window.clearTimeout(copiedRefTimerRef.current);
    }
    copiedRefTimerRef.current = window.setTimeout(() => setCopiedRefKey(null), 1600);
  }

  // 備註中的 [[編號]] 畫成連結：顯示目標的標題；找不到時灰顯。
  function renderNoteWithRefs(note: string, highlightQuery: string): string {
    return splitEntryRefs(note)
      .map((part, index) => {
        if (index % 2 === 0) {
          return part ? renderHighlightedPlainText(part, highlightQuery) : "";
        }
        const target = entryByRefId.get(part);
        if (!target) {
          return `<span class="entry-ref is-missing" title="找不到編號 ${part} 的條目（可能已刪除）">${ENTRY_REF_ICON}<span>${part}</span></span>`;
        }
        const headline = formatEntryHeadline(target.timeText, target.summary ?? "");
        const path = `${workspace.projects[target.projectId]?.title ?? "未命名專案"} / ${workspace.chapters[target.chapterId]?.title ?? "未命名章節"}`;
        return `<a href="#" class="entry-ref" data-entry-ref="${part}" title="${escapeHtml(`${headline}\n${path}\n編號 ${part}・點擊檢視`)}">${ENTRY_REF_ICON}<span>${escapeHtml(summarize(headline, 18))}</span></a>`;
      })
      .join("");
  }

  // 打開鏈接的條目：另開一個檢視窗（已打開就提到最前），可與原窗並排對照。
  function openEntryRef(refId: string): void {
    const target = entryByRefId.get(refId);
    if (target) {
      beginViewEntry(target.id);
    }
  }

  // 事件委派：點擊 dangerouslySetInnerHTML 中的鏈接。
  function handleEntryRefClick(event: MouseEvent<HTMLElement>): void {
    const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-entry-ref]") : null;
    if (!link?.dataset.entryRef) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openEntryRef(link.dataset.entryRef);
  }

  function stopDoubleClickOnEntryRef(event: MouseEvent<HTMLElement>): void {
    if (event.target instanceof Element && event.target.closest("[data-entry-ref]")) {
      event.stopPropagation();
    }
  }

  // 從比勘窗打開某條的檢視窗：疊在比勘窗之上，關閉後回到比勘。
  function viewEntryFromCompare(entryId: string): void {
    beginViewEntry(entryId);
  }

  // 目前生效的比對規則，以標籤形式顯示在相似文本頁與總覽窗頂部；點選標籤即可調整。
  const similarRuleDefs: Array<{ key: SimilarRuleKey; label: string; changed: boolean }> = [
    {
      key: "fold",
      label: similarStrict ? "去標點・區分繁簡" : "去標點・繁簡歸一",
      changed: similarStrict,
    },
    {
      key: "gram",
      label: `${similarGramSize} 字相同處起對`,
      changed: similarGramSize !== DEFAULT_GRAM_SIZE,
    },
    {
      key: "gap",
      label: `相異逾 ${similarMaxGap} 字即分段`,
      changed: similarMaxGap !== DEFAULT_MAX_GAP,
    },
    {
      key: "length",
      label:
        similarMinShared > similarMinBlock
          ? `每段 ${similarMinBlock} 字・合計 ${similarMinShared} 字`
          : `每段至少 ${similarMinBlock} 字`,
      changed: similarMinBlock !== DEFAULT_MIN_BLOCK_CHARS || similarMinShared !== DEFAULT_MIN_SHARED_CHARS,
    },
    {
      key: "order",
      label: similarMinOrder > 0 ? `語序一致 ≥ ${similarMinOrder}%` : "語序不限",
      changed: similarMinOrder !== SIMILAR_MIN_ORDER_DEFAULT,
    },
    {
      key: "frequent",
      label: similarIgnoreFrequent
        ? `忽略高頻片段 ${frequentFragments.length} 個`
        : "不忽略高頻片段",
      changed: !similarIgnoreFrequent,
    },
  ];
  const similarRulesChanged = similarRuleDefs.some((rule) => rule.changed);

  function resetSimilarRules(): void {
    setSimilarStrict(false);
    setSimilarGramSize(DEFAULT_GRAM_SIZE);
    setSimilarMaxGap(DEFAULT_MAX_GAP);
    setSimilarMinBlock(DEFAULT_MIN_BLOCK_CHARS);
    setSimilarMinShared(DEFAULT_MIN_SHARED_CHARS);
    setSimilarMinOrder(SIMILAR_MIN_ORDER_DEFAULT);
    setSimilarIgnoreFrequent(true);
  }

  // 一組互斥選項，樣式同分段按鈕，選項多時自動換行。
  function renderRuleOptions<T extends number | boolean>(
    label: string,
    options: Array<{ value: T; text: string }>,
    current: T,
    onPick: (value: T) => void,
  ) {
    return (
      <div className="segmented segmented-wrap" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={String(option.value)} aria-pressed={option.value === current} onClick={() => onPick(option.value)}>
            {option.text}
          </button>
        ))}
      </div>
    );
  }

  function renderSimilarRuleEditor(key: SimilarRuleKey) {
    const counts = (values: number[]) => values.map((value) => ({ value, text: String(value) }));
    switch (key) {
      case "fold":
        return (
          <>
            {renderRuleOptions(
              "字形",
              [
                { value: false, text: "繁簡歸一" },
                { value: true, text: "區分繁簡" },
              ],
              similarStrict,
              setSimilarStrict,
            )}
            <p className="rule-editor-note">
              標點、空白和粗體等標記一律不計；□、■ 缺字符號照常算一個字。歸一時，繁體、簡體與舊字形（如爲/為）視爲同一字。
            </p>
          </>
        );
      case "gram":
        return (
          <>
            {renderRuleOptions(
              "起對字數",
              SIMILAR_GRAM_OPTIONS.map((value) => ({ value, text: `${value} 字` })),
              similarGramSize,
              setSimilarGramSize,
            )}
            <p className="rule-editor-note">
              兩條至少有連續這麼多字相同，才從那裏開始逐字對齊。字數越少，越能找到異文密集的轉引；越多越嚴格。默認 {DEFAULT_GRAM_SIZE} 字。
            </p>
          </>
        );
      case "gap":
        return (
          <>
            {renderRuleOptions(
              "分段門檻",
              SIMILAR_MAX_GAP_OPTIONS.map((value) => ({ value, text: `${value} 字` })),
              similarMaxGap,
              setSimilarMaxGap,
            )}
            <p className="rule-editor-note">
              逐字對齊時，異文、脫文、衍文累計比相同的字多出這麼多，就斷成兩段。調小則段落更緊湊；調大可把中間夾了長段異文的引文連成一段。默認 {DEFAULT_MAX_GAP} 字。
            </p>
          </>
        );
      case "length":
        return (
          <>
            <div className="rule-editor-row">
              <span className="control-label">每段至少</span>
              {renderRuleOptions("每段至少相同字數", counts(SIMILAR_MIN_BLOCK_OPTIONS), similarMinBlock, setSimilarMinBlock)}
            </div>
            <div className="rule-editor-row">
              <span className="control-label">合計至少</span>
              {renderRuleOptions("合計至少相同字數", counts(SIMILAR_MIN_SHARED_OPTIONS), similarMinShared, setSimilarMinShared)}
            </div>
            <p className="rule-editor-note">
              每段：連成一段的文字中至少要有這麼多字相同才算數；調低到 4–6 字可找回零散的短句重合，但官名、套語也會混進來。合計：各段相同字數加起來至少這麼多才列出。默認都是 {DEFAULT_MIN_BLOCK_CHARS} 字。
            </p>
          </>
        );
      case "order":
        return (
          <>
            {renderRuleOptions(
              "語序一致下限",
              SIMILAR_MIN_ORDER_OPTIONS.map((value) => ({ value, text: value === 0 ? "不限" : `${value}%` })),
              similarMinOrder,
              setSimilarMinOrder,
            )}
            <p className="rule-editor-note">
              對上多段時，各段在兩條中先後次序相同的比例（按字數計）。節錄、轉引通常保持原文次序；次序打亂的多是零散詞語重合。只對上一段時無從比較，照常列出。
            </p>
          </>
        );
      case "frequent":
        return (
          <>
            {renderRuleOptions(
              "高頻片段",
              [
                { value: true, text: "忽略" },
                { value: false, text: "不忽略" },
              ],
              similarIgnoreFrequent,
              setSimilarIgnoreFrequent,
            )}
            <p className="rule-editor-note">
              出現在超過 {Math.round(FREQUENT_FRAGMENT_SHARE * 100)}% 條目、且多於 {FREQUENT_FRAGMENT_MIN_ENTRIES}{" "}
              條的片段（多爲紀年、套語），不作爲起對的依據。
              {frequentFragments.length > 0
                ? `目前有 ${frequentFragments.length} 個：`
                : "目前沒有。"}
            </p>
            {frequentFragments.length > 0 && (
              <div className="frequent-fragments">
                {frequentFragments.slice(0, 80).map((fragment) => (
                  <span key={fragment.text} className="frequent-fragment" title={`出現在 ${fragment.entryCount} 條中`}>
                    {fragment.text}
                    <small>{fragment.entryCount}</small>
                  </span>
                ))}
              </div>
            )}
          </>
        );
    }
  }

  function renderSimilarRules(place: SimilarRulePlace) {
    const openKey = openSimilarRule?.place === place ? openSimilarRule.key : null;
    const editorId = `similar-rule-editor-${place}`;
    return (
      <div
        className="similar-rules"
        // 在總覽窗的標題列中：別讓點選面板觸發拖動；Esc 先收起面板，不關閉窗口。
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && openKey) {
            event.stopPropagation();
            setOpenSimilarRule(null);
          }
        }}
      >
        <div className="rule-chips" role="group" aria-label="比對規則（點選調整）">
          {similarRuleDefs.map((rule) => (
            <button
              key={rule.key}
              type="button"
              className={rule.changed ? "rule-chip is-changed" : "rule-chip"}
              aria-expanded={openKey === rule.key}
              aria-controls={editorId}
              title={rule.changed ? "已改動，點選調整" : "點選調整"}
              onClick={() => setOpenSimilarRule(openKey === rule.key ? null : { place, key: rule.key })}
            >
              {rule.label}
            </button>
          ))}
          {similarRulesChanged && (
            <button type="button" className="text-link rule-reset" onClick={resetSimilarRules}>
              恢復默認
            </button>
          )}
        </div>
        {openKey && (
          <div className="rule-editor" id={editorId}>
            {renderSimilarRuleEditor(openKey)}
          </div>
        )}
      </div>
    );
  }

  // 全庫相似對：沿用背景線程算好的結果，這裡只做篩選與排序。
  const similarOverview = useMemo(() => {
    if (!similarOverviewOpen) {
      return null;
    }
    const allPairs = similarPairs;
    const copyCount = allPairs.filter((pair) => pair.copy).length;
    const { minScore, hideCopies, crossChapterOnly, sortBy } = similarOverviewFilter;
    const pairs = allPairs
      .filter((pair) => !hideCopies || !pair.copy)
      .filter((pair) => pair.match.score >= minScore)
      .filter(
        (pair) =>
          !crossChapterOnly || workspace.entries[pair.aId]?.chapterId !== workspace.entries[pair.bId]?.chapterId,
      );
    if (sortBy === "shared") {
      pairs.sort((a, b) => b.match.sharedChars - a.match.sharedChars);
    } else if (sortBy === "order") {
      pairs.sort((a, b) => (b.match.orderConsistency ?? -1) - (a.match.orderConsistency ?? -1));
    }
    return { pairs, total: allPairs.length, copyCount };
  }, [similarOverviewOpen, similarPairs, similarOverviewFilter, workspace.entries]);
  const similarAnchorEntry = similarAnchorEntryId ? workspace.entries[similarAnchorEntryId] ?? null : null;

  // 右欄「相似」頁打開時，向背景線程查詢當前條目；原文有改動（version 變）時重查。
  useEffect(() => {
    const worker = similarityWorkerRef.current;
    if (!worker || rightPaneTab !== "similar" || !similarAnchorEntryId) {
      return;
    }
    similarAnchorRequestRef.current += 1;
    const request: SimilarityWorkerRequest = {
      type: "similar",
      requestId: similarAnchorRequestRef.current,
      anchorId: similarAnchorEntryId,
      limit: 30,
    };
    worker.postMessage(request);
  }, [rightPaneTab, similarAnchorEntryId, similarityVersion]);

  const similarMatches = useMemo((): { copies: SimilarMatch[]; similar: SimilarMatch[] } => {
    if (!similarAnchorEntry || similarAnchorResult?.anchorId !== similarAnchorEntry.id) {
      return { copies: [], similar: [] };
    }
    const copies: SimilarMatch[] = [];
    const similar: SimilarMatch[] = [];
    for (const match of similarAnchorResult.matches) {
      if (!workspace.entries[match.entryId]) {
        continue;
      }
      if (workspace.entries[match.entryId].sourceText === similarAnchorEntry.sourceText) {
        copies.push(match);
      } else {
        similar.push(match);
      }
    }
    return { copies, similar };
  }, [similarAnchorResult, similarAnchorEntry, workspace.entries]);

  const compareResult = useMemo(() => {
    if (!compareState) {
      return null;
    }
    const left = workspace.entries[compareState.leftEntryId];
    const right = workspace.entries[compareState.rightEntryId];
    if (!left || !right) {
      return null;
    }
    // 對齊段落沿用「相似文本」的片段長度與每段門檻，與列表中看到的段落一致。
    // 比全文時同樣先對上這些段落（次序顛倒也照樣對上），其餘文字再按先後比較。
    return compareTexts(
      left.sourceText,
      right.sourceText,
      compareState.strict,
      { gramSize: similarGramSize, minBlockChars: similarMinBlock, maxGap: similarMaxGap, strict: similarStrict },
      compareScope === "full",
    );
  }, [compareState, compareScope, similarGramSize, similarMinBlock, similarMaxGap, similarStrict, workspace.entries]);

  // 打開比勘或切換範圍時，兩欄先捲到第一個對齊段落。
  useEffect(() => {
    if (compareResult?.blocks?.length) {
      scrollCompareToBlock(0, "auto");
    }
  }, [compareResult]);

  // 配色與卡片樣式掛在 <html> 上（各套配色的變量定義在 styles.css），彈窗也取用同一套顏色。
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = appearance.theme;
    root.dataset.cardStyle = appearance.cardStyle;
  }, [appearance]);

  useEffect(() => {
    document.documentElement.style.setProperty("--reading-font-size", `${readingFontSize}px`);
    writeLocalStorage(READING_FONT_KEY, readingFontSize);
  }, [readingFontSize]);

  useEffect(() => {
    writeLocalStorage(SIMILAR_GRAM_KEY, similarGramSize);
    writeLocalStorage(SIMILAR_MIN_BLOCK_KEY, similarMinBlock);
    writeLocalStorage(SIMILAR_MAX_GAP_KEY, similarMaxGap);
    writeLocalStorage(SIMILAR_STRICT_KEY, similarStrict ? 1 : 0);
    writeLocalStorage(SIMILAR_MIN_SHARED_KEY, similarMinShared);
    writeLocalStorage(SIMILAR_IGNORE_FREQUENT_KEY, similarIgnoreFrequent ? 1 : 0);
    writeLocalStorage(SIMILAR_MIN_ORDER_KEY, similarMinOrder);
  }, [
    similarGramSize,
    similarMinBlock,
    similarMinShared,
    similarMaxGap,
    similarStrict,
    similarIgnoreFrequent,
    similarMinOrder,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem(COMPARE_MARK_MODE_KEY, compareMarkMode);
      localStorage.setItem(COMPARE_SCOPE_KEY, compareScope);
    } catch {
      // 偏好寫不進去時沿用本次設定即可。
    }
  }, [compareMarkMode, compareScope]);

  const hasAdvancedSearch = Boolean(
    deferredAdvancedQuery.trim() || normalizeTagInput(deferredAdvancedTag),
  );
  const hasAdvancedQueryScope = deferredAdvancedQueryScopes.length > 0;
  const entryListViewportHeight = useContainerHeight(centerPaneScrollRef);
  const searchResultsViewportHeight = useContainerHeight(searchResultsRef);
  const advancedResultsViewportHeight = useContainerHeight(advancedResultsRef);
  const shouldVirtualizeEntries =
    currentEntries.length > ENTRY_VIRTUALIZE_THRESHOLD && entryListViewportHeight > 0;
  const shouldVirtualizeSearchResults =
    searchResults.length > SEARCH_RESULT_VIRTUALIZE_THRESHOLD && searchResultsViewportHeight > 0;
  const shouldVirtualizeAdvancedResults =
    advancedResults.length > ADVANCED_RESULT_VIRTUALIZE_THRESHOLD && advancedResultsViewportHeight > 0;

  const entryVirtualRange = useMemo(
    () =>
      shouldVirtualizeEntries
        ? computeVirtualRange(
            currentEntries.length,
            ENTRY_VIRTUAL_ROW_HEIGHT,
            entryListScrollTop,
            entryListViewportHeight,
          )
        : {
            start: 0,
            end: currentEntries.length,
            topSpacer: 0,
            bottomSpacer: 0,
          },
    [
      shouldVirtualizeEntries,
      currentEntries.length,
      entryListScrollTop,
      entryListViewportHeight,
    ],
  );
  const visibleEntries = useMemo(
    () => currentEntries.slice(entryVirtualRange.start, entryVirtualRange.end),
    [currentEntries, entryVirtualRange.end, entryVirtualRange.start],
  );

  const searchVirtualRange = useMemo(
    () =>
      shouldVirtualizeSearchResults
        ? computeVirtualRange(
            searchResults.length,
            SEARCH_RESULT_VIRTUAL_ROW_HEIGHT,
            searchResultsScrollTop,
            searchResultsViewportHeight,
          )
        : {
            start: 0,
            end: searchResults.length,
            topSpacer: 0,
            bottomSpacer: 0,
          },
    [
      shouldVirtualizeSearchResults,
      searchResults.length,
      searchResultsScrollTop,
      searchResultsViewportHeight,
    ],
  );
  const visibleSearchResults = useMemo(
    () => searchResults.slice(searchVirtualRange.start, searchVirtualRange.end),
    [searchResults, searchVirtualRange.end, searchVirtualRange.start],
  );

  const advancedVirtualRange = useMemo(
    () =>
      shouldVirtualizeAdvancedResults
        ? computeVirtualRange(
            advancedResults.length,
            ADVANCED_RESULT_VIRTUAL_ROW_HEIGHT,
            advancedResultsScrollTop,
            advancedResultsViewportHeight,
          )
        : {
            start: 0,
            end: advancedResults.length,
            topSpacer: 0,
            bottomSpacer: 0,
          },
    [
      shouldVirtualizeAdvancedResults,
      advancedResults.length,
      advancedResultsScrollTop,
      advancedResultsViewportHeight,
    ],
  );
  const visibleAdvancedResults = useMemo(
    () => advancedResults.slice(advancedVirtualRange.start, advancedVirtualRange.end),
    [advancedResults, advancedVirtualRange.end, advancedVirtualRange.start],
  );

  useEffect(() => {
    if (!hasSearch || searchResults.length === 0) {
      if (selectedSearchResultEntryId !== null) {
        setSelectedSearchResultEntryId(null);
      }
      return;
    }
    if (!selectedSearchResultEntryId || !searchResults.some((result) => result.entryId === selectedSearchResultEntryId)) {
      setSelectedSearchResultEntryId(searchResults[0].entryId);
    }
  }, [hasSearch, searchResults, selectedSearchResultEntryId]);

  useEffect(() => {
    if (!hasAdvancedSearch || advancedResults.length === 0) {
      if (selectedAdvancedResultEntryId !== null) {
        setSelectedAdvancedResultEntryId(null);
      }
      return;
    }
    if (
      !selectedAdvancedResultEntryId ||
      !advancedResults.some((result) => result.entryId === selectedAdvancedResultEntryId)
    ) {
      setSelectedAdvancedResultEntryId(advancedResults[0].entryId);
    }
  }, [hasAdvancedSearch, advancedResults, selectedAdvancedResultEntryId]);

  async function queryBySqlite(criteria: SearchCriteria): Promise<SearchResult[] | null> {
    if (!nativeSearchAvailable || !window.searchBridge?.query) {
      return null;
    }
    try {
      const result = await window.searchBridge.query({
        ...criteria,
        limit: 2000,
      });
      if (result === null) {
        setNativeSearchAvailable(false);
      }
      return result;
    } catch {
      setNativeSearchAvailable(false);
      return null;
    }
  }

  // 檢索線程只在用不了 SQLite 檢索時（瀏覽器版、或資料庫失效）才建立；桌面版平時不佔這份記憶體。
  useEffect(() => {
    if (typeof Worker === "undefined" || nativeSearchAvailable) {
      searchWorkerRef.current = null;
      return;
    }

    const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
    searchWorkerRef.current = worker;

    const handleMessage = (event: MessageEvent<SearchWorkerResponse>) => {
      const message = event.data;
      if (!message) {
        return;
      }

      if (message.type === "result") {
        const { channel, requestId, results } = message.payload;
        if (channel === "global") {
          if (requestId !== globalSearchRequestRef.current) {
            return;
          }
          startSearchTransition(() => setSearchResults(results));
        } else {
          if (requestId !== advancedSearchRequestRef.current) {
            return;
          }
          startSearchTransition(() => setAdvancedResults(results));
        }
        return;
      }

      const { channel, requestId } = message.payload;
      if (channel === "global" && requestId === globalSearchRequestRef.current) {
        startSearchTransition(() => setSearchResults([]));
      } else if (channel === "advanced" && requestId === advancedSearchRequestRef.current) {
        startSearchTransition(() => setAdvancedResults([]));
      }
    };

    worker.addEventListener("message", handleMessage);
    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      searchWorkerRef.current = null;
    };
  }, [startSearchTransition, nativeSearchAvailable]);

  useEffect(() => {
    const worker = searchWorkerRef.current;
    if (!worker || nativeSearchAvailable) {
      return;
    }
    const request: SearchWorkerRequest = { type: "index", payload: workspaceRef.current };
    worker.postMessage(request);
  }, [contentSignature, nativeSearchAvailable]);

  useEffect(() => {
    const criteria: SearchCriteria = {
      query: deferredGlobalQuery,
      tag: "",
      citationTitle: "",
      projectId:
        searchLocationScope === "project" || searchLocationScope === "chapter"
          ? activeProject?.id
          : undefined,
      chapterId: searchLocationScope === "chapter" ? activeChapter?.id : undefined,
    };

    if (!criteria.query.trim()) {
      startSearchTransition(() => setSearchResults([]));
      return;
    }

    const requestId = globalSearchRequestRef.current + 1;
    globalSearchRequestRef.current = requestId;
    let cancelled = false;

    async function runSearch(): Promise<void> {
      const sqliteResults = await queryBySqlite(criteria);
      if (cancelled || requestId !== globalSearchRequestRef.current) {
        return;
      }
      if (sqliteResults) {
        startSearchTransition(() => setSearchResults(sqliteResults));
        return;
      }

      const worker = searchWorkerRef.current;
      if (worker) {
        const request: SearchWorkerRequest = {
          type: "search",
          payload: {
            requestId,
            channel: "global",
            criteria,
          },
        };
        worker.postMessage(request);
        return;
      }

      const { buildSearchIndex, searchInIndex } = await import("./search-engine");
      const next = searchInIndex(buildSearchIndex(workspaceRef.current), criteria);
      startSearchTransition(() => setSearchResults(next));
    }

    void runSearch();
    return () => {
      cancelled = true;
    };
  }, [
    activeChapter?.id,
    activeProject?.id,
    deferredGlobalQuery,
    nativeSearchAvailable,
    searchLocationScope,
    startSearchTransition,
  ]);

  useEffect(() => {
    const criteria: SearchCriteria = {
      query: deferredAdvancedQuery,
      queryScopes: deferredAdvancedQueryScopes,
      tag: deferredAdvancedTag,
      citationTitle: "",
    };

    if (!criteria.query.trim() && !normalizeTagInput(criteria.tag)) {
      startSearchTransition(() => setAdvancedResults([]));
      return;
    }

    if (criteria.query.trim() && (!criteria.queryScopes || criteria.queryScopes.length === 0)) {
      startSearchTransition(() => setAdvancedResults([]));
      return;
    }

    const requestId = advancedSearchRequestRef.current + 1;
    advancedSearchRequestRef.current = requestId;
    let cancelled = false;

    async function runSearch(): Promise<void> {
      const sqliteResults = await queryBySqlite(criteria);
      if (cancelled || requestId !== advancedSearchRequestRef.current) {
        return;
      }
      if (sqliteResults) {
        startSearchTransition(() => setAdvancedResults(sqliteResults));
        return;
      }

      const worker = searchWorkerRef.current;
      if (worker) {
        const request: SearchWorkerRequest = {
          type: "search",
          payload: {
            requestId,
            channel: "advanced",
            criteria,
          },
        };
        worker.postMessage(request);
        return;
      }

      const { buildSearchIndex, searchInIndex } = await import("./search-engine");
      const next = searchInIndex(buildSearchIndex(workspaceRef.current), criteria);
      startSearchTransition(() => setAdvancedResults(next));
    }

    void runSearch();
    return () => {
      cancelled = true;
    };
  }, [
    deferredAdvancedQuery,
    deferredAdvancedQueryScopes,
    deferredAdvancedTag,
    nativeSearchAvailable,
    startSearchTransition,
  ]);

  useEffect(() => {
    if (!window.workspaceBridge) {
      return;
    }

    let cancelled = false;
    async function loadStorageInfo(): Promise<void> {
      try {
        if (window.workspaceBridge?.getWorkspaceStorageInfo) {
          const info = await window.workspaceBridge.getWorkspaceStorageInfo();
          if (cancelled) {
            return;
          }
          setStorageInfo(info);
          setStoragePathDraft(info.path);
          return;
        }

        if (window.workspaceBridge?.getSharedWorkspacePath) {
          const path = await window.workspaceBridge.getSharedWorkspacePath();
          if (cancelled) {
            return;
          }
          const fallbackInfo: WorkspaceStorageInfo = {
            path,
            defaultPath: path,
            envLocked: false,
            envPath: null,
          };
          setStorageInfo(fallbackInfo);
          setStoragePathDraft(path);
        }
      } catch {
        // Ignore bridge errors and keep modal fallback behavior.
      }
    }

    void loadStorageInfo();
    return () => {
      cancelled = true;
    };
  }, []);

  async function persistLatestWorkspace(): Promise<void> {
    const payload = workspaceRef.current;
    const payloadSignature = workspaceContentSignature(payload);
    const localBackupOk = writeLocalStorage(STORAGE_KEY, payload);
    setStorageStatus((current) => {
      const showingBackupFailure = current.startsWith(LOCAL_BACKUP_FAILED_STATUS);
      if (localBackupOk) {
        return showingBackupFailure ? "" : current;
      }
      return showingBackupFailure ? current : `${LOCAL_BACKUP_FAILED_STATUS}，建議清理回收站或匯出備份。`;
    });

    if (!sharedSyncReady || !window.workspaceBridge?.saveSharedWorkspace) {
      if (!localBackupOk) {
        // 瀏覽器模式下本機備份是唯一的儲存位置。
        setSaveState("error");
        return;
      }
      lastPersistedSignatureRef.current = payloadSignature;
      setSaveState("local");
      return;
    }
    if (payloadSignature === lastPersistedSignatureRef.current) {
      return;
    }
    if (workspaceSaveInFlightRef.current) {
      workspaceSaveQueuedRef.current = true;
      return;
    }

    workspaceSaveInFlightRef.current = true;
    setSaveState("saving");
    let allowQueuedRetry = true;
    try {
      const result = await window.workspaceBridge.saveSharedWorkspace(
        payload,
        sharedRevisionRef.current,
      );
      if (!result.ok) {
        allowQueuedRetry = false;
        workspaceSaveQueuedRef.current = false;
        setStorageStatus(
          result.conflict
            ? `${result.error || "資料已在外部更新"}。本機內容已保留，請先備份後重新載入。`
            : `自動儲存失敗：${result.error || "未知錯誤"}`,
        );
        setSaveState("error");
        return;
      }

      const revision = Number.isInteger(result.revision) ? result.revision : sharedRevisionRef.current;
      sharedRevisionRef.current = revision ?? 0;
      lastPersistedSignatureRef.current = payloadSignature;
      setWorkspace((current) =>
        current.revision === revision ? current : { ...current, revision: revision ?? current.revision },
      );
      setSaveState("saved");
      setStorageStatus((current) => (current.startsWith("自動儲存失敗") ? "已恢復自動儲存。" : current));
    } catch {
      allowQueuedRetry = false;
      setSaveState("error");
      setStorageStatus("自動儲存失敗；本機瀏覽器備份仍已保留。");
    } finally {
      workspaceSaveInFlightRef.current = false;
      const latestSignature = workspaceContentSignature(workspaceRef.current);
      const shouldRetry =
        allowQueuedRetry &&
        (workspaceSaveQueuedRef.current || latestSignature !== lastPersistedSignatureRef.current);
      workspaceSaveQueuedRef.current = false;
      if (shouldRetry) {
        window.setTimeout(() => void persistLatestWorkspace(), 0);
      }
    }
  }

  useEffect(() => {
    if (!window.workspaceBridge?.loadSharedWorkspace) {
      setSharedSyncReady(true);
      return;
    }

    let cancelled = false;
    void window.workspaceBridge
      .loadSharedWorkspace()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setStorageStatus(`資料檔讀取失敗：${result.error || "未知錯誤"}；未覆蓋原檔。`);
          return;
        }
        sharedRevisionRef.current = result.revision ?? 0;
        if (!result.workspace || typeof result.workspace !== "object") {
          lastPersistedSignatureRef.current = "";
          return;
        }
        const next = cleanupWorkspace(result.workspace as WorkspaceData);
        workspaceRef.current = next;
        // 資料檔中原先沒有條目編號時，讀入後寫回一次。
        lastPersistedSignatureRef.current = result.needsSave ? "" : workspaceContentSignature(next);
        setWorkspace(next);
        setSaveState("saved");
      })
      .catch(() => {
        // Ignore bridge errors and keep local storage data.
      })
      .finally(() => {
        if (!cancelled) {
          setSharedSyncReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (contentSignature === lastPersistedSignatureRef.current) {
      return undefined;
    }
    setSaveState(window.workspaceBridge?.saveSharedWorkspace ? "pending" : "local");
    if (workspaceSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveTimerRef.current);
    }
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      workspaceSaveTimerRef.current = null;
      void persistLatestWorkspace();
    }, WORKSPACE_SAVE_DEBOUNCE_MS);
    return () => {
      if (workspaceSaveTimerRef.current !== null) {
        window.clearTimeout(workspaceSaveTimerRef.current);
        workspaceSaveTimerRef.current = null;
      }
    };
  }, [contentSignature, sharedSyncReady]);

  // 關窗或退出前由主程序呼叫：立即寫出去抖中的修改，並等待進行中的存檔完成。
  async function flushPendingWorkspaceSave(): Promise<boolean> {
    if (workspaceSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveTimerRef.current);
      workspaceSaveTimerRef.current = null;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (workspaceSaveInFlightRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        continue;
      }
      if (workspaceContentSignature(workspaceRef.current) === lastPersistedSignatureRef.current) {
        return true;
      }
      await persistLatestWorkspace();
      if (
        !workspaceSaveInFlightRef.current &&
        workspaceContentSignature(workspaceRef.current) !== lastPersistedSignatureRef.current
      ) {
        return false;
      }
    }
    return false;
  }

  useEffect(() => {
    const bridge = window.workspaceBridge;
    if (!sharedSyncReady || !bridge?.onCloseFlushRequest) {
      return undefined;
    }
    return bridge.onCloseFlushRequest(async () => ({
      saved: await flushPendingWorkspaceSave(),
      hasUnsavedDraft:
        hasUnsavedEntryDraft(modalStateRef.current) || entryViewsRef.current.some(hasUnsavedViewDraft),
    }));
  }, [sharedSyncReady]);

  useEffect(() => {
    const bridge = window.workspaceBridge;
    if (!sharedSyncReady || !bridge?.onExternalWorkspaceChanged) {
      return undefined;
    }
    return bridge.onExternalWorkspaceChanged(() => {
      const latestSignature = workspaceContentSignature(workspaceRef.current);
      const hasUnsavedChanges =
        workspaceSaveTimerRef.current !== null ||
        workspaceSaveInFlightRef.current ||
        latestSignature !== lastPersistedSignatureRef.current;
      if (hasUnsavedChanges) {
        setStorageStatus("偵測到外部資料更新，但本機也有未儲存內容；請先備份，再重新載入以處理衝突。");
        return;
      }
      void bridge.loadSharedWorkspace().then((result) => {
        if (!result.ok || !result.workspace || typeof result.workspace !== "object") {
          setStorageStatus(`外部資料更新後讀取失敗：${result.error || "未知錯誤"}`);
          return;
        }
        const next = cleanupWorkspace(result.workspace as WorkspaceData);
        sharedRevisionRef.current = result.revision ?? next.revision;
        lastPersistedSignatureRef.current = result.needsSave ? "" : workspaceContentSignature(next);
        workspaceRef.current = next;
        setWorkspace(next);
        setSaveState("saved");
        setStorageStatus("已載入由 MCP 或其他程序寫入的最新資料。");
      });
    });
  }, [sharedSyncReady]);

  useEffect(() => {
    const flushLocalBackup = () => {
      writeLocalStorage(STORAGE_KEY, workspaceRef.current);
    };
    window.addEventListener("beforeunload", flushLocalBackup);
    return () => window.removeEventListener("beforeunload", flushLocalBackup);
  }, []);

  useEffect(() => {
    writeLocalStorage(APPEARANCE_KEY, appearance);
    if (!window.appearanceBridge?.setAppearance) {
      return;
    }
    void window.appearanceBridge.setAppearance(appearance).catch(() => {
      // Ignore bridge errors and keep local appearance state.
    });
  }, [appearance]);

  useEffect(() => {
    if (!window.appearanceBridge) {
      return;
    }

    let cancelled = false;
    const unsubscribe =
      window.appearanceBridge.onAppearanceChanged?.((next) => {
        if (cancelled) {
          return;
        }
        setAppearance((previous) => normalizeAppearance(next, previous));
      }) ?? null;

    void window.appearanceBridge
      .getAppearance()
      .then((next) => {
        if (cancelled) {
          return;
        }
        setAppearance((previous) => normalizeAppearance(next, previous));
      })
      .catch(() => {
        // Ignore bridge errors and keep local appearance state.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (
        contextMenuRef.current &&
        event.target instanceof Node &&
        contextMenuRef.current.contains(event.target)
      ) {
        return;
      }
      const shouldKeepEntrySelection =
        event.target instanceof Element && Boolean(event.target.closest('[data-keep-entry-selection="true"]'));
      if (event.target instanceof Element && !event.target.closest(".entry-card") && !shouldKeepEntrySelection) {
        setWorkspace((previous) =>
          previous.selectedEntryId
            ? {
                ...previous,
                selectedEntryId: null,
              }
            : previous,
        );
        setSelectedEntryIds([]);
        entrySelectionAnchorRef.current = null;
      }
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // 輸入法組字時的 Esc 只用來取消候選字，不應關閉彈窗。
        if (event.isComposing || event.keyCode === 229) {
          return;
        }
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        // 只關閉最上層的彈窗。
        const openKeys = Object.keys(modalOpenStateRef.current).filter((key) => modalOpenStateRef.current[key]);
        if (openKeys.length > 0) {
          const orders = modalOrdersRef.current;
          const topKey = openKeys.reduce((top, key) => ((orders[key] ?? 0) >= (orders[top] ?? 0) ? key : top));
          // 檢視窗不阻擋主界面：焦點在主界面時按 Esc 不關窗。
          const focusInWindow =
            document.activeElement instanceof Element && Boolean(document.activeElement.closest(".modal-card"));
          if (topKey.startsWith("view:") && !focusInWindow) {
            return;
          }
          event.preventDefault();
          requestCloseOverlayModal(topKey);
        }
        return;
      }

      const isModifierPressed = event.metaKey || event.ctrlKey;
      // ⌘↵：在新增或編輯史料時保存。
      if (isModifierPressed && !event.altKey && event.key === "Enter" && !event.isComposing) {
        const isEditingEntry =
          modalState?.kind === "entry-create" ||
          modalState?.kind === "entry-edit" ||
          entryViewsRef.current.some((win) => win.editing);
        if (isEditingEntry) {
          event.preventDefault();
          applyEntryEditor();
          return;
        }
      }

      const target = event.target instanceof Element ? event.target : null;
      const isTypingTarget = Boolean(
        target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'),
      );
      const isArrowNavigationKey = event.key === "ArrowDown" || event.key === "ArrowUp";
      const key = event.key.toLocaleLowerCase();
      const allowArrowNavigationFromTypingTarget =
        isArrowNavigationKey && (navigationScope === "search" || (navigationScope === "advanced" && advancedModal.open));
      const allowShortcutFromTypingTarget = isModifierPressed && !event.altKey && (key === "f" || key === "n");
      if (isTypingTarget) {
        if (!allowArrowNavigationFromTypingTarget && !allowShortcutFromTypingTarget) {
          return;
        }
      }
      if (modalState || contextMenu) {
        return;
      }
      const isOverlayOpen = OVERLAY_MODAL_KEYS.some((modalKey) => modalOpenStateRef.current[modalKey]);

      if (isModifierPressed && !event.altKey && key === "n") {
        if (!isOverlayOpen && activeProject && activeChapter) {
          event.preventDefault();
          createEntry();
        }
        return;
      }

      if (isModifierPressed && !event.altKey && key === "f") {
        event.preventDefault();
        setAdvancedModal((state) => (state.open ? { ...state, open: false } : state));
        setRightPaneTab("search");
        setNavigationScope("search");
        window.requestAnimationFrame(() => {
          const input = document.getElementById("global-search-input");
          if (input instanceof HTMLInputElement) {
            input.focus();
            input.select();
          }
        });
        return;
      }

      if (isModifierPressed && !event.altKey && key === "c") {
        const selectedText = window.getSelection?.()?.toString().trim() ?? "";
        if (selectedText.length > 0) {
          return;
        }
        if (selectedEntryIds.length > 0) {
          event.preventDefault();
          const orderedEntryIds = currentEntryIds.filter((entryId) => selectedEntryIdSet.has(entryId));
          if (orderedEntryIds.length > 0) {
            copyEntriesToClipboard(orderedEntryIds);
          }
          return;
        }
        if (selectedChapterIds.length > 0 && activeProject) {
          event.preventDefault();
          const orderedChapterIds = activeProject.chapterIds.filter((chapterId) => selectedChapterIdSet.has(chapterId));
          if (orderedChapterIds.length > 0) {
            copyChaptersToClipboard(orderedChapterIds);
          }
          return;
        }
        if (activeChapter) {
          event.preventDefault();
          copyChaptersToClipboard([activeChapter.id]);
          return;
        }
        if (activeProject) {
          event.preventDefault();
          copyCurrentProject(activeProject.id);
        }
        return;
      }

      if (isModifierPressed && !event.altKey && key === "v") {
        if (!clipboard) {
          return;
        }
        if (clipboard.kind === "entry" && activeProject) {
          event.preventDefault();
          pasteEntryFromToolbar();
          return;
        }
        if (clipboard.kind === "chapter" && activeProject) {
          event.preventDefault();
          pasteChapterFromToolbar();
          return;
        }
        if (clipboard.kind === "project") {
          event.preventDefault();
          pasteProjectFromClipboard(activeProject?.id ?? null);
        }
        return;
      }

      if (event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }

      // Enter 檢視、E 編輯、Delete 移入回收站：作用於中欄選中的史料。
      if (!isOverlayOpen && !isTypingTarget) {
        const orderedSelectedIds = currentEntryIds.filter((entryId) => selectedEntryIdSet.has(entryId));
        const focusedEntryId =
          orderedSelectedIds[orderedSelectedIds.length - 1] ??
          (workspace.selectedEntryId && currentEntryIds.includes(workspace.selectedEntryId)
            ? workspace.selectedEntryId
            : null);
        const isOnControl = Boolean(target?.closest("button, a, [role='button']"));
        if (focusedEntryId && event.key === "Enter" && !isOnControl) {
          event.preventDefault();
          beginViewEntry(focusedEntryId, centerEntryHighlightQuery);
          return;
        }
        if (focusedEntryId && key === "e") {
          event.preventDefault();
          beginEditEntry(focusedEntryId, centerEntryHighlightQuery);
          return;
        }
        if (focusedEntryId && (event.key === "Delete" || event.key === "Backspace")) {
          event.preventDefault();
          if (orderedSelectedIds.length > 1) {
            deleteEntriesBatch(orderedSelectedIds);
          } else {
            deleteEntry(focusedEntryId);
          }
          return;
        }
      }

      const isLetterNavigationKey = !isTypingTarget && (key === "j" || key === "k");
      if (!isArrowNavigationKey && !isLetterNavigationKey) {
        return;
      }

      event.preventDefault();
      const delta = event.key === "ArrowDown" || key === "j" ? 1 : -1;
      const moveSelection = (orderedIds: string[], currentId: string | null): string | null => {
        if (orderedIds.length === 0) {
          return null;
        }
        const currentIndex = currentId ? orderedIds.indexOf(currentId) : -1;
        const baseIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : orderedIds.length;
        const nextIndex = Math.min(orderedIds.length - 1, Math.max(0, baseIndex + delta));
        return orderedIds[nextIndex] ?? null;
      };

      if (navigationScope === "advanced" && advancedModal.open && advancedResults.length > 0) {
        const orderedAdvancedEntryIds = advancedResults.map((result) => result.entryId);
        const nextAdvancedEntryId = moveSelection(orderedAdvancedEntryIds, selectedAdvancedResultEntryId);
        if (!nextAdvancedEntryId) {
          return;
        }
        const nextAdvancedResult = advancedResults.find((result) => result.entryId === nextAdvancedEntryId);
        if (!nextAdvancedResult) {
          return;
        }
        setSelectedAdvancedResultEntryId(nextAdvancedEntryId);
        jumpToSearchResult(nextAdvancedResult, advancedHighlightQuery, "advanced");
        window.requestAnimationFrame(() => {
          const node = document.querySelector<HTMLElement>(`[data-advanced-entry-id="${nextAdvancedEntryId}"]`);
          node?.scrollIntoView({ block: "nearest" });
        });
        return;
      }

      if (navigationScope === "search" && !advancedModal.open && searchResults.length > 0) {
        const orderedSearchEntryIds = searchResults.map((result) => result.entryId);
        const nextSearchEntryId = moveSelection(orderedSearchEntryIds, selectedSearchResultEntryId);
        if (!nextSearchEntryId) {
          return;
        }
        const nextSearchResult = searchResults.find((result) => result.entryId === nextSearchEntryId);
        if (!nextSearchResult) {
          return;
        }
        setSelectedSearchResultEntryId(nextSearchEntryId);
        jumpToSearchResult(nextSearchResult, searchHighlightQuery, "search");
        window.requestAnimationFrame(() => {
          const node = document.querySelector<HTMLElement>(`[data-search-entry-id="${nextSearchEntryId}"]`);
          node?.scrollIntoView({ block: "nearest" });
        });
        return;
      }

      if (navigationScope === "entry" && currentEntryIds.length > 0) {
        const orderedSelectedEntryIds = currentEntryIds.filter((entryId) => selectedEntryIdSet.has(entryId));
        const currentId =
          orderedSelectedEntryIds[orderedSelectedEntryIds.length - 1] ??
          (workspace.selectedEntryId && currentEntryIds.includes(workspace.selectedEntryId)
            ? workspace.selectedEntryId
            : null);
        const nextEntryId = moveSelection(currentEntryIds, currentId);
        if (!nextEntryId) {
          return;
        }
        setWorkspace((previous) => ({ ...previous, selectedEntryId: nextEntryId }));
        setSelectedEntryIds([nextEntryId]);
        entrySelectionAnchorRef.current = nextEntryId;
        setNavigationScope("entry");
        window.requestAnimationFrame(() => {
          const node = document.querySelector<HTMLElement>(`[data-entry-id="${nextEntryId}"]`);
          node?.scrollIntoView({ block: "nearest" });
        });
        return;
      }

      if (navigationScope === "chapter" && activeProject) {
        const chapterOrder = activeProject.chapterIds.filter((chapterId) => Boolean(workspace.chapters[chapterId]));
        const currentChapterId =
          chapterOrder.find((chapterId) => selectedChapterIdSet.has(chapterId)) ??
          (activeChapter?.projectId === activeProject.id ? activeChapter.id : null);
        const nextChapterId = moveSelection(chapterOrder, currentChapterId);
        if (nextChapterId) {
          selectChapter(activeProject.id, nextChapterId);
          window.requestAnimationFrame(() => {
            const node = document.querySelector<HTMLElement>(`[data-chapter-id="${nextChapterId}"]`);
            node?.scrollIntoView({ block: "nearest" });
          });
          return;
        }
      }

      const projectOrder = workspace.projectOrder.filter((projectId) => Boolean(workspace.projects[projectId]));
      const nextProjectId = moveSelection(projectOrder, activeProject?.id ?? workspace.activeProjectId ?? null);
      if (!nextProjectId) {
        return;
      }
      selectProject(nextProjectId);
      window.requestAnimationFrame(() => {
        const node = document.querySelector<HTMLElement>(`[data-project-id="${nextProjectId}"]`);
        node?.scrollIntoView({ block: "nearest" });
      });
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    advancedHighlightQuery,
    activeChapter,
    activeProject,
    advancedModal.open,
    advancedResults,
    centerEntryHighlightQuery,
    clipboard,
    contextMenu,
    currentEntryIds,
    modalState,
    navigationScope,
    searchHighlightQuery,
    searchResults,
    selectedAdvancedResultEntryId,
    selectedChapterIdSet,
    selectedChapterIds,
    selectedEntryIdSet,
    selectedEntryIds,
    selectedSearchResultEntryId,
    workspace.activeProjectId,
    workspace.chapters,
    workspace.projectOrder,
    workspace.projects,
    workspace.selectedEntryId,
  ]);

  function mutateWorkspace(mutator: (draft: WorkspaceData) => void): void {
    setWorkspace((previous) => {
      const next = structuredClone(previous);
      mutator(next);
      return cleanupWorkspace(next, true);
    });
  }

  function toggleProjectCollapsed(projectId: string): void {
    setCollapsedProjectIds((previous) =>
      previous.includes(projectId)
        ? previous.filter((id) => id !== projectId)
        : [...previous, projectId],
    );
  }

  function toggleChapterExpanded(chapterId: string): void {
    setExpandedChapterIds((previous) =>
      previous.includes(chapterId)
        ? previous.filter((id) => id !== chapterId)
        : [...previous, chapterId],
    );
  }

  function selectEntryFromTree(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }
    setWorkspace((previous) => ({
      ...previous,
      activeProjectId: entry.projectId,
      activeChapterId: entry.chapterId,
      selectedEntryId: entry.id,
    }));
    setSelectedChapterIds(entry.chapterId ? [entry.chapterId] : []);
    setSelectedEntryIds([entry.id]);
    chapterSelectionAnchorRef.current = entry.chapterId;
    entrySelectionAnchorRef.current = entry.id;
    setNavigationScope("entry");
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-entry-id="${entry.id}"]`)?.scrollIntoView({
        block: "nearest",
      });
    });
  }

  function configureMoveDrag(event: DragEvent): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.dropEffect = "move";
    event.dataTransfer.setData("text/plain", "move");
  }

  function clearDragState(): void {
    setDragPayload(null);
    setDraggingKey(null);
    setDropTargetKey(null);
  }

  function activateOverlayModal(key: string): void {
    setModalOrders((previous) => {
      const highestOrder = Math.max(...Object.values(previous));
      if (previous[key] >= highestOrder) {
        return previous;
      }
      const nextOrder = modalOrderCounterRef.current + 1;
      modalOrderCounterRef.current = nextOrder;
      return {
        ...previous,
        [key]: nextOrder,
      };
    });
  }

  function modalBackdropStyle(key: string): CSSProperties {
    return {
      zIndex: MODAL_BASE_Z_INDEX + modalOrders[key] * MODAL_Z_INDEX_STEP,
    };
  }

  function startModalDrag(event: MouseEvent<HTMLElement>, key: string): void {
    if (event.button !== 0) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("button, input, textarea, select, a")) {
      return;
    }
    activateOverlayModal(key);
    const origin = modalOffsets[key] ?? { x: 0, y: 0 };
    const card = event.currentTarget.closest<HTMLElement>(".modal-card");
    const rect = card?.getBoundingClientRect();
    const viewportPadding = 8;
    modalDragStateRef.current = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      minX: rect ? origin.x - rect.left + viewportPadding : -window.innerWidth / 2,
      maxX: rect ? origin.x + window.innerWidth - rect.right - viewportPadding : window.innerWidth / 2,
      minY: rect ? origin.y - rect.top + viewportPadding : -window.innerHeight / 2,
      maxY: rect ? origin.y + window.innerHeight - rect.bottom - viewportPadding : window.innerHeight / 2,
    };
    event.preventDefault();
  }

  function modalCardStyle(key: string): CSSProperties {
    const offset = modalOffsets[key];
    if (!offset) {
      return {};
    }
    return { transform: `translate(${offset.x}px, ${offset.y}px)` };
  }

  function selectProject(projectId: string): void {
    setWorkspace((previous) => {
      return {
        ...previous,
        activeProjectId: projectId,
        activeChapterId: null,
        selectedEntryId: firstEntryInProject(previous, projectId),
      };
    });
    setSelectedChapterIds([]);
    setSelectedEntryIds([]);
    chapterSelectionAnchorRef.current = null;
    entrySelectionAnchorRef.current = null;
    setNavigationScope("project");
  }

  function selectChapter(projectId: string, chapterId: string): void {
    setWorkspace((previous) => {
      const chapter = previous.chapters[chapterId];
      return {
        ...previous,
        activeProjectId: projectId,
        activeChapterId: chapterId,
        selectedEntryId: chapter?.entryIds[0] ?? null,
      };
    });
    setSelectedChapterIds([chapterId]);
    setSelectedEntryIds([]);
    chapterSelectionAnchorRef.current = chapterId;
    entrySelectionAnchorRef.current = null;
    setNavigationScope("chapter");
  }

  function handleChapterClick(event: MouseEvent<HTMLButtonElement>, projectId: string, chapterId: string): void {
    const chapterOrder = workspace.projects[projectId]?.chapterIds ?? [];
    const previousAnchor = chapterSelectionAnchorRef.current;
    const fallbackAnchor =
      previousAnchor && chapterOrder.includes(previousAnchor)
        ? previousAnchor
        : activeChapter?.projectId === projectId && activeChapter.id
          ? activeChapter.id
          : chapterId;

    setWorkspace((previous) => {
      const chapter = previous.chapters[chapterId];
      return {
        ...previous,
        activeProjectId: projectId,
        activeChapterId: chapterId,
        selectedEntryId: chapter?.entryIds[0] ?? null,
      };
    });
    setSelectedEntryIds([]);
    entrySelectionAnchorRef.current = null;

    if (event.shiftKey) {
      setSelectedChapterIds(buildIdRange(chapterOrder, fallbackAnchor, chapterId));
    } else {
      setSelectedChapterIds([chapterId]);
      chapterSelectionAnchorRef.current = chapterId;
    }
    setNavigationScope("chapter");
  }

  function handleEntryCardClick(event: MouseEvent<HTMLElement>, entryId: string): void {
    const fallbackAnchor =
      entrySelectionAnchorRef.current && currentEntryIds.includes(entrySelectionAnchorRef.current)
        ? entrySelectionAnchorRef.current
        : workspace.selectedEntryId && currentEntryIds.includes(workspace.selectedEntryId)
          ? workspace.selectedEntryId
          : entryId;

    setWorkspace((previous) => ({ ...previous, selectedEntryId: entryId }));

    if (event.shiftKey) {
      setSelectedEntryIds(buildIdRange(currentEntryIds, fallbackAnchor, entryId));
    } else if (event.metaKey || event.ctrlKey) {
      // ⌘ 點選：逐條加入或移出選取，方便挑兩條不相鄰的史料比勘。
      setSelectedEntryIds((previous) =>
        previous.includes(entryId) ? previous.filter((id) => id !== entryId) : [...previous, entryId],
      );
      entrySelectionAnchorRef.current = entryId;
    } else {
      setSelectedEntryIds([entryId]);
      entrySelectionAnchorRef.current = entryId;
    }
    setNavigationScope("entry");
  }

  function scrollCenterToSearchResult(result: SearchResult): void {
    const scopedEntryIds = workspace.chapters[result.chapterId]?.entryIds ?? [];
    const targetIndex = scopedEntryIds.indexOf(result.entryId);

    window.requestAnimationFrame(() => {
      const container = centerPaneScrollRef.current;
      if (container && scopedEntryIds.length > ENTRY_VIRTUALIZE_THRESHOLD && targetIndex >= 0) {
        const nextScrollTop = Math.max(
          0,
          targetIndex * ENTRY_VIRTUAL_ROW_HEIGHT -
            Math.max(0, (container.clientHeight - ENTRY_VIRTUAL_ROW_HEIGHT) / 2),
        );
        container.scrollTop = nextScrollTop;
        setEntryListScrollTop(nextScrollTop);
      }
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-entry-id="${result.entryId}"]`)
          ?.scrollIntoView({ block: "center" });
      });
    });
  }

  function jumpToSearchResult(
    result: SearchResult,
    highlightQuery = "",
    targetNavigationScope: "search" | "advanced" = "search",
  ): void {
    setWorkspace((previous) => ({
      ...previous,
      activeProjectId: result.projectId,
      activeChapterId: result.chapterId,
      selectedEntryId: result.entryId,
    }));
    setSelectedChapterIds([result.chapterId]);
    setSelectedEntryIds([result.entryId]);
    chapterSelectionAnchorRef.current = result.chapterId;
    entrySelectionAnchorRef.current = result.entryId;
    setCollapsedProjectIds((previous) => previous.filter((projectId) => projectId !== result.projectId));
    setExpandedChapterIds((previous) =>
      previous.includes(result.chapterId) ? previous : [...previous, result.chapterId],
    );
    const normalizedHighlight = highlightQuery.trim();
    setEntryHighlightContext(
      normalizedHighlight
        ? {
            entryId: result.entryId,
            query: normalizedHighlight,
          }
        : null,
    );
    setNavigationScope(targetNavigationScope);
    scrollCenterToSearchResult(result);
  }

  function beginCreateProject(insertAfterProjectId: string | null = null): void {
    setModalState({ kind: "project-create", value: "新建專案", insertAfterProjectId });
  }

  function beginRenameProject(projectId: string): void {
    const project = workspace.projects[projectId];
    if (!project) {
      return;
    }
    setModalState({ kind: "project-rename", projectId, value: project.title });
  }

  function beginCreateChapter(projectId: string, insertAfterChapterId: string | null = null): void {
    const project = workspace.projects[projectId];
    if (!project) {
      return;
    }
    setModalState({
      kind: "chapter-create",
      projectId,
      insertAfterChapterId,
      value: `第${project.chapterIds.length + 1}章`,
    });
  }

  function beginRenameChapter(chapterId: string): void {
    const chapter = workspace.chapters[chapterId];
    if (!chapter) {
      return;
    }
    setModalState({ kind: "chapter-rename", chapterId, value: chapter.title });
  }

  // 同一時間只在一個窗口裏編輯；已有別條在編輯時，把那個窗口提到最前。
  function beginEditEntry(entryId: string, highlightQuery = ""): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }
    const editingWin = entryViewsRef.current.find((win) => win.editing);
    if (editingWin && editingWin.entryId !== entryId) {
      activateOverlayModal(entryViewKey(editingWin.winId));
      return;
    }
    if (modalState?.kind === "entry-create" || modalState?.kind === "entry-edit") {
      activateOverlayModal("entry-form");
      return;
    }
    const resolvedHighlight =
      highlightQuery.trim() ||
      (entryHighlightContext?.entryId === entryId ? entryHighlightContext.query : "");
    setSourceFormatState(EMPTY_SOURCE_FORMAT_STATE);
    const existing = entryViewsRef.current.find((win) => win.entryId === entryId);
    if (existing) {
      setEntryViews((wins) =>
        wins.map((win) =>
          win.winId === existing.winId
            ? { ...win, editing: true, draft: entryToDraft(entry), highlightQuery: resolvedHighlight }
            : win,
        ),
      );
      pendingViewFocusRef.current = entryViewKey(existing.winId);
      activateOverlayModal(entryViewKey(existing.winId));
      return;
    }
    openEntryViewWindow(entry, true, resolvedHighlight);
  }

  // 檢視某條：已有它的窗口就提到最前，否則另開一個窗口。
  function beginViewEntry(entryId: string, highlightQuery = ""): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }
    const resolvedHighlight =
      highlightQuery.trim() ||
      (entryHighlightContext?.entryId === entryId ? entryHighlightContext.query : "");
    const existing = entryViewsRef.current.find((win) => win.entryId === entryId);
    if (existing) {
      if (!existing.editing && resolvedHighlight && resolvedHighlight !== existing.highlightQuery) {
        setEntryViews((wins) =>
          wins.map((win) => (win.winId === existing.winId ? { ...win, highlightQuery: resolvedHighlight } : win)),
        );
      }
      pendingViewFocusRef.current = entryViewKey(existing.winId);
      activateOverlayModal(entryViewKey(existing.winId));
      return;
    }
    openEntryViewWindow(entry, false, resolvedHighlight);
  }

  function openEntryViewWindow(entry: Entry, editing: boolean, highlightQuery: string): void {
    const winId = createId("view");
    const key = entryViewKey(winId);
    // 新窗口在前一個的右下方錯開一點，不完全疊住。
    const step = (entryViewsRef.current.length % 6) * 28;
    setModalOffsets((offsets) => ({ ...offsets, [key]: { x: step, y: step } }));
    setEntryViews((wins) => {
      let next = [...wins, { winId, entryId: entry.id, editing, draft: entryToDraft(entry), highlightQuery }];
      // 太多時關掉最早打開、未在編輯的窗口。
      while (next.length > ENTRY_VIEW_WINDOW_LIMIT) {
        const oldest = next.find((win) => !win.editing && win.winId !== winId);
        if (!oldest) {
          break;
        }
        next = next.filter((win) => win !== oldest);
      }
      return next;
    });
    pendingViewFocusRef.current = key;
    activateOverlayModal(key);
  }

  function updateEntryViewDraft(winId: string, patch: Partial<EntryDraft>): void {
    setEntryViews((wins) =>
      wins.map((win) => (win.winId === winId ? { ...win, draft: { ...win.draft, ...patch } } : win)),
    );
  }

  function applyEntryViewEditor(winId: string): void {
    const win = entryViewsRef.current.find((item) => item.winId === winId);
    if (!win?.editing) {
      return;
    }
    const { entryId, draft } = win;
    mutateWorkspace((workspaceDraft) => {
      const entry = workspaceDraft.entries[entryId];
      if (!entry) {
        return;
      }
      entry.timeText = draft.timeText;
      entry.summary = draft.summary;
      entry.sourceText = draft.sourceText;
      entry.note = draft.note;
      entry.citation = draft.citation;
      entry.updatedAt = Date.now();
    });
    setEntryViews((wins) => wins.map((item) => (item.winId === winId ? { ...item, editing: false, draft } : item)));
  }

  function cancelEntryViewEditing(winId: string): void {
    setEntryViews((wins) =>
      wins.map((win) => {
        if (win.winId !== winId || !win.editing) {
          return win;
        }
        const entry = workspace.entries[win.entryId];
        return entry ? { ...win, editing: false, draft: entryToDraft(entry) } : win;
      }),
    );
  }

  function hasUnsavedViewDraft(win: EntryViewWindow): boolean {
    if (!win.editing) {
      return false;
    }
    const entry = workspaceRef.current.entries[win.entryId];
    return Boolean(entry) && !entryDraftsEqual(win.draft, entryToDraft(entry));
  }

  function closeEntryViewWindow(winId: string): void {
    const win = entryViewsRef.current.find((item) => item.winId === winId);
    if (win && hasUnsavedViewDraft(win) && !window.confirm("這條史料尚未保存，確定放棄修改嗎？")) {
      return;
    }
    const key = entryViewKey(winId);
    setEntryViews((wins) => wins.filter((item) => item.winId !== winId));
    setModalOffsets((offsets) => {
      const next = { ...offsets };
      delete next[key];
      return next;
    });
    setModalOrders((orders) => {
      const next = { ...orders };
      delete next[key];
      return next;
    });
  }

  function openCompare(leftEntryId: string, rightEntryId: string): void {
    if (!workspace.entries[leftEntryId] || !workspace.entries[rightEntryId] || leftEntryId === rightEntryId) {
      return;
    }
    setCompareState({ leftEntryId, rightEntryId, strict: false });
  }

  function showSimilarFor(entryId: string): void {
    setSimilarAnchorEntryId(entryId);
    setRightPaneTab("similar");
  }

  function jumpToSimilarEntry(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }
    if (workspace.selectedEntryId !== entryId) {
      keepSimilarAnchorRef.current = true;
    }
    jumpToSearchResult({
      projectId: entry.projectId,
      chapterId: entry.chapterId,
      entryId: entry.id,
      projectTitle: workspace.projects[entry.projectId]?.title ?? "",
      chapterTitle: workspace.chapters[entry.chapterId]?.title ?? "",
      timeText: entry.timeText,
      summaryText: entry.summary ?? "",
      snippet: "",
      citation: entry.citation,
      tags: [],
    });
  }

  function resolveEntryInsertAfterIdForCurrentScope(fallbackEntryId: string | null = null): string | null {
    if (!activeProject || !activeChapter) {
      return null;
    }
    const chapterId = activeChapter.id;
    const orderedSelectedEntryIds = currentEntryIds.filter((entryId) => selectedEntryIdSet.has(entryId));
    const preferredEntryId =
      orderedSelectedEntryIds.length > 0
        ? orderedSelectedEntryIds[orderedSelectedEntryIds.length - 1]
        : fallbackEntryId;
    return resolveInsertAfterEntryId(workspace, activeProject.id, chapterId, preferredEntryId);
  }

  function beginCreateEntryAfter(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry || !workspace.chapters[entry.chapterId]) {
      return;
    }
    setSourceFormatState(EMPTY_SOURCE_FORMAT_STATE);
    setModalState({
      kind: "entry-create",
      projectId: entry.projectId,
      chapterId: entry.chapterId,
      insertAfterEntryId: entryId,
      draft: createEmptyEntryDraft(),
    });
  }

  function copyCurrentProject(projectId: string): void {
    const snapshot = collectProjectSnapshot(workspace, projectId);
    if (!snapshot) {
      return;
    }
    setClipboard({ kind: "project", snapshot });
  }

  function collectOrderedChapterIdsForContext(chapterId: string, chapterIds: string[]): string[] {
    const chapter = workspace.chapters[chapterId];
    if (!chapter) {
      return [];
    }
    const project = workspace.projects[chapter.projectId];
    if (!project) {
      return [];
    }
    const chapterIdSet = new Set(chapterIds);
    return project.chapterIds.filter((id) => chapterIdSet.has(id) && Boolean(workspace.chapters[id]));
  }

  function collectOrderedEntryIdsForContext(entryId: string, entryIds: string[]): string[] {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return [];
    }
    const scopeIds = workspace.chapters[entry.chapterId]?.entryIds ?? [];
    const entryIdSet = new Set(entryIds);
    return scopeIds.filter((id) => entryIdSet.has(id) && Boolean(workspace.entries[id]));
  }

  function copyChaptersToClipboard(chapterIds: string[]): void {
    const snapshots = chapterIds
      .map((chapterId) => collectChapterSnapshot(workspace, chapterId))
      .filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot));
    if (snapshots.length === 0) {
      return;
    }
    setClipboard({ kind: "chapter", snapshots });
  }

  function pasteProjectFromClipboard(insertAfterProjectId: string | null = null): void {
    if (!clipboard || clipboard.kind !== "project") {
      return;
    }
    const resolvedInsertAfterProjectId =
      typeof insertAfterProjectId === "string" ? insertAfterProjectId : null;

    mutateWorkspace((draft) => {
      const projectId = createId("project");
      const projectTitle = ensureUniqueProjectTitle(draft, `${clipboard.snapshot.title}（副本）`);
      draft.projects[projectId] = {
        id: projectId,
        title: projectTitle,
        chapterIds: [],
        createdAt: Date.now(),
      };
      if (resolvedInsertAfterProjectId) {
        const index = draft.projectOrder.indexOf(resolvedInsertAfterProjectId);
        if (index >= 0) {
          draft.projectOrder.splice(index + 1, 0, projectId);
        } else {
          draft.projectOrder.push(projectId);
        }
      } else {
        draft.projectOrder.push(projectId);
      }

      let firstEntryId: string | null = null;
      for (const chapter of clipboard.snapshot.chapters) {
        const chapterId = appendChapterWithEntries(draft, projectId, chapter.title, chapter.entries);
        const first = chapterId ? draft.chapters[chapterId]?.entryIds[0] ?? null : null;
        if (!firstEntryId && first) {
          firstEntryId = first;
        }
      }

      draft.activeProjectId = projectId;
      draft.activeChapterId = null;
      draft.selectedEntryId = firstEntryId;
    });
  }

  function pasteChapterFromClipboard(targetProjectId?: string, insertAfterChapterId: string | null = null): void {
    if (!clipboard || clipboard.kind !== "chapter") {
      return;
    }
    if (clipboard.snapshots.length === 0) {
      return;
    }

    const resolvedProjectId =
      typeof targetProjectId === "string" ? targetProjectId : activeProject?.id ?? null;
    const fallbackInsertAfterChapterId =
      activeChapter?.id && workspace.chapters[activeChapter.id]?.projectId === resolvedProjectId
        ? activeChapter.id
        : null;
    const resolvedInsertAfterChapterId =
      typeof insertAfterChapterId === "string" ? insertAfterChapterId : fallbackInsertAfterChapterId;
    if (!resolvedProjectId) {
      return;
    }

    mutateWorkspace((draft) => {
      const project = draft.projects[resolvedProjectId];
      if (!project) {
        return;
      }

      let nextInsertAfterChapterId =
        resolvedInsertAfterChapterId && draft.chapters[resolvedInsertAfterChapterId]?.projectId === project.id
          ? resolvedInsertAfterChapterId
          : null;
      let firstChapterId: string | null = null;
      let firstEntryId: string | null = null;
      let lastChapterId: string | null = null;

      for (const snapshot of clipboard.snapshots) {
        const chapterId = createId("chapter");
        draft.chapters[chapterId] = {
          id: chapterId,
          projectId: project.id,
          title: ensureUniqueChapterTitle(draft, project.id, `${snapshot.title}（副本）`),
          entryIds: [],
          createdAt: Date.now(),
        };
        if (!firstChapterId) {
          firstChapterId = chapterId;
        }
        lastChapterId = chapterId;

        if (nextInsertAfterChapterId && draft.chapters[nextInsertAfterChapterId]?.projectId === project.id) {
          const index = project.chapterIds.indexOf(nextInsertAfterChapterId);
          if (index >= 0) {
            project.chapterIds.splice(index + 1, 0, chapterId);
          } else {
            project.chapterIds.push(chapterId);
          }
        } else {
          project.chapterIds.push(chapterId);
        }
        nextInsertAfterChapterId = chapterId;

        for (const item of snapshot.entries) {
          const entryId = appendEntryDraft(draft, project.id, chapterId, item);
          if (!firstEntryId) {
            firstEntryId = entryId;
          }
        }
      }

      draft.activeProjectId = project.id;
      draft.activeChapterId = lastChapterId ?? firstChapterId;
      draft.selectedEntryId = firstEntryId;
    });
  }

  function copyEntriesToClipboard(entryIds: string[]): void {
    const drafts = entryIds
      .map((entryId) => workspace.entries[entryId])
      .filter((entry): entry is Entry => Boolean(entry))
      .map(entryToDraft);
    if (drafts.length === 0) {
      return;
    }
    setClipboard({ kind: "entry", drafts });
  }

  function copyEntryToClipboard(entryId: string): void {
    copyEntriesToClipboard([entryId]);
  }

  function pasteEntryFromClipboard(
    targetProjectId?: string,
    targetChapterId?: string | null,
    insertAfterEntryId?: string | null,
  ): void {
    if (!clipboard || clipboard.kind !== "entry") {
      return;
    }
    if (clipboard.drafts.length === 0) {
      return;
    }

    const resolvedProjectId =
      typeof targetProjectId === "string" ? targetProjectId : activeProject?.id ?? null;
    if (!resolvedProjectId) {
      return;
    }
    const normalizedInsertAfterEntryId =
      insertAfterEntryId === null || typeof insertAfterEntryId === "string"
        ? insertAfterEntryId
        : undefined;

    // 史料必須落在章節之下，沒有指定或選中章節就不貼上。
    const requestedChapterId =
      targetChapterId !== undefined ? targetChapterId : workspace.activeChapterId;
    const scopedChapterId =
      requestedChapterId && workspace.chapters[requestedChapterId]?.projectId === resolvedProjectId
        ? requestedChapterId
        : null;
    if (!scopedChapterId) {
      setStorageStatus("請先選擇章節，再貼上史料。");
      return;
    }

    mutateWorkspace((draft) => {
      const targetProject = draft.projects[resolvedProjectId];
      if (!targetProject) {
        return;
      }

      const safeInsertAfterEntryId = resolveInsertAfterEntryId(
        draft,
        targetProject.id,
        scopedChapterId,
        normalizedInsertAfterEntryId ?? null,
      );
      let insertAfterId = safeInsertAfterEntryId;
      let lastEntryId: string | null = null;
      for (const draftItem of clipboard.drafts) {
        const entryId = appendEntryDraft(draft, targetProject.id, scopedChapterId, draftItem, insertAfterId);
        insertAfterId = entryId;
        lastEntryId = entryId;
      }
      draft.activeProjectId = targetProject.id;
      draft.activeChapterId = scopedChapterId;
      draft.selectedEntryId = lastEntryId;
    });
  }

  function pasteChapterFromToolbar(): void {
    if (!activeProject) {
      return;
    }
    const orderedSelectedChapterIds = activeProject.chapterIds.filter((chapterId) => selectedChapterIdSet.has(chapterId));
    const insertAfterChapterId =
      orderedSelectedChapterIds.length > 0 ? orderedSelectedChapterIds[orderedSelectedChapterIds.length - 1] : null;
    pasteChapterFromClipboard(activeProject.id, insertAfterChapterId);
  }

  function pasteEntryFromToolbar(): void {
    if (!activeProject) {
      return;
    }
    const insertAfterEntryId = resolveEntryInsertAfterIdForCurrentScope(null);
    pasteEntryFromClipboard(activeProject.id, activeChapter?.id ?? null, insertAfterEntryId);
  }

  function openProjectContextMenu(event: MouseEvent, projectId: string): void {
    event.preventDefault();
    const menuWidth = 180;
    const menuHeight = 230;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ kind: "project", projectId, x, y });
    setNavigationScope("project");
  }

  function openChapterContextMenu(event: MouseEvent, chapterId: string): void {
    event.preventDefault();
    if (selectedChapterIdSet.has(chapterId)) {
      setSelectedChapterIds((previous) => previous.filter((id) => Boolean(workspace.chapters[id])));
    } else {
      setSelectedChapterIds([chapterId]);
      chapterSelectionAnchorRef.current = chapterId;
    }
    const menuWidth = 180;
    const menuHeight = 230;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ kind: "chapter", chapterId, x, y });
    setNavigationScope("chapter");
  }

  function openEntryContextMenu(event: MouseEvent, entryId: string): void {
    event.preventDefault();
    mutateWorkspace((draft) => {
      draft.selectedEntryId = entryId;
    });
    if (selectedEntryIdSet.has(entryId)) {
      setSelectedEntryIds((previous) => previous.filter((id) => Boolean(workspace.entries[id])));
    } else {
      setSelectedEntryIds([entryId]);
      entrySelectionAnchorRef.current = entryId;
    }
    const menuWidth = 180;
    const menuHeight = 260;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ kind: "entry", entryId, x, y });
    setNavigationScope("entry");
  }

  function applyFormModal(): void {
    if (
      !modalState ||
      modalState.kind === "entry-edit" ||
      modalState.kind === "entry-create"
    ) {
      return;
    }

    if (modalState.kind === "project-create") {
      const title = modalState.value.trim() || "新建專案";
      mutateWorkspace((draft) => {
        const projectId = createId("project");
        draft.projects[projectId] = {
          id: projectId,
          title: ensureUniqueProjectTitle(draft, title),
          chapterIds: [],
          createdAt: Date.now(),
        };
        if (modalState.insertAfterProjectId) {
          const index = draft.projectOrder.indexOf(modalState.insertAfterProjectId);
          if (index >= 0) {
            draft.projectOrder.splice(index + 1, 0, projectId);
          } else {
            draft.projectOrder.push(projectId);
          }
        } else {
          draft.projectOrder.push(projectId);
        }
        draft.activeProjectId = projectId;
        draft.activeChapterId = null;
        draft.selectedEntryId = null;
      });
      setModalState(null);
      return;
    }

    if (modalState.kind === "project-rename") {
      const title = modalState.value.trim();
      if (!title) {
        return;
      }

      mutateWorkspace((draft) => {
        const project = draft.projects[modalState.projectId];
        if (!project) {
          return;
        }
        project.title = ensureUniqueProjectTitle(draft, title, project.id);
      });
      setModalState(null);
      return;
    }

    if (modalState.kind === "chapter-create") {
      const title = modalState.value.trim() || "新章節";
      mutateWorkspace((draft) => {
        const project = draft.projects[modalState.projectId];
        if (!project) {
          return;
        }

        const chapterId = createId("chapter");
        draft.chapters[chapterId] = {
          id: chapterId,
          projectId: modalState.projectId,
          title,
          entryIds: [],
          createdAt: Date.now(),
        };
        if (modalState.insertAfterChapterId && draft.chapters[modalState.insertAfterChapterId]?.projectId === project.id) {
          const index = project.chapterIds.indexOf(modalState.insertAfterChapterId);
          if (index >= 0) {
            project.chapterIds.splice(index + 1, 0, chapterId);
          } else {
            project.chapterIds.push(chapterId);
          }
        } else {
          project.chapterIds.push(chapterId);
        }
        draft.activeProjectId = modalState.projectId;
        draft.activeChapterId = chapterId;
        draft.selectedEntryId = null;
      });
      setModalState(null);
      return;
    }

    const title = modalState.value.trim();
    if (!title) {
      return;
    }

    mutateWorkspace((draft) => {
      const chapter = draft.chapters[modalState.chapterId];
      if (chapter) {
        chapter.title = title;
      }
    });
    setModalState(null);
  }

  function applyEntryEditor(): void {
    if (modalState?.kind !== "entry-edit" && modalState?.kind !== "entry-create") {
      const editingWin = entryViewsRef.current.find((win) => win.editing);
      if (editingWin) {
        applyEntryViewEditor(editingWin.winId);
      }
      return;
    }

    if (modalState.kind === "entry-edit") {
      const { entryId, draft } = modalState;
      mutateWorkspace((workspaceDraft) => {
        const entry = workspaceDraft.entries[entryId];
        if (!entry) {
          return;
        }
        entry.timeText = draft.timeText;
        entry.summary = draft.summary;
        entry.sourceText = draft.sourceText;
        entry.note = draft.note;
        entry.citation = draft.citation;
        entry.updatedAt = Date.now();
      });
      setModalState(null);
      return;
    }

    if (modalState.kind === "entry-create") {
      const { projectId, chapterId, insertAfterEntryId, draft } = modalState;
      mutateWorkspace((workspaceDraft) => {
        const project = workspaceDraft.projects[projectId];
        if (!project) {
          return;
        }

        // 史料必須落在章節之下。
        const targetChapterId =
          chapterId && workspaceDraft.chapters[chapterId]?.projectId === projectId ? chapterId : null;
        if (!targetChapterId) {
          return;
        }
        const safeInsertAfterId = resolveInsertAfterEntryId(
          workspaceDraft,
          projectId,
          targetChapterId,
          insertAfterEntryId,
        );
        const entryId = appendEntryDraft(
          workspaceDraft,
          projectId,
          targetChapterId,
          draft,
          safeInsertAfterId,
        );
        workspaceDraft.activeProjectId = projectId;
        workspaceDraft.activeChapterId = targetChapterId;
        workspaceDraft.selectedEntryId = entryId;
      });
      setModalState(null);
    }
  }

  function deleteProject(projectId: string): void {
    const project = workspace.projects[projectId];
    if (!project) {
      return;
    }

    const confirmed = window.confirm(`將專案「${project.title}」移至回收站？其全部章節與史料會一併移入。`);
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const target = draft.projects[projectId];
      if (!target) {
        return;
      }

      const trashedChapters = target.chapterIds
        .map((chapterId) => draft.chapters[chapterId])
        .filter((chapter): chapter is Chapter => Boolean(chapter))
        .map((chapter) => structuredClone(chapter));
      const trashedEntryIds = trashedChapters.flatMap((chapter) => chapter.entryIds);
      const trashedEntries = trashedEntryIds
        .map((entryId) => draft.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map((entry) => structuredClone(entry));
      prependTrashItem(draft,
        {
          id: createId("trash"),
          deletedAt: Date.now(),
          label: project.title,
          payload: {
            kind: "project",
            projectIndex: Math.max(0, draft.projectOrder.indexOf(projectId)),
            project: structuredClone(target),
            chapters: trashedChapters,
            entries: trashedEntries,
          },
        },
      );

      for (const chapterId of target.chapterIds) {
        const chapter = draft.chapters[chapterId];
        if (!chapter) {
          continue;
        }
        for (const entryId of chapter.entryIds) {
          delete draft.entries[entryId];
        }
        delete draft.chapters[chapterId];
      }

      delete draft.projects[projectId];
      draft.projectOrder = draft.projectOrder.filter((id) => id !== projectId);

      if (draft.activeProjectId === projectId) {
        draft.activeProjectId = draft.projectOrder[0] ?? null;
        draft.activeChapterId = null;
      }
    });
    setStorageStatus(`已將專案「${project.title}」移至回收站。`);
  }

  function deleteChapter(chapterId: string): void {
    const chapter = workspace.chapters[chapterId];
    if (!chapter) {
      return;
    }

    const confirmed = window.confirm(`將章節「${chapter.title}」移至回收站？其下史料會一併移入。`);
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const target = draft.chapters[chapterId];
      if (!target) {
        return;
      }

      const project = draft.projects[target.projectId];
      const trashedEntries = target.entryIds
        .map((entryId) => draft.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map((entry) => structuredClone(entry));
      prependTrashItem(draft,
        {
          id: createId("trash"),
          deletedAt: Date.now(),
          label: chapter.title,
          payload: {
            kind: "chapter",
            chapters: [
              {
                chapter: structuredClone(target),
                chapterIndex: Math.max(0, project?.chapterIds.indexOf(chapterId) ?? 0),
              },
            ],
            entries: trashedEntries,
          },
        },
      );

      for (const entryId of target.entryIds) {
        delete draft.entries[entryId];
      }

      if (project) {
        project.chapterIds = project.chapterIds.filter((id) => id !== chapterId);
      }

      delete draft.chapters[chapterId];
      if (draft.activeChapterId === chapterId) {
        draft.activeChapterId = null;
      }
    });
    setStorageStatus(`已將章節「${chapter.title}」移至回收站。`);
  }

  function deleteChaptersBatch(chapterIds: string[]): void {
    const uniqueChapterIds = Array.from(new Set(chapterIds)).filter((chapterId) =>
      Boolean(workspace.chapters[chapterId]),
    );
    if (uniqueChapterIds.length === 0) {
      return;
    }
    const confirmed = window.confirm(
      `將已選 ${uniqueChapterIds.length} 個章節移至回收站？其下史料會一併移入。`,
    );
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const trashedChapters = uniqueChapterIds
        .map((chapterId) => {
          const chapter = draft.chapters[chapterId];
          const project = chapter ? draft.projects[chapter.projectId] : null;
          return chapter
            ? {
                chapter: structuredClone(chapter),
                chapterIndex: Math.max(0, project?.chapterIds.indexOf(chapterId) ?? 0),
              }
            : null;
        })
        .filter((item): item is { chapter: Chapter; chapterIndex: number } => Boolean(item));
      const trashedEntries = trashedChapters
        .flatMap(({ chapter }) => chapter.entryIds)
        .map((entryId) => draft.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map((entry) => structuredClone(entry));
      prependTrashItem(draft,
        {
          id: createId("trash"),
          deletedAt: Date.now(),
          label: `${trashedChapters.length} 個章節`,
          payload: {
            kind: "chapter",
            chapters: trashedChapters,
            entries: trashedEntries,
          },
        },
      );

      for (const chapterId of uniqueChapterIds) {
        const chapter = draft.chapters[chapterId];
        if (!chapter) {
          continue;
        }
        for (const entryId of chapter.entryIds) {
          delete draft.entries[entryId];
        }
        const project = draft.projects[chapter.projectId];
        if (project) {
          project.chapterIds = project.chapterIds.filter((id) => id !== chapterId);
        }
        delete draft.chapters[chapterId];
      }
      if (draft.activeChapterId && !draft.chapters[draft.activeChapterId]) {
        draft.activeChapterId = null;
      }
      if (draft.selectedEntryId && !draft.entries[draft.selectedEntryId]) {
        draft.selectedEntryId = null;
      }
    });

    setStorageStatus(`已將 ${uniqueChapterIds.length} 個章節移至回收站。`);

    setSelectedChapterIds((previous) => previous.filter((chapterId) => !uniqueChapterIds.includes(chapterId)));
    setSelectedEntryIds((previous) => previous.filter((entryId) => Boolean(workspace.entries[entryId])));
    if (chapterSelectionAnchorRef.current && uniqueChapterIds.includes(chapterSelectionAnchorRef.current)) {
      chapterSelectionAnchorRef.current = null;
    }
  }

  function updateEntryModalDraft(patch: Partial<EntryDraft>): void {
    // 新增、編輯表單優先；沒有表單時改的是正在編輯的檢視窗（格式工具列也走這裏）。
    if (modalState?.kind !== "entry-edit" && modalState?.kind !== "entry-create") {
      const editingWin = entryViewsRef.current.find((win) => win.editing);
      if (editingWin) {
        updateEntryViewDraft(editingWin.winId, patch);
      }
      return;
    }
    setModalState((current) => {
      if (!current || (current.kind !== "entry-edit" && current.kind !== "entry-create")) {
        return current;
      }
      return {
        ...current,
        draft: {
          ...current.draft,
          ...patch,
        },
      };
    });
  }

  function syncSourceFormatState(): void {
    const textarea = entrySourceTextareaRef.current;
    setSourceFormatState(textarea ? resolveSourceFormatState(textarea) : EMPTY_SOURCE_FORMAT_STATE);
  }

  function applySourceMarker(marker: "bold" | "italic" | "underline"): void {
    const textarea = entrySourceTextareaRef.current;
    if (!textarea) {
      return;
    }

    const token = marker === "bold" ? "**" : marker === "italic" ? "*" : "__";
    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const tokenLength = token.length;

    const hasWrappedSelection =
      start >= tokenLength &&
      value.slice(start - tokenLength, start) === token &&
      value.slice(end, end + tokenLength) === token &&
      end > start;

    let nextValue = value;
    let nextStart = start;
    let nextEnd = end;

    if (hasWrappedSelection) {
      nextValue =
        value.slice(0, start - tokenLength) + value.slice(start, end) + value.slice(end + tokenLength);
      nextStart = start - tokenLength;
      nextEnd = end - tokenLength;
    } else if (start === end) {
      nextValue = value.slice(0, start) + token + token + value.slice(end);
      nextStart = start + tokenLength;
      nextEnd = nextStart;
    } else {
      nextValue = value.slice(0, start) + token + value.slice(start, end) + token + value.slice(end);
      nextStart = start + tokenLength;
      nextEnd = end + tokenLength;
    }

    updateEntryModalDraft({ sourceText: nextValue });
    window.requestAnimationFrame(() => {
      const input = entrySourceTextareaRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(nextStart, nextEnd);
      setSourceFormatState(resolveSourceFormatState(input));
    });
  }

  function handleSourceShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if ((!event.metaKey && !event.ctrlKey) || event.altKey) {
      return;
    }
    const key = event.key.toLocaleLowerCase();
    if (key === "b") {
      event.preventDefault();
      applySourceMarker("bold");
      return;
    }
    if (key === "i") {
      event.preventDefault();
      applySourceMarker("italic");
      return;
    }
    if (key === "u") {
      event.preventDefault();
      applySourceMarker("underline");
    }
  }

  function createEntry(fallbackEntryId: string | null = null): void {
    // 史料一律錄入章節之下；未選章節時不開新增彈窗。
    if (!activeProject || !activeChapter) {
      return;
    }

    const chapterId = activeChapter.id;
    const insertAfterEntryId = resolveEntryInsertAfterIdForCurrentScope(fallbackEntryId);
    setSourceFormatState(EMPTY_SOURCE_FORMAT_STATE);
    setModalState({
      kind: "entry-create",
      projectId: activeProject.id,
      chapterId,
      insertAfterEntryId,
      draft: createEmptyEntryDraft(),
    });
  }

  function deleteEntry(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }

    const confirmed = window.confirm("將此條史料移至回收站？");
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const target = draft.entries[entryId];
      if (!target) {
        return;
      }

      const targetEntryIds = draft.chapters[target.chapterId]?.entryIds ?? [];
      prependTrashItem(draft,
        {
          id: createId("trash"),
          deletedAt: Date.now(),
          label: formatEntryHeadline(target.timeText, target.summary),
          payload: {
            kind: "entry",
            entries: [
              {
                entry: structuredClone(target),
                entryIndex: Math.max(0, targetEntryIds.indexOf(entryId)),
              },
            ],
          },
        },
      );

      const chapter = draft.chapters[target.chapterId];
      if (chapter) {
        chapter.entryIds = chapter.entryIds.filter((id) => id !== entryId);
      }

      delete draft.entries[entryId];
      if (draft.selectedEntryId === entryId) {
        draft.selectedEntryId = null;
      }
    });
    setStorageStatus(`已將史料「${formatEntryHeadline(entry.timeText, entry.summary)}」移至回收站。`);

    setEntryViews((wins) => wins.filter((win) => win.entryId !== entryId));
    setModalState((current) => {
      if (current?.kind === "entry-edit" && current.entryId === entryId) {
        return null;
      }
      return current;
    });
  }

  function deleteEntriesBatch(entryIds: string[]): void {
    const uniqueEntryIds = Array.from(new Set(entryIds)).filter((entryId) => Boolean(workspace.entries[entryId]));
    if (uniqueEntryIds.length === 0) {
      return;
    }
    const confirmed = window.confirm(`將已選 ${uniqueEntryIds.length} 條史料移至回收站？`);
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const trashedEntries = uniqueEntryIds
        .map((entryId) => {
          const entry = draft.entries[entryId];
          if (!entry) {
            return null;
          }
          const targetEntryIds = draft.chapters[entry.chapterId]?.entryIds ?? [];
          return {
            entry: structuredClone(entry),
            entryIndex: Math.max(0, targetEntryIds.indexOf(entryId)),
          };
        })
        .filter((item): item is { entry: Entry; entryIndex: number } => Boolean(item));
      prependTrashItem(draft,
        {
          id: createId("trash"),
          deletedAt: Date.now(),
          label: `${trashedEntries.length} 條史料`,
          payload: {
            kind: "entry",
            entries: trashedEntries,
          },
        },
      );

      for (const entryId of uniqueEntryIds) {
        const entry = draft.entries[entryId];
        if (!entry) {
          continue;
        }
        const chapter = draft.chapters[entry.chapterId];
        if (chapter) {
          chapter.entryIds = chapter.entryIds.filter((id) => id !== entryId);
        }
        delete draft.entries[entryId];
      }
      if (draft.selectedEntryId && !draft.entries[draft.selectedEntryId]) {
        draft.selectedEntryId = null;
      }
    });

    setStorageStatus(`已將 ${uniqueEntryIds.length} 條史料移至回收站。`);

    setSelectedEntryIds((previous) => previous.filter((entryId) => !uniqueEntryIds.includes(entryId)));
    if (entrySelectionAnchorRef.current && uniqueEntryIds.includes(entrySelectionAnchorRef.current)) {
      entrySelectionAnchorRef.current = null;
    }
    setModalState((current) => {
      if (!current) {
        return current;
      }
      if (current.kind === "entry-edit" && uniqueEntryIds.includes(current.entryId)) {
        return null;
      }
      return current;
    });
    setEntryViews((wins) => wins.filter((win) => !uniqueEntryIds.includes(win.entryId)));
  }

  function trashRestoreBlockReason(item: TrashItem): string | null {
    if (item.payload.kind === "project") {
      return null;
    }
    if (item.payload.kind === "chapter") {
      const missingProject = item.payload.chapters.find(
        ({ chapter }) => !workspace.projects[chapter.projectId],
      );
      return missingProject ? "原專案已不存在，請先還原該專案。" : null;
    }
    const missingTarget = item.payload.entries.find(({ entry }) => {
      if (!workspace.projects[entry.projectId]) {
        return true;
      }
      return Boolean(entry.chapterId && !workspace.chapters[entry.chapterId]);
    });
    return missingTarget ? "原專案或章節已不存在，請先還原上層項目。" : null;
  }

  function restoreTrashItem(itemId: string): void {
    const item = workspace.trash.find((candidate) => candidate.id === itemId);
    if (!item) {
      return;
    }
    const blockedReason = trashRestoreBlockReason(item);
    if (blockedReason) {
      setStorageStatus(`無法還原「${item.label}」：${blockedReason}`);
      return;
    }

    mutateWorkspace((draft) => {
      const current = draft.trash.find((candidate) => candidate.id === itemId);
      if (!current) {
        return;
      }

      if (current.payload.kind === "project") {
        const payload = current.payload;
        const projectId = draft.projects[payload.project.id] ? createId("project") : payload.project.id;
        const chapterIdMap = new Map<string, string>();
        const entryIdMap = new Map<string, string>();

        for (const chapter of payload.chapters) {
          chapterIdMap.set(
            chapter.id,
            draft.chapters[chapter.id] ? createId("chapter") : chapter.id,
          );
        }
        for (const entry of payload.entries) {
          entryIdMap.set(entry.id, draft.entries[entry.id] ? createId("entry") : entry.id);
        }

        const restoredProject: Project = {
          ...structuredClone(payload.project),
          id: projectId,
          title: ensureUniqueProjectTitle(draft, payload.project.title),
          chapterIds: payload.project.chapterIds
            .map((chapterId) => chapterIdMap.get(chapterId))
            .filter((chapterId): chapterId is string => Boolean(chapterId)),
        };
        draft.projects[projectId] = restoredProject;

        for (const chapter of payload.chapters) {
          const restoredChapterId = chapterIdMap.get(chapter.id);
          if (!restoredChapterId) continue;
          draft.chapters[restoredChapterId] = {
            ...structuredClone(chapter),
            id: restoredChapterId,
            projectId,
            entryIds: chapter.entryIds
              .map((entryId) => entryIdMap.get(entryId))
              .filter((entryId): entryId is string => Boolean(entryId)),
          };
        }
        for (const entry of payload.entries) {
          const restoredEntryId = entryIdMap.get(entry.id);
          if (!restoredEntryId) continue;
          // 舊回收站項目可能含無章節史料，一律還原進「未分章」修復章節。
          const mappedChapterId = entry.chapterId ? chapterIdMap.get(entry.chapterId) ?? null : null;
          const restoredChapterId = mappedChapterId ?? ensureRepairChapterId(draft, projectId);
          draft.entries[restoredEntryId] = {
            ...structuredClone(entry),
            id: restoredEntryId,
            projectId,
            chapterId: restoredChapterId,
          };
          if (!mappedChapterId) {
            draft.chapters[restoredChapterId].entryIds.push(restoredEntryId);
          }
        }

        draft.projectOrder.splice(
          Math.min(Math.max(0, payload.projectIndex), draft.projectOrder.length),
          0,
          projectId,
        );
        draft.activeProjectId = projectId;
        draft.activeChapterId = restoredProject.chapterIds[0] ?? null;
        draft.selectedEntryId = draft.activeChapterId
          ? draft.chapters[draft.activeChapterId]?.entryIds[0] ?? null
          : null;
      } else if (current.payload.kind === "chapter") {
        const payload = current.payload;
        const chapterIdMap = new Map<string, string>();
        const entryIdMap = new Map<string, string>();
        for (const { chapter } of payload.chapters) {
          chapterIdMap.set(
            chapter.id,
            draft.chapters[chapter.id] ? createId("chapter") : chapter.id,
          );
        }
        for (const entry of payload.entries) {
          entryIdMap.set(entry.id, draft.entries[entry.id] ? createId("entry") : entry.id);
        }

        const orderedChapters = [...payload.chapters].sort(
          (a, b) => a.chapterIndex - b.chapterIndex,
        );
        for (const { chapter, chapterIndex } of orderedChapters) {
          const project = draft.projects[chapter.projectId];
          const restoredChapterId = chapterIdMap.get(chapter.id);
          if (!project || !restoredChapterId) continue;
          draft.chapters[restoredChapterId] = {
            ...structuredClone(chapter),
            id: restoredChapterId,
            title: ensureUniqueChapterTitle(draft, project.id, chapter.title),
            entryIds: chapter.entryIds
              .map((entryId) => entryIdMap.get(entryId))
              .filter((entryId): entryId is string => Boolean(entryId)),
          };
          project.chapterIds.splice(
            Math.min(Math.max(0, chapterIndex), project.chapterIds.length),
            0,
            restoredChapterId,
          );
        }
        for (const entry of payload.entries) {
          const restoredEntryId = entryIdMap.get(entry.id);
          const restoredChapterId = entry.chapterId ? chapterIdMap.get(entry.chapterId) : null;
          if (!restoredEntryId || !restoredChapterId) continue;
          draft.entries[restoredEntryId] = {
            ...structuredClone(entry),
            id: restoredEntryId,
            chapterId: restoredChapterId,
          };
        }
        const firstChapter = orderedChapters[0]?.chapter;
        const firstRestoredChapterId = firstChapter ? chapterIdMap.get(firstChapter.id) ?? null : null;
        if (firstChapter && firstRestoredChapterId) {
          draft.activeProjectId = firstChapter.projectId;
          draft.activeChapterId = firstRestoredChapterId;
          draft.selectedEntryId = draft.chapters[firstRestoredChapterId]?.entryIds[0] ?? null;
        }
      } else {
        const payload = current.payload;
        const entryIdMap = new Map<string, string>();
        for (const { entry } of payload.entries) {
          entryIdMap.set(entry.id, draft.entries[entry.id] ? createId("entry") : entry.id);
        }
        const orderedEntries = [...payload.entries].sort((a, b) => a.entryIndex - b.entryIndex);
        for (const { entry, entryIndex } of orderedEntries) {
          const restoredEntryId = entryIdMap.get(entry.id);
          if (!restoredEntryId) continue;
          draft.entries[restoredEntryId] = { ...structuredClone(entry), id: restoredEntryId };
          const targetEntryIds = draft.chapters[entry.chapterId]?.entryIds;
          targetEntryIds?.splice(
            Math.min(Math.max(0, entryIndex), targetEntryIds.length),
            0,
            restoredEntryId,
          );
        }
        const firstEntry = orderedEntries[0]?.entry;
        if (firstEntry) {
          draft.activeProjectId = firstEntry.projectId;
          draft.activeChapterId = firstEntry.chapterId;
          draft.selectedEntryId = entryIdMap.get(firstEntry.id) ?? null;
        }
      }

      draft.trash = draft.trash.filter((candidate) => candidate.id !== itemId);
    });
    setStorageStatus(`已從回收站還原「${item.label}」。`);
  }

  function permanentlyDeleteTrashItem(itemId: string): void {
    const item = workspace.trash.find((candidate) => candidate.id === itemId);
    if (!item || !window.confirm(`永久刪除「${item.label}」？此操作無法復原。`)) {
      return;
    }
    mutateWorkspace((draft) => {
      draft.trash = draft.trash.filter((candidate) => candidate.id !== itemId);
    });
    setStorageStatus(`已永久刪除「${item.label}」。`);
  }

  function emptyTrash(): void {
    if (workspace.trash.length === 0 || !window.confirm("清空回收站？所有項目將永久刪除且無法復原。")) {
      return;
    }
    mutateWorkspace((draft) => {
      draft.trash = [];
    });
    setStorageStatus("回收站已清空。");
  }

  function onProjectDrop(targetProjectId: string): void {
    if (!dragPayload || dragPayload.type !== "project") {
      return;
    }

    mutateWorkspace((draft) => {
      draft.projectOrder = reorderById(draft.projectOrder, dragPayload.id, targetProjectId);
    });

    clearDragState();
  }

  function onChapterDrop(targetProjectId: string, targetChapterId: string): void {
    if (!dragPayload || dragPayload.type !== "chapter") {
      return;
    }
    if (dragPayload.projectId !== targetProjectId) {
      return;
    }

    mutateWorkspace((draft) => {
      const project = draft.projects[targetProjectId];
      if (!project) {
        return;
      }
      project.chapterIds = reorderById(project.chapterIds, dragPayload.id, targetChapterId);
    });

    clearDragState();
  }

  function moveEntryToScope(
    entryId: string,
    targetProjectId: string,
    targetChapterId: string,
  ): void {
    const entry = workspace.entries[entryId];
    const targetProject = workspace.projects[targetProjectId];
    const targetChapter = workspace.chapters[targetChapterId];
    if (!entry || !targetProject || !targetChapter || targetChapter.projectId !== targetProjectId) {
      clearDragState();
      return;
    }

    if (entry.projectId === targetProjectId && entry.chapterId === targetChapterId) {
      clearDragState();
      return;
    }

    mutateWorkspace((draft) => {
      const movedEntry = draft.entries[entryId];
      const destinationProject = draft.projects[targetProjectId];
      const destinationChapter = draft.chapters[targetChapterId];
      if (
        !movedEntry ||
        !destinationProject ||
        !destinationChapter ||
        destinationChapter.projectId !== targetProjectId
      ) {
        return;
      }

      const sourceChapter = draft.chapters[movedEntry.chapterId];
      if (sourceChapter) {
        sourceChapter.entryIds = sourceChapter.entryIds.filter((id) => id !== entryId);
      }

      if (!destinationChapter.entryIds.includes(entryId)) {
        destinationChapter.entryIds.push(entryId);
      }

      movedEntry.projectId = targetProjectId;
      movedEntry.chapterId = targetChapterId;
      draft.activeProjectId = targetProjectId;
      draft.activeChapterId = targetChapterId;
      draft.selectedEntryId = entryId;
    });

    setSelectedChapterIds([targetChapterId]);
    setSelectedEntryIds([entryId]);
    chapterSelectionAnchorRef.current = targetChapterId;
    entrySelectionAnchorRef.current = entryId;
    setCollapsedProjectIds((previous) => previous.filter((id) => id !== targetProjectId));
    setExpandedChapterIds((previous) =>
      previous.includes(targetChapterId) ? previous : [...previous, targetChapterId],
    );
    setNavigationScope("entry");
    setStorageStatus("史料已移至章節。");
    clearDragState();
  }

  function onEntryDrop(targetEntryId: string): void {
    if (!dragPayload || dragPayload.type !== "entry" || !activeProject) {
      return;
    }

    const sameScope =
      dragPayload.projectId === activeProject.id && dragPayload.chapterId === activeChapter?.id;
    if (!sameScope || !activeChapter) {
      return;
    }

    mutateWorkspace((draft) => {
      const chapter = draft.chapters[activeChapter.id];
      if (!chapter) {
        return;
      }
      chapter.entryIds = reorderById(chapter.entryIds, dragPayload.id, targetEntryId);
    });

    clearDragState();
  }

  function openAdvancedSearchModal(): void {
    const fallbackProjectId = activeProject?.id ?? workspace.projectOrder[0] ?? "";
    const fallbackChapterId =
      activeChapter?.id && workspace.chapters[activeChapter.id]?.projectId === fallbackProjectId
        ? activeChapter.id
        : workspace.projects[fallbackProjectId]?.chapterIds[0] ?? "";

    activateOverlayModal("advanced");
    setAdvancedModal({
      open: true,
      query: globalQuery,
      queryScopes: DEFAULT_ADVANCED_QUERY_SCOPES,
      tag: "",
      citationTitle: "",
      targetMode: "new-project",
      newProjectTitle: "按檢索結果分類",
      newChapterTitle: "檢索結果",
      existingProjectId: fallbackProjectId,
      existingChapterId: fallbackChapterId,
    });
    setNavigationScope("advanced");
  }

  function collectEntryDraftsByResults(results: SearchResult[]): EntryDraft[] {
    return results
      .map((result) => workspace.entries[result.entryId])
      .filter((entry): entry is Entry => Boolean(entry))
      .map(entryToDraft);
  }

  function importAdvancedResults(): void {
    if (!hasAdvancedSearch) {
      window.alert("請至少輸入一個檢索條件。");
      return;
    }
    if (advancedModal.query.trim() && !hasAdvancedQueryScope) {
      window.alert("請至少勾選一個關鍵字檢索欄位。");
      return;
    }

    const drafts = collectEntryDraftsByResults(advancedResults);
    if (drafts.length === 0) {
      window.alert("沒有可匯入的檢索結果。");
      return;
    }

    if (advancedModal.targetMode === "new-project") {
      mutateWorkspace((draft) => {
        const projectId = createId("project");
        const title = ensureUniqueProjectTitle(draft, advancedModal.newProjectTitle.trim() || "按檢索結果分類");
        draft.projects[projectId] = {
          id: projectId,
          title,
          chapterIds: [],
          createdAt: Date.now(),
        };
        draft.projectOrder.push(projectId);

        // 史料一律落在章節之下，新專案同時建立承載章節。
        const chapterId = createId("chapter");
        draft.chapters[chapterId] = {
          id: chapterId,
          projectId,
          title: advancedModal.newChapterTitle.trim() || "檢索結果",
          entryIds: [],
          createdAt: Date.now(),
        };
        draft.projects[projectId].chapterIds.push(chapterId);

        let firstEntryId: string | null = null;
        for (const item of drafts) {
          const entryId = appendEntryDraft(draft, projectId, chapterId, item);
          if (!firstEntryId) {
            firstEntryId = entryId;
          }
        }

        draft.activeProjectId = projectId;
        draft.activeChapterId = chapterId;
        draft.selectedEntryId = firstEntryId;
      });

      setAdvancedModal((state) => ({ ...state, open: false }));
      return;
    }

    if (advancedModal.targetMode === "new-chapter") {
      const targetProjectId = advancedModal.existingProjectId;
      if (!workspace.projects[targetProjectId]) {
        window.alert("請先選擇要建立新章節的目標專案。");
        return;
      }

      mutateWorkspace((draft) => {
        const project = draft.projects[targetProjectId];
        if (!project) {
          return;
        }

        const chapterId = createId("chapter");
        draft.chapters[chapterId] = {
          id: chapterId,
          projectId: targetProjectId,
          title: advancedModal.newChapterTitle.trim() || "檢索結果",
          entryIds: [],
          createdAt: Date.now(),
        };
        project.chapterIds.push(chapterId);

        let firstEntryId: string | null = null;
        for (const item of drafts) {
          const entryId = appendEntryDraft(draft, targetProjectId, chapterId, item);
          if (!firstEntryId) {
            firstEntryId = entryId;
          }
        }

        draft.activeProjectId = targetProjectId;
        draft.activeChapterId = chapterId;
        draft.selectedEntryId = firstEntryId;
      });

      setAdvancedModal((state) => ({ ...state, open: false }));
      return;
    }

    const targetChapter = workspace.chapters[advancedModal.existingChapterId];
    if (!targetChapter) {
      window.alert("請先選擇目標章節。");
      return;
    }

    mutateWorkspace((draft) => {
      const chapter = draft.chapters[targetChapter.id];
      if (!chapter) {
        return;
      }

      let firstEntryId: string | null = null;
      for (const item of drafts) {
        const entryId = appendEntryDraft(draft, chapter.projectId, chapter.id, item);
        if (!firstEntryId) {
          firstEntryId = entryId;
        }
      }

      draft.activeProjectId = chapter.projectId;
      draft.activeChapterId = chapter.id;
      draft.selectedEntryId = firstEntryId;
    });

    setAdvancedModal((state) => ({ ...state, open: false }));
  }

  function openMergeModal(): void {
    setMergeModal({
      open: true,
      mode: "as-new",
      selectedProjectIds: workspace.projectOrder.slice(0, Math.min(2, workspace.projectOrder.length)),
      newProjectTitle: "合併專案",
    });
  }

  function executeMerge(): void {
    const selectedIds = mergeModal.selectedProjectIds.filter((id) => Boolean(workspace.projects[id]));
    if (selectedIds.length === 0) {
      window.alert("請先選擇至少一個專案。");
      return;
    }

    if (mergeModal.mode === "into-active") {
      if (!activeProject) {
        window.alert("目前沒有可合併到的當前專案。");
        return;
      }

      const sourceIds = selectedIds.filter((id) => id !== activeProject.id);
      if (sourceIds.length === 0) {
        window.alert("請至少選擇一個非當前專案作為合併來源。");
        return;
      }

      const snapshots = sourceIds
        .map((projectId) => collectProjectSnapshot(workspace, projectId))
        .filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));

      mutateWorkspace((draft) => {
        let firstEntryId: string | null = null;
        for (const snapshot of snapshots) {
          const candidate = appendSnapshotToProject(draft, activeProject.id, snapshot, true);
          if (!firstEntryId && candidate) {
            firstEntryId = candidate;
          }
        }

        draft.activeProjectId = activeProject.id;
        draft.activeChapterId = null;
        if (firstEntryId) {
          draft.selectedEntryId = firstEntryId;
        }
      });

      setMergeModal((state) => ({ ...state, open: false }));
      return;
    }

    const snapshots = selectedIds
      .map((projectId) => collectProjectSnapshot(workspace, projectId))
      .filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));

    mutateWorkspace((draft) => {
      const projectId = createId("project");
      const title = ensureUniqueProjectTitle(draft, mergeModal.newProjectTitle.trim() || "合併專案");
      draft.projects[projectId] = {
        id: projectId,
        title,
        chapterIds: [],
        createdAt: Date.now(),
      };
      draft.projectOrder.push(projectId);

      let firstEntryId: string | null = null;
      for (const snapshot of snapshots) {
        const candidate = appendSnapshotToProject(draft, projectId, snapshot, true);
        if (!firstEntryId && candidate) {
          firstEntryId = candidate;
        }
      }

      draft.activeProjectId = projectId;
      draft.activeChapterId = null;
      draft.selectedEntryId = firstEntryId;
    });

    setMergeModal((state) => ({ ...state, open: false }));
  }

  function openChapterMergeModal(): void {
    const allChapterIds = workspace.projectOrder.flatMap(
      (projectId) => workspace.projects[projectId]?.chapterIds ?? [],
    );
    const initialChapterIds =
      activeProject && activeProject.chapterIds.length > 0
        ? activeProject.chapterIds.slice(0, Math.min(2, activeProject.chapterIds.length))
        : allChapterIds.slice(0, Math.min(2, allChapterIds.length));

    setChapterMergeModal({
      open: true,
      selectedChapterIds: initialChapterIds,
      targetProjectId: activeProject?.id ?? workspace.projectOrder[0] ?? "",
      newChapterTitle: "合併章節",
    });
  }

  function executeChapterMerge(): void {
    if (!workspace.projects[chapterMergeModal.targetProjectId]) {
      window.alert("請先選擇目標專案。");
      return;
    }

    const selectedChapterIds = chapterMergeModal.selectedChapterIds.filter((chapterId) =>
      Boolean(workspace.chapters[chapterId]),
    );
    if (selectedChapterIds.length < 2) {
      window.alert("請至少選擇兩個章節。");
      return;
    }

    const drafts = selectedChapterIds.flatMap((chapterId) => {
      const chapter = workspace.chapters[chapterId];
      if (!chapter) {
        return [];
      }
      return chapter.entryIds
        .map((entryId) => workspace.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map(entryToDraft);
    });

    if (drafts.length === 0) {
      window.alert("所選章節沒有可合併的史料。");
      return;
    }

    mutateWorkspace((draft) => {
      const chapterId = createId("chapter");
      const project = draft.projects[chapterMergeModal.targetProjectId];
      if (!project) {
        return;
      }

      draft.chapters[chapterId] = {
        id: chapterId,
        projectId: chapterMergeModal.targetProjectId,
        title: chapterMergeModal.newChapterTitle.trim() || "合併章節",
        entryIds: [],
        createdAt: Date.now(),
      };
      project.chapterIds.push(chapterId);

      let firstEntryId: string | null = null;
      for (const item of drafts) {
        const entryId = appendEntryDraft(draft, project.id, chapterId, item);
        if (!firstEntryId) {
          firstEntryId = entryId;
        }
      }

      draft.activeProjectId = project.id;
      draft.activeChapterId = chapterId;
      draft.selectedEntryId = firstEntryId;
    });

    setChapterMergeModal((state) => ({ ...state, open: false }));
  }

  async function refreshStorageInfo(): Promise<void> {
    if (!window.workspaceBridge) {
      return;
    }

    try {
      if (window.workspaceBridge.getWorkspaceStorageInfo) {
        const info = await window.workspaceBridge.getWorkspaceStorageInfo();
        setStorageInfo(info);
        setStoragePathDraft(info.path);
        return;
      }

      if (window.workspaceBridge.getSharedWorkspacePath) {
        const path = await window.workspaceBridge.getSharedWorkspacePath();
        const fallbackInfo: WorkspaceStorageInfo = {
          path,
          defaultPath: path,
          envLocked: false,
          envPath: null,
        };
        setStorageInfo(fallbackInfo);
        setStoragePathDraft(path);
      }
    } catch {
      setStorageStatus("讀取資料路徑失敗。");
    }
  }

  function openStorageModal(): void {
    setStorageStatus("");
    setStorageSaveAsModalOpen(false);
    setStorageFormatInfoModalOpen(false);
    setStorageModalOpen(true);
    void refreshStorageInfo();
  }

  function closeStorageModal(): void {
    setStorageModalOpen(false);
    setStorageSaveAsModalOpen(false);
    setStorageFormatInfoModalOpen(false);
  }

  function hasUnsavedEntryDraft(state: ModalState): boolean {
    if (!state) {
      return false;
    }
    if (state.kind === "entry-create") {
      return !entryDraftsEqual(state.draft, createEmptyEntryDraft());
    }
    if (state.kind === "entry-edit") {
      const entry = workspaceRef.current.entries[state.entryId];
      return Boolean(entry) && !entryDraftsEqual(state.draft, entryToDraft(entry));
    }
    return false;
  }

  function requestCloseOverlayModal(key: string): void {
    if (storageBusy && (key === "storage" || key === "storage-save-as")) {
      return;
    }
    if (key.startsWith("view:")) {
      closeEntryViewWindow(key.slice("view:".length));
      return;
    }
    switch (key) {
      case "storage":
        closeStorageModal();
        return;
      case "trash":
        setTrashModalOpen(false);
        return;
      case "storage-save-as":
        setStorageSaveAsModalOpen(false);
        return;
      case "storage-format-info":
        setStorageFormatInfoModalOpen(false);
        return;
      case "advanced":
        setAdvancedModal((state) => ({ ...state, open: false }));
        return;
      case "merge-project":
        setMergeModal((state) => ({ ...state, open: false }));
        return;
      case "merge-chapter":
        setChapterMergeModal((state) => ({ ...state, open: false }));
        return;
      case "compare":
        setCompareState(null);
        return;
      case "similar-overview":
        setSimilarOverviewOpen(false);
        return;
      default:
        if (hasUnsavedEntryDraft(modalState) && !window.confirm("這條史料尚未保存，確定放棄修改嗎？")) {
          return;
        }
        setModalState(null);
    }
  }

  function buildWorkspaceForSave(scope: "active" | "all"): WorkspaceData | null {
    if (scope === "all") {
      return cleanupWorkspace(workspace);
    }

    if (!activeProject) {
      return null;
    }

    const project = workspace.projects[activeProject.id];
    if (!project) {
      return null;
    }

    const next: WorkspaceData = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision: workspace.revision,
      projectOrder: [project.id],
      projects: {
        [project.id]: structuredClone(project),
      },
      chapters: {},
      entries: {},
      trash: [],
      activeProjectId: project.id,
      activeChapterId: null,
      selectedEntryId: null,
    };

    for (const chapterId of project.chapterIds) {
      const chapter = workspace.chapters[chapterId];
      if (!chapter || chapter.projectId !== project.id) {
        continue;
      }
      next.chapters[chapterId] = structuredClone(chapter);
    }

    const entryIds = new Set<string>();
    for (const chapter of Object.values(next.chapters)) {
      for (const entryId of chapter.entryIds) {
        entryIds.add(entryId);
      }
    }

    for (const entryId of entryIds) {
      const entry = workspace.entries[entryId];
      if (!entry || entry.projectId !== project.id) {
        continue;
      }
      next.entries[entryId] = structuredClone(entry);
    }

    if (workspace.activeChapterId && next.chapters[workspace.activeChapterId]) {
      next.activeChapterId = workspace.activeChapterId;
    }
    if (workspace.selectedEntryId && next.entries[workspace.selectedEntryId]) {
      next.selectedEntryId = workspace.selectedEntryId;
    }

    return cleanupWorkspace(next);
  }

  async function backupWorkspaceToFile(scope: "active" | "all"): Promise<void> {
    if (!window.workspaceBridge?.exportWorkspaceFile) {
      setStorageStatus("目前版本不支持備份到。");
      return;
    }

    const payload = buildWorkspaceForSave(scope);
    if (!payload) {
      setStorageStatus("找不到可備份的專案。");
      return;
    }

    const timestamp = new Date();
    const backupStamp = `${timestamp.getFullYear()}${String(timestamp.getMonth() + 1).padStart(2, "0")}${String(
      timestamp.getDate(),
    ).padStart(2, "0")}-${String(timestamp.getHours()).padStart(2, "0")}${String(
      timestamp.getMinutes(),
    ).padStart(2, "0")}${String(timestamp.getSeconds()).padStart(2, "0")}`;
    const suggestedFileName =
      scope === "all"
        ? `長編工作臺-全部專案-備份-${backupStamp}.json`
        : `長編工作臺-${sanitizeFileNameSegment(activeProject?.title || "當前專案") || "當前專案"}-備份-${backupStamp}.json`;

    setStorageBusy(true);
    setStorageStatus("");
    try {
      const result = await window.workspaceBridge.exportWorkspaceFile(payload, suggestedFileName);
      if (!result.ok) {
        if (result.canceled) {
          setStorageStatus("已取消備份。");
        } else {
          setStorageStatus(result.error || "備份失敗。");
        }
        return;
      }

      setStorageSaveAsModalOpen(false);
      setStorageStatus(`已備份到：${result.path ?? suggestedFileName}`);
    } catch {
      setStorageStatus("備份檔案時發生錯誤。");
    } finally {
      setStorageBusy(false);
    }
  }

  function mergeImportedWorkspace(
    current: WorkspaceData,
    importedRaw: WorkspaceData,
  ): { workspace: WorkspaceData; addedProjects: number; addedEntries: number } {
    const imported = cleanupWorkspace(importedRaw);
    const next = structuredClone(current);
    let addedProjects = 0;
    let addedEntries = 0;
    // 匯入條目的編號：未被佔用就沿用，否則按原建立時間順延；備註中指向它們的鏈接一併改寫。
    const usedRefIds = usedEntryRefIds(next);
    const refIdMap = new Map<string, string>();
    const addedEntryIds: string[] = [];

    for (const importedProjectId of imported.projectOrder) {
      const importedProject = imported.projects[importedProjectId];
      if (!importedProject) {
        continue;
      }

      const nextProjectId = createId("project");
      const nextProjectTitle = ensureUniqueProjectTitle(next, importedProject.title || "匯入專案");
      next.projects[nextProjectId] = {
        id: nextProjectId,
        title: nextProjectTitle,
        chapterIds: [],
        createdAt: Date.now(),
      };
      next.projectOrder.push(nextProjectId);
      addedProjects += 1;

      for (const importedChapterId of importedProject.chapterIds) {
        const importedChapter = imported.chapters[importedChapterId];
        if (!importedChapter || importedChapter.projectId !== importedProjectId) {
          continue;
        }

        const nextChapterId = createId("chapter");
        const nextChapterTitle = ensureUniqueChapterTitle(
          next,
          nextProjectId,
          importedChapter.title || "新章節",
        );
        next.chapters[nextChapterId] = {
          id: nextChapterId,
          projectId: nextProjectId,
          title: nextChapterTitle,
          entryIds: [],
          createdAt: Date.now(),
        };
        next.projects[nextProjectId].chapterIds.push(nextChapterId);

        for (const importedEntryId of importedChapter.entryIds) {
          const importedEntry = imported.entries[importedEntryId];
          if (!importedEntry || importedEntry.projectId !== importedProjectId || importedEntry.chapterId !== importedChapterId) {
            continue;
          }
          const nextEntryId = createId("entry");
          const refId = usedRefIds.has(importedEntry.refId)
            ? nextFreeEntryRefId(importedEntry.createdAt, usedRefIds)
            : importedEntry.refId;
          usedRefIds.add(refId);
          if (refId !== importedEntry.refId) {
            refIdMap.set(importedEntry.refId, refId);
          }
          next.entries[nextEntryId] = {
            ...importedEntry,
            id: nextEntryId,
            refId,
            projectId: nextProjectId,
            chapterId: nextChapterId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          next.chapters[nextChapterId].entryIds.push(nextEntryId);
          addedEntryIds.push(nextEntryId);
          addedEntries += 1;
        }
      }
    }

    for (const entryId of addedEntryIds) {
      const entry = next.entries[entryId];
      entry.note = rewriteEntryRefs(entry.note, refIdMap);
    }

    return {
      workspace: cleanupWorkspace(next),
      addedProjects,
      addedEntries,
    };
  }

  async function importWorkspaceFromFile(): Promise<void> {
    if (!window.workspaceBridge?.importWorkspaceFile) {
      setStorageStatus("目前版本不支持匯入檔案。");
      return;
    }

    setStorageBusy(true);
    setStorageStatus("");
    try {
      const result = await window.workspaceBridge.importWorkspaceFile();
      if (!result.ok) {
        if (result.canceled) {
          setStorageStatus("已取消匯入。");
        } else {
          setStorageStatus(result.error || "匯入失敗。");
        }
        return;
      }

      if (!result.data || typeof result.data !== "object") {
        setStorageStatus("匯入失敗：檔案內容不是有效工作臺資料。");
        return;
      }

      const shouldMerge = window.confirm(
        "匯入會把檔案內容加入目前工作臺，不會覆蓋或刪除現有資料。是否繼續？",
      );
      if (!shouldMerge) {
        setStorageStatus("已取消匯入。");
        return;
      }

      const { workspace: mergedWorkspace, addedProjects, addedEntries } = mergeImportedWorkspace(
        workspace,
        result.data as WorkspaceData,
      );
      setWorkspace(mergedWorkspace);
      setStorageStatus(
        `已匯入並加入：${addedProjects} 個專案、${addedEntries} 條史料（來源：${result.path ?? "未命名檔案"}）。`,
      );
      setStorageSaveAsModalOpen(false);
      setStorageFormatInfoModalOpen(false);
    } catch {
      setStorageStatus("匯入檔案時發生錯誤。");
    } finally {
      setStorageBusy(false);
    }
  }

  async function chooseStoragePath(): Promise<void> {
    if (!window.workspaceBridge?.pickSharedWorkspacePath) {
      setStorageStatus("目前版本不支持檔案選擇器。");
      return;
    }

    try {
      const pickedPath = await window.workspaceBridge.pickSharedWorkspacePath();
      if (pickedPath) {
        setStoragePathDraft(pickedPath);
        setStorageStatus("");
      }
    } catch {
      setStorageStatus("打開檔案選擇器失敗。");
    }
  }

  async function applyStoragePath(): Promise<void> {
    if (!window.workspaceBridge?.setSharedWorkspacePath) {
      setStorageStatus("目前版本不支持資料路徑切換。");
      return;
    }

    const nextPath = storagePathDraft.trim();
    if (!nextPath) {
      setStorageStatus("請先輸入有效的資料檔路徑。");
      return;
    }

    setStorageBusy(true);
    setStorageStatus("");
    try {
      const result = await window.workspaceBridge.setSharedWorkspacePath(nextPath, workspace);
      if (!result.ok) {
        setStorageStatus(result.error || "切換失敗。");
        return;
      }

      if (Number.isInteger(result.revision)) {
        sharedRevisionRef.current = result.revision ?? sharedRevisionRef.current;
      }
      lastPersistedSignatureRef.current = workspaceContentSignature(workspace);
      setStorageStatus(`已切換資料位置：${result.path ?? nextPath}`);
      await refreshStorageInfo();
    } catch {
      setStorageStatus("切換資料路徑時發生錯誤。");
    } finally {
      setStorageBusy(false);
    }
  }

  async function resetStoragePath(): Promise<void> {
    if (!window.workspaceBridge?.resetSharedWorkspacePath) {
      setStorageStatus("目前版本不支持重設資料路徑。");
      return;
    }

    setStorageBusy(true);
    setStorageStatus("");
    try {
      const result = await window.workspaceBridge.resetSharedWorkspacePath(workspace);
      if (!result.ok) {
        setStorageStatus(result.error || "重設失敗。");
        return;
      }

      if (Number.isInteger(result.revision)) {
        sharedRevisionRef.current = result.revision ?? sharedRevisionRef.current;
      }
      lastPersistedSignatureRef.current = workspaceContentSignature(workspace);
      setStorageStatus(`已恢復預設資料位置：${result.path ?? ""}`);
      await refreshStorageInfo();
    } catch {
      setStorageStatus("重設資料路徑時發生錯誤。");
    } finally {
      setStorageBusy(false);
    }
  }

  async function reloadWorkspaceFromStorage(): Promise<void> {
    if (!window.workspaceBridge?.loadSharedWorkspace) {
      setStorageStatus("目前版本不支持從資料檔重載。");
      return;
    }

    setStorageBusy(true);
    setStorageStatus("");
    try {
      const result = await window.workspaceBridge.loadSharedWorkspace();
      if (!result.ok) {
        setStorageStatus(result.error || "重新載入資料失敗。");
        return;
      }
      if (!result.workspace || typeof result.workspace !== "object") {
        setStorageStatus("當前資料檔尚無可載入資料。");
        return;
      }

      const next = cleanupWorkspace(result.workspace as WorkspaceData);
      sharedRevisionRef.current = result.revision ?? next.revision;
      lastPersistedSignatureRef.current = result.needsSave ? "" : workspaceContentSignature(next);
      workspaceRef.current = next;
      setWorkspace(next);
      setStorageStatus("已從資料檔重新載入。");
    } catch {
      setStorageStatus("重新載入資料失敗。");
    } finally {
      setStorageBusy(false);
    }
  }

  async function exportWord(): Promise<void> {
    setIsExportingDocx(true);
    try {
      const { exportAsDocx } = await import("./exporters");
      await exportAsDocx(workspace, exportScope);
    } finally {
      setIsExportingDocx(false);
    }
  }

  async function exportText(): Promise<void> {
    const { exportAsTxt } = await import("./exporters");
    exportAsTxt(workspace, exportScope);
  }

  async function exportExcel(): Promise<void> {
    const { exportAsXlsx } = await import("./exporters");
    exportAsXlsx(workspace, exportScope);
  }

  const desktopMeta = window.desktopMeta;
  const formModal =
    modalState &&
    (modalState.kind === "project-create" ||
      modalState.kind === "project-rename" ||
      modalState.kind === "chapter-create" ||
      modalState.kind === "chapter-rename")
      ? modalState
      : null;
  const entryModal =
    modalState && (modalState.kind === "entry-edit" || modalState.kind === "entry-create")
      ? modalState
      : null;
  const compareView = (() => {
    if (!compareState || !compareResult) {
      return null;
    }
    const leftEntry = workspace.entries[compareState.leftEntryId];
    const rightEntry = workspace.entries[compareState.rightEntryId];
    if (!leftEntry || !rightEntry) {
      return null;
    }
    const { left, right } = compareResult;
    // 異文表每列顯示差異前的幾個字作為上下文；表中不顯示 **粗體** 等標記符號。
    const withoutMarkers = (text: string) => text.replace(/\*\*|__|\*/g, "");
    const contextBefore = (text: string, starts: number[], tokenIndex: number) =>
      withoutMarkers(text.slice(starts[Math.max(0, tokenIndex - 4)] ?? text.length, starts[tokenIndex] ?? text.length));
    const segment = (text: string, comparable: typeof left, start: number, end: number) =>
      start < end ? withoutMarkers(text.slice(comparable.starts[start], comparable.ends[end - 1])) : "";
    const rows = compareResult.hunks.map((hunk) => {
      const leftSegment = segment(leftEntry.sourceText, left, hunk.aStart, hunk.aEnd);
      const rightSegment = segment(rightEntry.sourceText, right, hunk.bStart, hunk.bEnd);
      return {
        kind: leftSegment && rightSegment ? "異文" : leftSegment ? "左有右無" : "右有左無",
        leftContext: contextBefore(leftEntry.sourceText, left.starts, hunk.aStart),
        rightContext: contextBefore(rightEntry.sourceText, right.starts, hunk.bStart),
        leftSegment,
        rightSegment,
      };
    });
    // marks 標的是此側獨有的字；標相同時取反，即兩側共有的字（只比段落時，段落以外的不算）。
    const blocks = compareResult.blocks?.length ? compareResult.blocks : null;
    const side = (
      entry: Entry,
      comparable: typeof left,
      onlyHere: Uint8Array,
      outside: Uint8Array | null,
      sideBlocks: Array<{ start: number; end: number; index: number }> | null,
      diffClass: string,
    ) => {
      const marks =
        compareMarkMode === "same" ? onlyHere.map((value, index) => (value || outside?.[index] ? 0 : 1)) : onlyHere;
      const className = compareMarkMode === "same" ? "diff-same" : diffClass;
      const ranges = markedRanges(comparable, marks);
      return {
        entryId: entry.id,
        key: `${diffClass}-${entry.id}`,
        path: `${workspace.projects[entry.projectId]?.title ?? "未命名專案"} / ${workspace.chapters[entry.chapterId]?.title ?? "未命名章節"}`,
        title: formatEntryHeadline(entry.timeText, entry.summary ?? ""),
        citation: entry.citation.trim(),
        sourceLabel: shortSourceLabel(entry),
        html: applyLightMarkup(
          sideBlocks
            ? renderAlignedText(entry.sourceText, comparable, ranges, sideBlocks, className, Boolean(outside))
            : wrapTextRanges(entry.sourceText, ranges, className),
        ),
      };
    };
    return {
      result: compareResult,
      blocks,
      // 要求只比對齊段落、卻沒找到任何段落（已退回全文比勘）。
      noBlocks: compareResult.blocks !== null && compareResult.blocks.length === 0,
      rows,
      variantCount: rows.filter((row) => row.kind === "異文").length,
      leftOnlyCount: rows.filter((row) => row.kind === "左有右無").length,
      rightOnlyCount: rows.filter((row) => row.kind === "右有左無").length,
      sides: [
        side(
          leftEntry,
          left,
          compareResult.leftMarks,
          compareResult.leftOutside,
          blocks && blocks.map((block, index) => ({ start: block.aStart, end: block.aEnd, index })),
          "diff-left",
        ),
        side(
          rightEntry,
          right,
          compareResult.rightMarks,
          compareResult.rightOutside,
          blocks && blocks.map((block, index) => ({ start: block.bStart, end: block.bEnd, index })),
          "diff-right",
        ),
      ],
    };
  })();
  // 所有窗口共用的右上角關閉按鈕：與 Esc 走同一個關閉流程（含未保存提示、忙碌時不可關）。
  function renderModalClose(key: string) {
    const busy = storageBusy && (key === "storage" || key === "storage-save-as");
    return (
      <button
        type="button"
        className="modal-close-btn"
        aria-label="關閉"
        title={busy ? "處理中，請稍候" : "關閉（Esc）"}
        disabled={busy}
        onClick={() => requestCloseOverlayModal(key)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    );
  }

  // 一個「檢視史料」窗口（可同時打開多個）。
  function renderEntryViewWindow(win: EntryViewWindow) {
    const viewedEntry = workspace.entries[win.entryId];
    if (!viewedEntry) {
      return null;
    }
    const key = entryViewKey(win.winId);
    const entryViewModal = win;
    const viewedEntryDraft = win.draft;
    const entryViewHighlightQuery = win.highlightQuery.trim();
    const viewedEntrySimilar = similarSummary.get(viewedEntry.id) ?? [];
    const viewedEntryBacklinks = (backlinksByRefId.get(viewedEntry.refId) ?? [])
      .map((entryId) => workspace.entries[entryId])
      .filter((entry): entry is Entry => Boolean(entry));
    return (
        <div key={key} className="modal-backdrop" style={modalBackdropStyle(key)}>
          <div
            className="modal-card modal-large entry-view-modal draggable-modal"
            style={modalCardStyle(key)}
            data-view-key={key}
            tabIndex={-1}
            onMouseDown={(event) => {
              activateOverlayModal(key);
              event.stopPropagation();
            }}
          >
            {renderModalClose(key)}
            <div
              className="modal-head entry-view-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, key)}
            >
              <div className="entry-view-head-main">
                <div className="entry-view-title-row">
                  <h3>{entryViewModal.editing ? "編輯史料" : "檢視史料"}</h3>
                  {!entryViewModal.editing &&
                    renderSimilarBadge(
                      viewedEntry.id,
                      () =>
                        document
                          .getElementById(`${key}-similar`)
                          ?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
                      "點擊跳到下方列表。",
                    )}
                  {!entryViewModal.editing && viewedEntryBacklinks.length > 0 && (
                    <button
                      type="button"
                      className="similar-badge backlink-badge"
                      title={`有 ${viewedEntryBacklinks.length} 條在備註中鏈接到這一條。點擊跳到下方列表。`}
                      onClick={() =>
                        document
                          .getElementById(`${key}-backlinks`)
                          ?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                      }
                    >
                      <span dangerouslySetInnerHTML={{ __html: ENTRY_REF_ICON }} />
                      <span>反向鏈接</span>
                      <strong>{viewedEntryBacklinks.length}</strong>
                    </button>
                  )}
                </div>
                <p className="meta-text">
                  {workspace.projects[viewedEntry.projectId]?.title || "未命名專案"} /{" "}
                  {workspace.chapters[viewedEntry.chapterId]?.title || "未命名章節"}
                </p>
              </div>
            </div>

            <div className="modal-grid entry-view-grid">
              <section className="entry-view-block">
                <div className="entry-view-title">時間</div>
                {entryViewModal.editing ? (
                  <input
                    autoFocus
                    value={viewedEntryDraft?.timeText ?? ""}
                    onChange={(event) => updateEntryViewDraft(win.winId, { timeText: event.target.value })}
                    placeholder="如：萬曆二十年春 / 1644年 / 未詳"
                  />
                ) : (
                  <div
                    className="entry-view-text"
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightedPlainText(
                        viewedEntryDraft?.timeText.trim() || "未著錄時間",
                        entryViewHighlightQuery,
                      ),
                    }}
                  />
                )}
              </section>

              <section className="entry-view-block">
                <div className="entry-view-title">摘要</div>
                {entryViewModal.editing ? (
                  <input
                    value={viewedEntryDraft?.summary ?? ""}
                    onChange={(event) => updateEntryViewDraft(win.winId, { summary: event.target.value })}
                    placeholder="例如：張居正改革前夕的朝議分歧"
                  />
                ) : (
                  <div
                    className="entry-view-text"
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightedPlainText(
                        viewedEntryDraft?.summary.trim() || "（無摘要）",
                        entryViewHighlightQuery,
                      ),
                    }}
                  />
                )}
              </section>

              <section className="entry-view-block">
                <div className="entry-view-title">史料文本</div>
                {entryViewModal.editing ? (
                  <>
                    <div className="format-toolbar">
                      <button
                        type="button"
                        className="icon-btn format-btn"
                        aria-label="加粗"
                        aria-pressed={sourceFormatState.bold}
                        title="粗體（⌘B）"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applySourceMarker("bold")}
                      >
                        B
                      </button>
                      <button
                        type="button"
                        className="icon-btn format-btn"
                        aria-label="斜體"
                        aria-pressed={sourceFormatState.italic}
                        title="斜體（⌘I）"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applySourceMarker("italic")}
                      >
                        I
                      </button>
                      <button
                        type="button"
                        className="icon-btn format-btn"
                        aria-label="下劃線"
                        aria-pressed={sourceFormatState.underline}
                        title="下劃線（⌘U）"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applySourceMarker("underline")}
                      >
                        U
                      </button>
                      <span className="format-tip">語法：`**粗體**` `*斜體*` `__下劃線__`</span>
                    </div>
                    <textarea
                      ref={entrySourceTextareaRef}
                      rows={8}
                      value={viewedEntryDraft?.sourceText ?? ""}
                      onChange={(event) => updateEntryViewDraft(win.winId, { sourceText: event.target.value })}
                      onClick={syncSourceFormatState}
                      onKeyDown={handleSourceShortcut}
                      onKeyUp={syncSourceFormatState}
                      onSelect={syncSourceFormatState}
                      placeholder="輸入原始史料文本..."
                    />
                  </>
                ) : viewedEntryDraft?.sourceText.trim() ? (
                  <div
                    className="entry-view-source rich-markup"
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightedLightMarkup(
                        viewedEntryDraft.sourceText.trim(),
                        entryViewHighlightQuery,
                      ),
                    }}
                  />
                ) : (
                  <div className="entry-view-text">（尚未輸入史料文本）</div>
                )}
              </section>

              <section className="entry-view-block">
                <div className="entry-view-title">備註</div>
                {entryViewModal.editing ? (
                  <textarea
                    rows={5}
                    value={viewedEntryDraft?.note ?? ""}
                    onChange={(event) => updateEntryViewDraft(win.winId, { note: event.target.value })}
                    placeholder="例如：#政治 #人物關係 #萬曆朝 ..."
                  />
                ) : (
                  <div
                    className="entry-view-note"
                    onClick={handleEntryRefClick}
                    dangerouslySetInnerHTML={{
                      __html: renderNoteWithRefs(viewedEntryDraft?.note.trim() || "（無備註）", entryViewHighlightQuery),
                    }}
                  />
                )}
              </section>

              <section className="entry-view-block">
                <div className="entry-view-title">引文註釋</div>
                {entryViewModal.editing ? (
                  <textarea
                    rows={5}
                    value={viewedEntryDraft?.citation ?? ""}
                    onChange={(event) => updateEntryViewDraft(win.winId, { citation: event.target.value })}
                    placeholder="如：某某書卷X，某某頁；可含《書名》供後續聚合"
                  />
                ) : (
                  <div
                    className="entry-view-citation"
                    dangerouslySetInnerHTML={{
                      __html: renderHighlightedPlainText(
                        viewedEntryDraft?.citation.trim() || "（無引文註釋）",
                        entryViewHighlightQuery,
                      ),
                    }}
                  />
                )}
              </section>

              {!entryViewModal.editing && viewedEntryBacklinks.length > 0 && (
                <section className="entry-view-block entry-similar-block" id={`${key}-backlinks`}>
                  <div className="entry-view-title entry-similar-head">
                    <span className="entry-ref-head-icon" dangerouslySetInnerHTML={{ __html: ENTRY_REF_ICON }} />
                    反向鏈接
                    <span className="section-count">{viewedEntryBacklinks.length}</span>
                    <span className="section-hint">這些條目在備註中鏈接到本條，點擊檢視</span>
                  </div>
                  <ul className="entry-similar-list backlink-list">
                    {viewedEntryBacklinks.map((entry) => (
                      <li
                        key={entry.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openEntryRef(entry.refId)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            openEntryRef(entry.refId);
                          }
                        }}
                      >
                        <div className="entry-similar-main">
                          <span className="entry-similar-title">
                            {formatEntryHeadline(entry.timeText, entry.summary ?? "")}
                          </span>
                          <span className="search-path">
                            {workspace.projects[entry.projectId]?.title ?? "未命名專案"} /{" "}
                            {workspace.chapters[entry.chapterId]?.title ?? "未命名章節"}
                          </span>
                          <span
                            className="backlink-context"
                            dangerouslySetInnerHTML={{
                              __html: renderNoteWithRefs(excerptAroundRef(entry.note, viewedEntry.refId), ""),
                            }}
                          />
                        </div>
                        <span className="backlink-go">檢視 ›</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!entryViewModal.editing && viewedEntrySimilar.length > 0 && (
                <section className="entry-view-block entry-similar-block" id={`${key}-similar`}>
                  <div className="entry-view-title entry-similar-head">
                    {SIMILAR_ICON}
                    相似文本
                    <span className="section-count">{viewedEntrySimilar.length}</span>
                    <span className="section-hint">點「比勘」或雙擊一行，逐字對照</span>
                  </div>
                  <ul className="entry-similar-list">
                    {viewedEntrySimilar.slice(0, 6).map((item) => {
                      const other = workspace.entries[item.entryId];
                      if (!other) {
                        return null;
                      }
                      return (
                        <li
                          key={item.entryId}
                          onDoubleClick={() => openCompare(viewedEntry.id, item.entryId)}
                          onMouseDown={(event) => {
                            if (event.detail > 1) {
                              event.preventDefault();
                            }
                          }}
                        >
                          <span
                            className="similar-ring"
                            style={{ "--score": String(item.copy ? 1 : item.score) } as CSSProperties}
                            title={item.copy ? "原文完全相同" : `相似度 ${formatPercent(item.score)}`}
                          >
                            <span>{item.copy ? "同" : Math.round(item.score * 100)}</span>
                          </span>
                          <div className="entry-similar-main">
                            <span className="entry-similar-title">
                              {formatEntryHeadline(other.timeText, other.summary ?? "")}
                            </span>
                            <span className="search-path">
                              {workspace.projects[other.projectId]?.title ?? "未命名專案"} /{" "}
                              {workspace.chapters[other.chapterId]?.title ?? "未命名章節"} · 相同 {item.sharedChars}{" "}
                              字 · 一致 {formatPercent(item.identity)}
                            </span>
                          </div>
                          <button
                            className="mini-btn mini-btn-accent"
                            onClick={() => openCompare(viewedEntry.id, item.entryId)}
                          >
                            比勘
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {viewedEntrySimilar.length > 6 && (
                    <button
                      className="text-link"
                      onClick={() => showSimilarFor(viewedEntry.id)}
                    >
                      在右欄查看全部 {viewedEntrySimilar.length} 條 ›
                    </button>
                  )}
                </section>
              )}
            </div>

            <div className="entry-view-footer">
              <div className="entry-view-meta">
                <button
                  type="button"
                  className={copiedRefKey === key ? "entry-id-chip is-copied" : "entry-id-chip"}
                  title={`複製 [[${viewedEntry.refId}]]，貼到其他條目的備註中即可鏈接到這一條`}
                  onClick={() => void copyEntryRefs([viewedEntry.id], key)}
                >
                  <span className="entry-id-chip-icon" dangerouslySetInnerHTML={{ __html: ENTRY_REF_ICON }} />
                  <span className="entry-id-chip-id">{viewedEntry.refId}</span>
                  <span className="entry-id-chip-action">{copiedRefKey === key ? "已複製" : "複製鏈接"}</span>
                </button>
                <p className="meta-text entry-view-time-meta">
                  建立 {formatDateTimeLabel(viewedEntry.createdAt)} · 修改 {formatDateTimeLabel(viewedEntry.updatedAt)}
                </p>
              </div>
              <div className="entry-view-footer-actions">
                {entryViewModal.editing ? (
                  <>
                    <button className="ghost-btn" onClick={() => cancelEntryViewEditing(win.winId)}>
                      取消編輯
                    </button>
                    <button
                      className="secondary-btn"
                      onClick={() => applyEntryViewEditor(win.winId)}
                      title="保存（⌘↵）"
                    >
                      保存修改
                    </button>
                  </>
                ) : (
                  <>
                    <button className="ghost-btn danger-btn" onClick={() => deleteEntry(viewedEntry.id)}>
                      刪除
                    </button>
                    <button
                      className="secondary-btn"
                      onClick={() => beginEditEntry(viewedEntry.id, entryViewHighlightQuery)}
                    >
                      編輯
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
    );
  }

  const modalOpenState: Record<string, boolean> = {
    storage: storageModalOpen,
    trash: trashModalOpen,
    "storage-save-as": storageSaveAsModalOpen,
    "storage-format-info": storageFormatInfoModalOpen,
    form: Boolean(formModal),
    "entry-form": Boolean(entryModal),
    advanced: advancedModal.open,
    "merge-project": mergeModal.open,
    "merge-chapter": chapterMergeModal.open,
    compare: Boolean(compareState && compareResult),
    "similar-overview": similarOverviewOpen,
  };
  // 檢視窗也算打開的窗口（Esc、層疊次序），但不鎖住主界面：只有固定彈窗才讓主界面 inert。
  for (const win of entryViews) {
    modalOpenState[entryViewKey(win.winId)] = true;
  }
  const anyOverlayModalOpen = OVERLAY_MODAL_KEYS.some((key) => modalOpenState[key]);
  const openModalSignature = Object.keys(modalOpenState)
    .filter((key) => modalOpenState[key])
    .join("|");
  const openViewSignature = entryViews.map((win) => win.winId).join("|");
  const showGlobalStorageAlert = Boolean(
    storageStatus && /失敗|衝突|外部|未儲存|拒絕|覆蓋/.test(storageStatus),
  );

  useEffect(() => {
    const previous = modalOpenStateRef.current;
    const openedKeys = Object.keys(modalOpenState).filter((key) => modalOpenState[key] && !previous[key]);
    modalOpenStateRef.current = { ...modalOpenState };
    if (openedKeys.length === 0) {
      return;
    }
    setModalOrders((previousOrders) => {
      const nextOrders = { ...previousOrders };
      for (const key of openedKeys) {
        modalOrderCounterRef.current += 1;
        nextOrders[key] = modalOrderCounterRef.current;
      }
      return nextOrders;
    });
  }, [
    advancedModal.open,
    chapterMergeModal.open,
    Boolean(entryModal),
    openViewSignature,
    Boolean(formModal),
    mergeModal.open,
    storageFormatInfoModalOpen,
    storageSaveAsModalOpen,
    storageModalOpen,
    trashModalOpen,
    modalOpenState.compare,
    similarOverviewOpen,
  ]);

  // 新開或提到最前的檢視窗：把焦點移進去，Esc 才會關到它。
  useEffect(() => {
    const key = pendingViewFocusRef.current;
    if (!key) {
      return;
    }
    pendingViewFocusRef.current = null;
    const card = document.querySelector<HTMLElement>(`[data-view-key="${key}"]`);
    if (card && !(document.activeElement instanceof Node && card.contains(document.activeElement))) {
      card.focus();
    }
  }, [entryViews, modalOrders]);

  useEffect(() => {
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    if (!anyOverlayModalOpen) {
      appShell?.removeAttribute("inert");
      const previous = previousFocusedElementRef.current;
      previousFocusedElementRef.current = null;
      previous?.focus();
      return undefined;
    }

    if (!previousFocusedElementRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusedElementRef.current = document.activeElement;
    }
    appShell?.setAttribute("inert", "");

    const getTopModal = (): HTMLElement | null => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>(".modal-card"));
      return cards.reduce<HTMLElement | null>((top, card) => {
        if (!top) return card;
        const cardZ = Number(window.getComputedStyle(card.parentElement ?? card).zIndex) || 0;
        const topZ = Number(window.getComputedStyle(top.parentElement ?? top).zIndex) || 0;
        return cardZ >= topZ ? card : top;
      }, null);
    };

    const frame = window.requestAnimationFrame(() => {
      const modal = getTopModal();
      if (!modal) return;
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.tabIndex = -1;
      // autoFocus 已聚焦彈窗內欄位時不再搶焦點；沒有輸入欄時聚焦彈窗本身，
      // 避免焦點落在「刪除」等按鈕上被 Enter 誤觸。
      if (document.activeElement instanceof Node && modal.contains(document.activeElement)) {
        return;
      }
      const field = modal.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])',
      );
      (field ?? modal).focus();
    });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const modal = getTopModal();
      if (!modal) return;
      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", trapFocus);
    };
  }, [anyOverlayModalOpen, openModalSignature]);

  return (
    <>
      <div
        className="app-shell"
        data-theme={appearance.theme}
        data-card-style={appearance.cardStyle}
      >
        <div className="ambient ambient-a" />
        <div className="ambient ambient-b" />

        <aside className="left-pane panel">
          <div className="pane-head">
            <div className="pane-title-row">
              <h1>長編工作臺</h1>
              <span
                className={`save-state save-state-${saveState}`}
                role="status"
                aria-live="polite"
                title={storageStatus || SAVE_STATE_LABEL[saveState]}
              >
                <span className="save-state-dot" aria-hidden="true" />
                {SAVE_STATE_LABEL[saveState]}
              </span>
            </div>
            <p className="meta-text">
              {desktopMeta?.isDesktop ? `桌面模式 · ${desktopMeta.platform}` : "瀏覽器模式"}
            </p>
          </div>

          <div className="workspace-action-bar">
            <button className="primary-btn" onClick={() => beginCreateProject()}>
              + 新增專案
            </button>
            <div ref={workspaceMenuRef} className="workspace-menu-wrap">
              <button
                type="button"
                className="ghost-btn overflow-btn"
                aria-label="更多工作臺操作"
                aria-controls="workspace-actions-menu"
                aria-expanded={workspaceMenuOpen}
                onClick={() => setWorkspaceMenuOpen((open) => !open)}
              >
                ⋯
              </button>
              {workspaceMenuOpen && (
                <div
                  id="workspace-actions-menu"
                  className="workspace-menu"
                  role="group"
                  aria-label="工作臺操作"
                >
                  <p className="workspace-menu-label">貼上與合併</p>
                  <button
                    className="workspace-menu-item"
                    disabled={clipboard?.kind !== "project"}
                    onClick={() => {
                      pasteProjectFromClipboard();
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    粘貼專案
                  </button>
                  <button
                    className="workspace-menu-item"
                    disabled={!activeProject || clipboard?.kind !== "chapter"}
                    onClick={() => {
                      pasteChapterFromToolbar();
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    粘貼章節
                  </button>
                  <button
                    className="workspace-menu-item"
                    onClick={() => {
                      openMergeModal();
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    合併專案
                  </button>
                  <button
                    className="workspace-menu-item"
                    disabled={Object.keys(workspace.chapters).length < 2}
                    onClick={() => {
                      openChapterMergeModal();
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    合併章節
                  </button>

                  <div className="workspace-menu-divider" />
                  <button
                    className="workspace-menu-item"
                    onClick={() => {
                      openStorageModal();
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    檔案資料管理
                  </button>
                  <button
                    className="workspace-menu-item workspace-trash-menu-item"
                    onClick={() => {
                      activateOverlayModal("trash");
                      setTrashModalOpen(true);
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    <span>回收站</span>
                    <span className="menu-count-badge">{workspace.trash.length}</span>
                  </button>

                  <button
                    className="workspace-menu-item"
                    onClick={() => {
                      setSimilarOverviewOpen(true);
                      setWorkspaceMenuOpen(false);
                    }}
                  >
                    相似文本總覽
                  </button>

                  <div className="workspace-menu-divider" />
                  <p className="workspace-menu-label">正文字號</p>
                  <div className="font-size-control">
                    <div className="stepper" role="group" aria-label="正文字號">
                      <button
                        aria-label="縮小正文字號"
                        disabled={readingFontSize <= READING_FONT_MIN}
                        onClick={() => setReadingFontSize((size) => Math.max(READING_FONT_MIN, size - 1))}
                      >
                        A−
                      </button>
                      <span className="font-size-value">{readingFontSize}px</span>
                      <button
                        aria-label="放大正文字號"
                        disabled={readingFontSize >= READING_FONT_MAX}
                        onClick={() => setReadingFontSize((size) => Math.min(READING_FONT_MAX, size + 1))}
                      >
                        A＋
                      </button>
                    </div>
                    <button
                      className="text-link"
                      disabled={readingFontSize === READING_FONT_DEFAULT}
                      onClick={() => setReadingFontSize(READING_FONT_DEFAULT)}
                    >
                      重設
                    </button>
                  </div>

                  <div className="workspace-menu-divider" />
                  <p className="workspace-menu-label">快捷鍵</p>
                  <dl className="shortcut-list">
                    {[
                      { keys: ["J", "K"], label: "上下條" },
                      { keys: ["Enter"], label: "檢視" },
                      { keys: ["E"], label: "編輯" },
                      { keys: ["⌘", "N"], label: "新增" },
                      { keys: ["⌘", "↵"], label: "保存" },
                      { keys: ["⌘", "F"], label: "檢索" },
                      { keys: ["Delete"], label: "移入回收站" },
                      { keys: ["Esc"], label: "關閉" },
                    ].map((shortcut) => (
                      <div key={shortcut.label}>
                        <dt>
                          {shortcut.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                        </dt>
                        <dd>{shortcut.label}</dd>
                      </div>
                    ))}
                  </dl>

                  <div className="workspace-menu-divider" />
                  <p className="workspace-menu-label">匯出</p>
                  <div className="scope-switch compact-scope-switch" aria-label="匯出範圍">
                    <button
                      className={exportScope === "active" ? "scope active" : "scope"}
                      onClick={() => setExportScope("active")}
                    >
                      當前專案
                    </button>
                    <button
                      className={exportScope === "all" ? "scope active" : "scope"}
                      onClick={() => setExportScope("all")}
                    >
                      全部專案
                    </button>
                  </div>
                  <div className="workspace-export-actions">
                    <button
                      className="workspace-menu-item"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        void exportText();
                      }}
                    >
                      匯出 TXT
                    </button>
                    <button
                      className="workspace-menu-item"
                      disabled={isExportingDocx}
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        void exportWord();
                      }}
                    >
                      {isExportingDocx ? "匯出中…" : "匯出 Word"}
                    </button>
                    <button
                      className="workspace-menu-item"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        void exportExcel();
                      }}
                    >
                      匯出 Excel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div ref={leftPaneScrollRef} className="sidebar-scroll">
            {workspace.projectOrder.map((projectId) => {
              const project = workspace.projects[projectId];
              if (!project) {
                return null;
              }

              const entryCount = project.chapterIds.reduce((sum, chapterId) => {
                const chapter = workspace.chapters[chapterId];
                return sum + (chapter?.entryIds.length ?? 0);
              }, 0);

              const isProjectActive = activeProject?.id === project.id;
              const isProjectCollapsed = collapsedProjectIds.includes(project.id);
              const projectDropKey = `project:${project.id}`;
              const projectDragKey = `project:${project.id}`;

              return (
                <section
                  key={project.id}
                  className={`project-block ${isProjectActive ? "active" : ""} ${dropTargetKey === projectDropKey ? "drop-target" : ""}`}
                >
                  <div
                    className="project-row"
                    onDragOver={(event) => {
                      if (dragPayload?.type === "project") {
                        event.preventDefault();
                        configureMoveDrag(event);
                        setDropTargetKey(projectDropKey);
                      }
                    }}
                    onDrop={() => {
                      onProjectDrop(project.id);
                    }}
                  >
                    <button
                      type="button"
                      className="tree-toggle"
                      aria-label={isProjectCollapsed ? `展開專案「${project.title}」` : `摺疊專案「${project.title}」`}
                      aria-expanded={!isProjectCollapsed}
                      onClick={() => toggleProjectCollapsed(project.id)}
                    >
                      <span aria-hidden="true">{isProjectCollapsed ? "▸" : "▾"}</span>
                    </button>
                    <span
                      className={`drag-handle ${draggingKey === projectDragKey ? "dragging" : ""}`}
                      draggable
                      onDragStart={(event) => {
                        configureMoveDrag(event);
                        setDragPayload({ type: "project", id: project.id });
                        setDraggingKey(projectDragKey);
                      }}
                      onDragEnd={clearDragState}
                    >
                      ⋮⋮
                    </span>

                    <button
                      className="project-main"
                      data-project-id={project.id}
                      aria-expanded={!isProjectCollapsed}
                      onClick={() => toggleProjectCollapsed(project.id)}
                      onContextMenu={(event) => openProjectContextMenu(event, project.id)}
                      title={`${isProjectCollapsed ? "展開" : "摺疊"}專案；右鍵可編輯專案名`}
                    >
                      <span className="project-title">{project.title}</span>
                      <span className="badge">{entryCount}</span>
                    </button>
                  </div>

                  {!isProjectCollapsed && <div className="chapter-stack">
                    {project.chapterIds.map((chapterId) => {
                      const chapter = workspace.chapters[chapterId];
                      if (!chapter) {
                        return null;
                      }

                      const isChapterActive =
                        activeChapter?.id === chapter.id || selectedChapterIdSet.has(chapter.id);
                      const isChapterExpanded = expandedChapterIds.includes(chapter.id);
                      const chapterDropKey = `chapter:${chapter.id}`;
                      const chapterDragKey = `chapter:${chapter.id}`;

                      return (
                        <div key={chapter.id} className="chapter-branch">
                        <div
                          className={`chapter-row ${isChapterActive ? "active" : ""} ${dropTargetKey === chapterDropKey ? "drop-target" : ""}`}
                          onDragOver={(event) => {
                            const canReorderChapter =
                              dragPayload?.type === "chapter" &&
                              dragPayload.projectId === project.id;
                            if (canReorderChapter || dragPayload?.type === "entry") {
                              event.preventDefault();
                              configureMoveDrag(event);
                              setDropTargetKey(chapterDropKey);
                            }
                          }}
                          onDrop={() => {
                            if (dragPayload?.type === "entry") {
                              moveEntryToScope(dragPayload.id, project.id, chapter.id);
                            } else {
                              onChapterDrop(project.id, chapter.id);
                            }
                          }}
                        >
                          <button
                            type="button"
                            className="tree-toggle tree-toggle-small"
                            aria-label={isChapterExpanded ? `摺疊章節「${chapter.title}」` : `展開章節「${chapter.title}」`}
                            aria-expanded={isChapterExpanded}
                            onClick={() => toggleChapterExpanded(chapter.id)}
                            disabled={chapter.entryIds.length === 0}
                          >
                            <span aria-hidden="true">{isChapterExpanded ? "▾" : "▸"}</span>
                          </button>
                          <span
                            className={`drag-handle ${draggingKey === chapterDragKey ? "dragging" : ""}`}
                            draggable
                            onDragStart={(event) => {
                              configureMoveDrag(event);
                              setDragPayload({ type: "chapter", id: chapter.id, projectId: project.id });
                              setDraggingKey(chapterDragKey);
                            }}
                            onDragEnd={clearDragState}
                          >
                            ⋮
                          </span>

                          <button
                            className="chapter-main"
                            data-chapter-id={chapter.id}
                            onClick={(event) => handleChapterClick(event, project.id, chapter.id)}
                            onContextMenu={(event) => openChapterContextMenu(event, chapter.id)}
                            title={chapter.title}
                          >
                            <span className="chapter-title">{chapter.title}</span>
                            <span className="badge">{chapter.entryIds.length}</span>
                          </button>
                        </div>
                        {isChapterExpanded && chapter.entryIds.length > 0 && (
                          <div className="chapter-entry-list">
                            {chapter.entryIds.map((entryId) => {
                              const entry = workspace.entries[entryId];
                              if (!entry) {
                                return null;
                              }
                              const entryDragKey = `tree-entry:${entry.id}`;
                              return (
                                <button
                                  type="button"
                                  key={`tree-entry-${entry.id}`}
                                  className={`tree-entry ${workspace.selectedEntryId === entry.id ? "active" : ""}`}
                                  title={formatEntryHeadline(entry.timeText, entry.summary)}
                                  draggable
                                  onDragStart={(event) => {
                                    configureMoveDrag(event);
                                    setDragPayload({
                                      type: "entry",
                                      id: entry.id,
                                      projectId: entry.projectId,
                                      chapterId: entry.chapterId,
                                    });
                                    setDraggingKey(entryDragKey);
                                  }}
                                  onDragEnd={clearDragState}
                                  onContextMenu={(event) => openEntryContextMenu(event, entry.id)}
                                  onClick={() => selectEntryFromTree(entry.id)}
                                >
                                  <span className="tree-entry-bullet" aria-hidden="true" />
                                  <span>{formatEntryHeadline(entry.timeText, entry.summary)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        </div>
                      );
                    })}

                    <button className="ghost-btn" onClick={() => beginCreateChapter(project.id)}>
                      + 新增章節
                    </button>
                  </div>}
                </section>
              );
            })}
          </div>
        </aside>

        <main className="center-pane panel">
          <header className="center-head">
            <div>
              <p className="eyebrow">當前專案</p>
              <h2>{activeProject?.title ?? "未選擇專案"}</h2>
              <p className="meta-text">
                {activeChapter ? `章節：${activeChapter.title}` : "尚未選擇章節"}
              </p>
            </div>
            <div className="head-actions">
              <button
                className="secondary-btn"
                data-keep-entry-selection="true"
                onClick={() => createEntry()}
                disabled={!activeProject || !activeChapter}
                title={activeChapter ? "在當前章節新增史料（⌘N）" : "請先選擇章節"}
              >
                + 新增史料
              </button>
              <button
                className="ghost-btn"
                data-keep-entry-selection="true"
                onClick={pasteEntryFromToolbar}
                disabled={!activeProject || clipboard?.kind !== "entry"}
              >
                粘貼史料
              </button>
              {selectedEntryIds.length === 2 && (
                <button
                  className="ghost-btn"
                  data-keep-entry-selection="true"
                  title="逐字比勘所選的兩條史料"
                  onClick={() => {
                    const ordered = currentEntryIds.filter((entryId) => selectedEntryIdSet.has(entryId));
                    const [left, right] = ordered.length === 2 ? ordered : selectedEntryIds;
                    openCompare(left, right);
                  }}
                >
                  比勘所選
                </button>
              )}
            </div>
          </header>

          <section
            ref={centerPaneScrollRef}
            className="entry-list"
            onScroll={(event) => setEntryListScrollTop(event.currentTarget.scrollTop)}
          >
            {currentEntries.length === 0 ? (
              <div className="empty-state">
                <h3>尚無史料</h3>
                <p>{activeChapter ? "可在當前章節新增史料。" : "請先建立或選擇章節，再新增史料。"}</p>
                <button
                  className="secondary-btn"
                  onClick={() => createEntry()}
                  disabled={!activeProject || !activeChapter}
                  title={activeChapter ? "在當前章節新增史料（⌘N）" : "請先選擇章節"}
                >
                  立即新增
                </button>
              </div>
            ) : (
              <>
                {shouldVirtualizeEntries && <div style={{ height: `${entryVirtualRange.topSpacer}px` }} />}
                {visibleEntries.map((entry) => {
                const isSelected = selectedEntry?.id === entry.id || selectedEntryIdSet.has(entry.id);
                const entryDragKey = `entry:${entry.id}`;
                const entryDropKey = `entry:${entry.id}`;
                const tags = extractTags(entry.note);
                const headingLabel = formatEntryHeadline(entry.timeText, entry.summary);
                const sourcePreview = summarizeAroundMatch(
                  entry.sourceText,
                  centerEntryHighlightQuery,
                  200,
                );
                const notePreview = summarizeAroundMatch(entry.note, centerEntryHighlightQuery, 120);
                const citationPreview = summarizeAroundMatch(
                  entry.citation,
                  centerEntryHighlightQuery,
                  90,
                );

                return (
                  <article
                    key={entry.id}
                    data-entry-id={entry.id}
                    className={`entry-card virtualized-row ${isSelected ? "selected" : ""} ${dropTargetKey === entryDropKey ? "drop-target" : ""}`}
                    onMouseDown={(event) => {
                      if (event.shiftKey) {
                        event.preventDefault();
                      }
                    }}
                    onClick={(event) => handleEntryCardClick(event, entry.id)}
                    onDoubleClick={() => beginViewEntry(entry.id, centerEntryHighlightQuery)}
                    onContextMenu={(event) => openEntryContextMenu(event, entry.id)}
                    onDragOver={(event) => {
                      if (dragPayload?.type !== "entry") {
                        return;
                      }

                      const sameScope =
                        dragPayload.projectId === entry.projectId &&
                        dragPayload.chapterId === entry.chapterId;
                      if (!sameScope) {
                        return;
                      }

                      event.preventDefault();
                      configureMoveDrag(event);
                      setDropTargetKey(entryDropKey);
                    }}
                    onDrop={() => onEntryDrop(entry.id)}
                  >
                    <div className="entry-top">
                      <span
                        className={`drag-handle ${draggingKey === entryDragKey ? "dragging" : ""}`}
                        draggable
                        onDragStart={(event) => {
                          configureMoveDrag(event);
                          setDragPayload({
                            type: "entry",
                            id: entry.id,
                            projectId: entry.projectId,
                            chapterId: entry.chapterId,
                          });
                          setDraggingKey(entryDragKey);
                        }}
                        onDragEnd={clearDragState}
                        onClick={(event) => event.stopPropagation()}
                      >
                        ⋮⋮
                      </span>

                      <h3
                        className="entry-heading"
                        dangerouslySetInnerHTML={{
                          __html: renderHighlightedPlainText(headingLabel, centerEntryHighlightQuery),
                        }}
                      />

                      {renderSimilarBadge(entry.id, () => showSimilarFor(entry.id), "點擊在右欄查看。")}

                      <div className="entry-actions">
                        <button
                          className="icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            copyEntryToClipboard(entry.id);
                          }}
                        >
                          複製
                        </button>
                        <button
                          className="icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            beginViewEntry(entry.id, centerEntryHighlightQuery);
                          }}
                        >
                          檢視
                        </button>
                        <button
                          className="icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            beginEditEntry(entry.id, centerEntryHighlightQuery);
                          }}
                        >
                          編輯
                        </button>
                      </div>
                    </div>

                    {entry.sourceText.trim() ? (
                      <p
                        className="entry-snippet rich-markup clamp-4"
                        dangerouslySetInnerHTML={{
                          __html: renderHighlightedLightMarkup(
                            sourcePreview || entry.sourceText.trim(),
                            centerEntryHighlightQuery,
                          ),
                        }}
                      />
                    ) : (
                      <p className="entry-snippet">（尚未輸入史料文本）</p>
                    )}
                    <p
                      className="entry-note-preview"
                      onClick={handleEntryRefClick}
                      onDoubleClick={stopDoubleClickOnEntryRef}
                      dangerouslySetInnerHTML={{
                        __html: renderNoteWithRefs(notePreview || "（尚未輸入備註）", centerEntryHighlightQuery),
                      }}
                    />
                    <p
                      className="entry-citation"
                      dangerouslySetInnerHTML={{
                        __html: renderHighlightedPlainText(
                          citationPreview || "（尚未輸入引文註釋）",
                          centerEntryHighlightQuery,
                        ),
                      }}
                    />
                    {tags.length > 0 && (
                      <div className="tag-row">
                        {tags.map((tag) => (
                          <span
                            key={`${entry.id}-${tag}`}
                            className="tag-chip"
                            dangerouslySetInnerHTML={{
                              __html: renderHighlightedPlainText(tag, centerEntryHighlightQuery),
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </article>
                );
                })}
                {shouldVirtualizeEntries && <div style={{ height: `${entryVirtualRange.bottomSpacer}px` }} />}
              </>
            )}
          </section>
        </main>

        <aside ref={rightPaneScrollRef} className="right-pane panel">
          <div className="pane-tabs" role="tablist" aria-label="右欄" data-keep-entry-selection="true">
            <button
              role="tab"
              aria-selected={rightPaneTab === "search"}
              className={rightPaneTab === "search" ? "pane-tab active" : "pane-tab"}
              onClick={() => setRightPaneTab("search")}
            >
              檢索
            </button>
            <button
              role="tab"
              aria-selected={rightPaneTab === "similar"}
              className={rightPaneTab === "similar" ? "pane-tab active" : "pane-tab"}
              onClick={() => setRightPaneTab("similar")}
              title="列出與選中史料文字相近的條目"
            >
              相似文本
            </button>
          </div>
          {rightPaneTab === "similar" && (
            <section className="search-panel similar-panel" data-keep-entry-selection="true">
              <div className="similar-head">
                <p className="eyebrow">相似文本</p>
                <button
                  className="mini-btn mini-btn-accent"
                  onClick={() => setSimilarOverviewOpen(true)}
                  title="列出全庫中相似度高的文本對"
                >
                  全庫總覽 ›
                </button>
              </div>
              {renderSimilarRules("panel")}
              {!similarAnchorEntry ? (
                <p className="empty-inline">選中一條史料，這裏會列出與它文字相近的條目。</p>
              ) : (
                <div className="search-results">
                  <div className="similar-anchor">
                    <span className="section-label">比較對象</span>
                    <div className="similar-item-title">
                      {formatEntryHeadline(similarAnchorEntry.timeText, similarAnchorEntry.summary ?? "")}
                    </div>
                    <p className="search-path">
                      {workspace.projects[similarAnchorEntry.projectId]?.title ?? "未命名專案"} /{" "}
                      {workspace.chapters[similarAnchorEntry.chapterId]?.title ?? "未命名章節"}
                    </p>
                  </div>
                  {similarMatches.similar.length + similarMatches.copies.length > 0 ? (
                    <p className="section-label">
                      相似文本{" "}
                      <span className="section-count">
                        {similarMatches.similar.length + similarMatches.copies.length}
                      </span>
                      <span className="section-hint">單擊定位 · 雙擊比勘</span>
                    </p>
                  ) : similarAnchorResult?.anchorId !== similarAnchorEntry.id ? (
                    // 背景線程還沒回覆這一條的結果：先不說「沒有」，免得一閃而過。
                    <p className="empty-inline">比對中…</p>
                  ) : (
                    <p className="empty-inline">沒有找到明顯相似的文本。可點選上方的規則標籤放寬條件。</p>
                  )}
                  {/* 相似的在前，原文完全相同的副本排在後面，與檢視窗中的順序一致。 */}
                  {[...similarMatches.similar, ...similarMatches.copies].map((match) => {
                    const entry = workspace.entries[match.entryId];
                    if (!entry) {
                      return null;
                    }
                    const isCopy = entry.sourceText === similarAnchorEntry.sourceText;
                    const contains =
                      !isCopy &&
                      Math.max(match.anchorCoverage, match.candidateCoverage) >= 0.8 &&
                      Math.min(match.anchorCoverage, match.candidateCoverage) <= 0.6;
                    return (
                      <div
                        key={match.entryId}
                        className="search-item similar-item"
                        role="button"
                        tabIndex={0}
                        onClick={() => jumpToSimilarEntry(match.entryId)}
                        onDoubleClick={() => openCompare(similarAnchorEntry.id, match.entryId)}
                        onMouseDown={(event) => {
                          // 雙擊時不要順帶選中一段文字。
                          if (event.detail > 1) {
                            event.preventDefault();
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            jumpToSimilarEntry(match.entryId);
                          }
                        }}
                      >
                        <div className="similar-item-top">
                          <span className="search-path">
                            {workspace.projects[entry.projectId]?.title ?? "未命名專案"} /{" "}
                            {workspace.chapters[entry.chapterId]?.title ?? "未命名章節"}
                          </span>
                          <button
                            className="mini-btn mini-btn-accent"
                            title="與比較對象逐字比勘（也可直接雙擊此條）"
                            onClick={(event) => {
                              event.stopPropagation();
                              openCompare(similarAnchorEntry.id, match.entryId);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                          >
                            比勘
                          </button>
                        </div>
                        <div className="similar-item-title">
                          {formatEntryHeadline(entry.timeText, entry.summary ?? "")}
                        </div>
                        <div
                          className="similar-metrics"
                          title={describeSimilarMatch(match)}
                        >
                          <span className="metric-chip metric-strong">
                            重合 {formatPercent(match.anchorCoverage)} / {formatPercent(match.candidateCoverage)}
                          </span>
                          <span className="metric-chip">
                            相同 {match.sharedChars} 字 · 一致 {formatPercent(match.identity)}
                          </span>
                          {match.blocks.length > 1 && (
                            <span className="metric-chip">
                              {match.blocks.length} 段
                              {match.orderConsistency !== null ? ` · 語序 ${formatPercent(match.orderConsistency)}` : ""}
                            </span>
                          )}
                          {contains && <span className="metric-chip metric-accent">包含關係</span>}
                          {isCopy && <span className="metric-chip metric-accent">完全相同</span>}
                        </div>
                        <div
                          className="search-snippet"
                          dangerouslySetInnerHTML={{
                            __html: renderSimilarExcerpt(entry.sourceText, match.candidateRun),
                          }}
                        />
                        {entry.citation.trim() && (
                          <div className="search-citation">出處：{summarize(entry.citation.trim(), 60)}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          {/* 檢索頁隱藏而不卸載，保留檢索狀態與捲動位置。 */}
          <section className="search-panel" hidden={rightPaneTab !== "search"}>
            <div className="search-head">
              <p className="eyebrow">
                {searchLocationScope === "global"
                  ? "全局檢索"
                  : searchLocationScope === "project"
                    ? "在專案內檢索"
                    : "在章節中檢索"}
              </p>
              <p className="meta-text">
                {searchLocationScope === "global"
                  ? "支持繁簡檢索"
                  : searchLocationScope === "project"
                    ? activeProject?.title || "尚未選擇專案"
                    : activeChapter?.title || "尚未選擇章節"}
              </p>
            </div>

            <input
              id="global-search-input"
              className="search-input"
              placeholder="檢索時間、摘要、史料文本、備註、引文註釋..."
              value={globalQuery}
              onFocus={() => setNavigationScope("search")}
              onChange={(event) => setGlobalQuery(event.target.value)}
            />

            <select
              className="search-input"
              aria-label="檢索範圍"
              value={searchLocationScope}
              onFocus={() => setNavigationScope("search")}
              onChange={(event) =>
                setSearchLocationScope(event.target.value as SearchLocationScope)
              }
            >
              <option value="global">全局檢索</option>
              <option value="project" disabled={!activeProject}>
                在專案內檢索
              </option>
              <option value="chapter" disabled={!activeChapter}>
                在章節中檢索
              </option>
            </select>

            <button className="ghost-btn advanced-launch" onClick={openAdvancedSearchModal}>
              高級檢索
            </button>

            <div
              ref={searchResultsRef}
              className="search-results"
              onMouseDown={() => setNavigationScope("search")}
              onScroll={(event) => setSearchResultsScrollTop(event.currentTarget.scrollTop)}
            >
              <p className="result-meta">
                {hasSearch ? `共 ${searchResults.length} 條結果` : "請輸入關鍵詞開始檢索"}
              </p>
              {isSearchPending && hasSearch && <p className="meta-text">檢索中...</p>}
              {hasSearch ? (
                searchResults.length === 0 ? (
                  <p className="empty-inline">未檢索到符合內容。</p>
                ) : (
                  <>
                    {shouldVirtualizeSearchResults && (
                      <div style={{ height: `${searchVirtualRange.topSpacer}px` }} />
                    )}
                    {visibleSearchResults.map((result) => {
                    const entry = workspace.entries[result.entryId];
                    const sourcePreview = summarizeAroundMatch(
                      entry?.sourceText ?? result.snippet,
                      searchHighlightQuery,
                      140,
                    );
                    const citationPreview = summarizeAroundMatch(
                      entry?.citation ?? result.citation,
                      searchHighlightQuery,
                      100,
                    );
                    const notePreviewText = noteTextWithoutTags(entry?.note ?? "");

                    return (
                      <button
                        key={result.entryId}
                        data-search-entry-id={result.entryId}
                        className={`search-item virtualized-row ${selectedSearchResultEntryId === result.entryId ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedSearchResultEntryId(result.entryId);
                          jumpToSearchResult(result, searchHighlightQuery, "search");
                        }}
                        onDoubleClick={() => {
                          setSelectedSearchResultEntryId(result.entryId);
                          jumpToSearchResult(result, searchHighlightQuery, "search");
                          beginViewEntry(result.entryId, searchHighlightQuery);
                        }}
                      >
                        <div
                          className="search-path"
                          dangerouslySetInnerHTML={{
                            __html: renderHighlightedPlainText(
                              `${result.projectTitle} / ${result.chapterTitle}`,
                              searchHighlightQuery,
                            ),
                          }}
                        />
                        <div
                          className="search-time"
                          dangerouslySetInnerHTML={{
                            __html: renderHighlightedPlainText(
                              formatEntryHeadline(result.timeText, result.summaryText),
                              searchHighlightQuery,
                            ),
                          }}
                        />
                        <div
                          className="search-snippet"
                          dangerouslySetInnerHTML={{
                            __html: renderHighlightedPlainText(
                              sourcePreview || "（無文本）",
                              searchHighlightQuery,
                            ),
                          }}
                        />
                        <div
                          className="search-citation"
                          dangerouslySetInnerHTML={{
                            __html: renderHighlightedPlainText(
                              citationPreview || "（無引文註釋）",
                              searchHighlightQuery,
                            ),
                          }}
                        />
                        {notePreviewText && hasHighlightMatch(notePreviewText, searchHighlightQuery) && (
                          <div
                            className="search-citation"
                            dangerouslySetInnerHTML={{
                              __html: `備註：${renderHighlightedPlainText(
                                summarizeAroundMatch(notePreviewText, searchHighlightQuery, 100),
                                searchHighlightQuery,
                              )}`,
                            }}
                          />
                        )}
                        {result.tags.length > 0 && (
                          <div className="tag-row">
                            {result.tags.map((tag) => (
                              <span
                                key={`${result.entryId}-${tag}`}
                                className="tag-chip"
                                dangerouslySetInnerHTML={{
                                  __html: renderHighlightedPlainText(tag, searchHighlightQuery),
                                }}
                              />
                            ))}
                          </div>
                        )}
                      </button>
                    );
                    })}
                    {shouldVirtualizeSearchResults && (
                      <div style={{ height: `${searchVirtualRange.bottomSpacer}px` }} />
                    )}
                  </>
                )
              ) : (
                <p className="empty-inline">檢索後可點結果跳轉到對應史料。</p>
              )}
            </div>
          </section>
        </aside>
        {showGlobalStorageAlert && (
          <div className="storage-alert" role="status" aria-live="polite">
            {storageStatus}
          </div>
        )}
      </div>

      {copiedRefKey === "context" && (
        <div className="copy-toast" role="status">
          已複製鏈接，可貼到其他條目的備註中
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.kind === "project" ? (
            <>
              <button
                className="context-item"
                onClick={() => {
                  beginCreateProject(contextMenu.projectId);
                  setContextMenu(null);
                }}
              >
                新增專案
              </button>
              <button
                className="context-item"
                onClick={() => {
                  beginRenameProject(contextMenu.projectId);
                  setContextMenu(null);
                }}
              >
                編輯專案名
              </button>
              <button
                className="context-item"
                onClick={() => {
                  copyCurrentProject(contextMenu.projectId);
                  setContextMenu(null);
                }}
              >
                複製專案
              </button>
              <button
                className="context-item"
                onClick={() => {
                  pasteProjectFromClipboard(contextMenu.projectId);
                  setContextMenu(null);
                }}
              >
                粘貼專案
              </button>
              <button
                className="context-item context-danger"
                onClick={() => {
                  deleteProject(contextMenu.projectId);
                  setContextMenu(null);
                }}
              >
                刪除專案
              </button>
            </>
          ) : contextMenu.kind === "chapter" ? (
            <>
              <button
                className="context-item"
                onClick={() => {
                  const chapter = workspace.chapters[contextMenu.chapterId];
                  if (chapter) {
                    beginCreateChapter(chapter.projectId, chapter.id);
                  }
                  setContextMenu(null);
                }}
              >
                新增章節
              </button>
              <button
                className="context-item"
                onClick={() => {
                  beginRenameChapter(contextMenu.chapterId);
                  setContextMenu(null);
                }}
              >
                編輯章節名
              </button>
              <button
                className="context-item"
                onClick={() => {
                  const selectedChapterIdsForAction = collectOrderedChapterIdsForContext(
                    contextMenu.chapterId,
                    chapterSelectionForMenu,
                  );
                  copyChaptersToClipboard(
                    selectedChapterIdsForAction.length > 0
                      ? selectedChapterIdsForAction
                      : [contextMenu.chapterId],
                  );
                  setContextMenu(null);
                }}
              >
                複製章節
              </button>
              <button
                className="context-item"
                onClick={() => {
                  const chapter = workspace.chapters[contextMenu.chapterId];
                  if (chapter) {
                    const selectedChapterIdsForAction = collectOrderedChapterIdsForContext(
                      chapter.id,
                      chapterSelectionForMenu,
                    );
                    const insertAfterChapterId =
                      selectedChapterIdsForAction[selectedChapterIdsForAction.length - 1] ?? chapter.id;
                    pasteChapterFromClipboard(chapter.projectId, insertAfterChapterId);
                  }
                  setContextMenu(null);
                }}
              >
                粘貼章節
              </button>
              <button
                className="context-item context-danger"
                onClick={() => {
                  const selectedChapterIdsForAction = collectOrderedChapterIdsForContext(
                    contextMenu.chapterId,
                    chapterSelectionForMenu,
                  );
                  if (selectedChapterIdsForAction.length > 1) {
                    deleteChaptersBatch(selectedChapterIdsForAction);
                  } else {
                    deleteChapter(contextMenu.chapterId);
                  }
                  setContextMenu(null);
                }}
              >
                刪除章節
              </button>
            </>
          ) : (
            <>
              <button
                className="context-item"
                onClick={() => {
                  beginCreateEntryAfter(contextMenu.entryId);
                  setContextMenu(null);
                }}
              >
                新增史料
              </button>
              <button
                className="context-item"
                onClick={() => {
                  beginViewEntry(contextMenu.entryId, centerEntryHighlightQuery);
                  setContextMenu(null);
                }}
              >
                檢視史料
              </button>
              <button
                className="context-item"
                onClick={() => {
                  beginEditEntry(contextMenu.entryId, centerEntryHighlightQuery);
                  setContextMenu(null);
                }}
              >
                編輯史料
              </button>
              {entrySelectionForMenu.length === 2 && (
                <button
                  className="context-item"
                  onClick={() => {
                    const [left, right] = collectOrderedEntryIdsForContext(contextMenu.entryId, entrySelectionForMenu);
                    if (left && right) {
                      openCompare(left, right);
                    }
                    setContextMenu(null);
                  }}
                >
                  比勘這兩條
                </button>
              )}
              <button
                className="context-item"
                onClick={() => {
                  showSimilarFor(contextMenu.entryId);
                  setContextMenu(null);
                }}
              >
                查看相似文本
              </button>
              <button
                className="context-item"
                onClick={() => {
                  const selectedEntryIdsForAction = collectOrderedEntryIdsForContext(
                    contextMenu.entryId,
                    entrySelectionForMenu,
                  );
                  copyEntriesToClipboard(
                    selectedEntryIdsForAction.length > 0 ? selectedEntryIdsForAction : [contextMenu.entryId],
                  );
                  setContextMenu(null);
                }}
              >
                複製史料
              </button>
              <button
                className="context-item"
                title="複製 [[編號]]，貼到其他條目的備註中即可互相鏈接"
                onClick={() => {
                  const selectedEntryIdsForAction = collectOrderedEntryIdsForContext(
                    contextMenu.entryId,
                    entrySelectionForMenu,
                  );
                  void copyEntryRefs(
                    selectedEntryIdsForAction.length > 0 ? selectedEntryIdsForAction : [contextMenu.entryId],
                    "context",
                  );
                  setContextMenu(null);
                }}
              >
                複製鏈接
              </button>
              <button
                className="context-item"
                onClick={() => {
                  const entry = workspace.entries[contextMenu.entryId];
                  if (entry) {
                    const selectedEntryIdsForAction = collectOrderedEntryIdsForContext(
                      entry.id,
                      entrySelectionForMenu,
                    );
                    const insertAfterEntryId =
                      selectedEntryIdsForAction[selectedEntryIdsForAction.length - 1] ?? entry.id;
                    pasteEntryFromClipboard(entry.projectId, entry.chapterId, insertAfterEntryId);
                  }
                  setContextMenu(null);
                }}
              >
                粘貼史料
              </button>
              <button
                className="context-item context-danger"
                onClick={() => {
                  const selectedEntryIdsForAction = collectOrderedEntryIdsForContext(
                    contextMenu.entryId,
                    entrySelectionForMenu,
                  );
                  if (selectedEntryIdsForAction.length > 1) {
                    deleteEntriesBatch(selectedEntryIdsForAction);
                  } else {
                    deleteEntry(contextMenu.entryId);
                  }
                  setContextMenu(null);
                }}
              >
                刪除史料
              </button>
            </>
          )}
        </div>
      )}

      {anyOverlayModalOpen && <div className="modal-stack-overlay" />}

      {trashModalOpen && (
        <div className="modal-backdrop" style={modalBackdropStyle("trash")}>
          <div
            className="modal-card modal-large draggable-modal trash-modal"
            style={modalCardStyle("trash")}
            onMouseDown={(event) => {
              activateOverlayModal("trash");
              event.stopPropagation();
            }}
          >
            {renderModalClose("trash")}
            <div className="modal-head modal-drag-handle" onMouseDown={(event) => startModalDrag(event, "trash")}>
              <div className="trash-modal-title-row">
                <div>
                  <h3>回收站</h3>
                  <p className="meta-text">最多保留 100 次刪除操作；超過後會自動永久移除最舊一筆。</p>
                </div>
                <span className="trash-capacity">{workspace.trash.length} / {TRASH_ITEM_LIMIT}</span>
              </div>
            </div>

            <div className="trash-list">
              {workspace.trash.length === 0 ? (
                <div className="empty-inline">
                  <p>回收站目前是空的。</p>
                </div>
              ) : (
                workspace.trash.map((item) => {
                  const blockedReason = trashRestoreBlockReason(item);
                  const typeLabel =
                    item.payload.kind === "project"
                      ? "專案"
                      : item.payload.kind === "chapter"
                        ? "章節"
                        : "史料";
                  const detail =
                    item.payload.kind === "project"
                      ? `${item.payload.chapters.length} 個章節 · ${item.payload.entries.length} 條史料`
                      : item.payload.kind === "chapter"
                        ? `${item.payload.chapters.length} 個章節 · ${item.payload.entries.length} 條史料`
                        : `${item.payload.entries.length} 條史料`;
                  return (
                    <article key={item.id} className="trash-item">
                      <div className="trash-item-main">
                        <div className="trash-item-heading">
                          <span className={`trash-kind trash-kind-${item.payload.kind}`}>{typeLabel}</span>
                          <strong title={item.label}>{item.label}</strong>
                        </div>
                        <p className="meta-text">{detail} · {formatDateTimeLabel(item.deletedAt)}</p>
                        {blockedReason && <p className="trash-blocked-reason">{blockedReason}</p>}
                      </div>
                      <div className="trash-item-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={Boolean(blockedReason)}
                          onClick={() => restoreTrashItem(item.id)}
                        >
                          還原
                        </button>
                        <button
                          type="button"
                          className="ghost-btn danger-btn"
                          onClick={() => permanentlyDeleteTrashItem(item.id)}
                        >
                          永久刪除
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            <div className="modal-actions trash-modal-actions">
              <button
                className="ghost-btn danger-btn"
                disabled={workspace.trash.length === 0}
                onClick={emptyTrash}
              >
                清空回收站
              </button>
            </div>
          </div>
        </div>
      )}

      {storageModalOpen && (
        <div className="modal-backdrop" style={modalBackdropStyle("storage")}>
          <div
            className="modal-card modal-large draggable-modal"
            style={modalCardStyle("storage")}
            onMouseDown={(event) => {
              activateOverlayModal("storage");
              event.stopPropagation();
            }}
          >
            {renderModalClose("storage")}
            <div className="modal-head modal-drag-handle" onMouseDown={(event) => startModalDrag(event, "storage")}>
              <div className="storage-head-row">
                <h3>檔案資料管理</h3>
                <button
                  type="button"
                  className="icon-btn storage-info-btn"
                  title="檔案格式說明"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    activateOverlayModal("storage-format-info");
                    setStorageFormatInfoModalOpen(true);
                  }}
                >
                  i
                </button>
              </div>
              <p className="meta-text">手動管理專案與史料資料檔的存放位置。</p>
            </div>

            <div className="modal-grid">
              <label className="modal-label">
                目前資料檔路徑
                <p className="path-preview">{storageInfo?.path || "讀取中..."}</p>
              </label>

              <label className="modal-label">
                新資料檔路徑
                <input
                  value={storagePathDraft}
                  onChange={(event) => setStoragePathDraft(event.target.value)}
                  placeholder="例如：/Users/xxx/Documents/workspace.json"
                />
              </label>

              <div className="tool-row">
                <button className="ghost-btn" onClick={() => void chooseStoragePath()} disabled={storageBusy}>
                  選擇檔案...
                </button>
                <button className="ghost-btn" onClick={() => void refreshStorageInfo()} disabled={storageBusy}>
                  刷新
                </button>
              </div>

              {storageInfo?.envLocked && (
                <p className="meta-text">
                  目前由環境變數鎖定路徑：{storageInfo.envPath || storageInfo.path}
                </p>
              )}

              {storageStatus && <p className="status-text">{storageStatus}</p>}
            </div>

            <div className="modal-actions storage-actions">
              <button
                className="ghost-btn"
                onClick={() => {
                  activateOverlayModal("storage-save-as");
                  setStorageSaveAsModalOpen(true);
                }}
                disabled={storageBusy}
              >
                備份到
              </button>
              <button className="ghost-btn" onClick={() => void importWorkspaceFromFile()} disabled={storageBusy}>
                匯入檔案
              </button>
              <button className="ghost-btn" onClick={() => void reloadWorkspaceFromStorage()} disabled={storageBusy}>
                從資料檔重載
              </button>
              <button
                className="ghost-btn"
                onClick={() => void resetStoragePath()}
                disabled={storageBusy || Boolean(storageInfo?.envLocked)}
              >
                恢復預設路徑
              </button>
              <button
                className="secondary-btn"
                onClick={() => void applyStoragePath()}
                disabled={storageBusy || Boolean(storageInfo?.envLocked)}
              >
                切換並保存
              </button>
            </div>
          </div>
        </div>
      )}

      {storageSaveAsModalOpen && (
        <div className="modal-backdrop" style={modalBackdropStyle("storage-save-as")}>
          <div
            className="modal-card draggable-modal"
            style={modalCardStyle("storage-save-as")}
            onMouseDown={(event) => {
              activateOverlayModal("storage-save-as");
              event.stopPropagation();
            }}
          >
            {renderModalClose("storage-save-as")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "storage-save-as")}
            >
              <h3>備份到</h3>
              <p className="meta-text">請選擇備份範圍。</p>
            </div>

            <div className="tool-row">
              <button
                className="secondary-btn"
                onClick={() => void backupWorkspaceToFile("active")}
                disabled={storageBusy || !activeProject}
              >
                備份當前專案
              </button>
              <button
                className="secondary-btn"
                onClick={() => void backupWorkspaceToFile("all")}
                disabled={storageBusy}
              >
                備份全部專案
              </button>
            </div>

            {!activeProject && <p className="meta-text">目前沒有可用的當前專案。</p>}

          </div>
        </div>
      )}

      {storageFormatInfoModalOpen && (
        <div className="modal-backdrop" style={modalBackdropStyle("storage-format-info")}>
          <div
            className="modal-card modal-large draggable-modal"
            style={modalCardStyle("storage-format-info")}
            onMouseDown={(event) => {
              activateOverlayModal("storage-format-info");
              event.stopPropagation();
            }}
          >
            {renderModalClose("storage-format-info")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "storage-format-info")}
            >
              <h3>檔案格式說明</h3>
              <p className="meta-text">本 App 使用 JSON 工作臺檔案，可直接匯入與管理。</p>
            </div>

            <div className="storage-format-list">
              <p className="meta-text">
                檔案為 UTF-8 JSON，頂層包含 `projectOrder`、`projects`、`chapters`、`entries`、
                `activeProjectId`、`activeChapterId`、`selectedEntryId`。
              </p>
              <p className="meta-text">
                `entries` 內保留每條史料的時間、摘要、史料文本、備註、引文註釋，以及建立/修改時間戳。
              </p>
              <p className="meta-text">
                「匯入檔案」會把內容加入目前工作臺，不會直接覆蓋既有資料；匯入前會再次要求確認。
              </p>
              <p className="meta-text">
                「備份到」只會產生備份副本，不會改動目前工作臺；如目標檔已存在，會先要求你確認再覆蓋。
              </p>
              <p className="meta-text">建議副檔名使用 `.json`，方便備份與版本管理。</p>
            </div>

          </div>
        </div>
      )}

      {formModal && (
        <div className="modal-backdrop" style={modalBackdropStyle("form")}>
          <div
            className="modal-card draggable-modal"
            style={modalCardStyle("form")}
            onMouseDown={(event) => {
              activateOverlayModal("form");
              event.stopPropagation();
            }}
          >
            {renderModalClose("form")}
            <div className="modal-head modal-drag-handle" onMouseDown={(event) => startModalDrag(event, "form")}>
              <h3>
                {formModal.kind === "project-create" && "新增專案"}
                {formModal.kind === "project-rename" && "編輯專案名"}
                {formModal.kind === "chapter-create" && "新增章節"}
                {formModal.kind === "chapter-rename" && "編輯章節名"}
              </h3>
            </div>

            <label className="modal-label">
              名稱
              <input
                autoFocus
                value={formModal.value}
                onChange={(event) => {
                  const value = event.target.value;
                  setModalState((current) => {
                    if (!current || current.kind === "entry-edit" || current.kind === "entry-create") {
                      return current;
                    }
                    return { ...current, value };
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    applyFormModal();
                  }
                }}
              />
            </label>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => requestCloseOverlayModal("form")}>
                取消
              </button>
              <button className="secondary-btn" onClick={applyFormModal}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {entryViews.map((win) => renderEntryViewWindow(win))}

      {entryModal && (
        <div className="modal-backdrop" style={modalBackdropStyle("entry-form")}>
          <div
            className="modal-card modal-large draggable-modal"
            style={modalCardStyle("entry-form")}
            onMouseDown={(event) => {
              activateOverlayModal("entry-form");
              event.stopPropagation();
            }}
          >
            {renderModalClose("entry-form")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "entry-form")}
            >
              <h3>{entryModal.kind === "entry-create" ? "新增史料" : "編輯史料"}</h3>
              <p className="meta-text">五元素：時間 / 摘要 / 史料文本 / 備註 / 引文註釋；備註支持 `#標籤` 與 `[[編號]]` 鏈接其他條目。</p>
            </div>

            <div className="modal-grid">
              <label className="modal-label">
                時間（文本）
                <input
                  value={entryModal.draft.timeText}
                  onChange={(event) => updateEntryModalDraft({ timeText: event.target.value })}
                  placeholder="如：萬曆二十年春 / 1644年 / 未詳"
                />
              </label>

              <label className="modal-label">
                摘要
                <input
                  value={entryModal.draft.summary}
                  onChange={(event) => updateEntryModalDraft({ summary: event.target.value })}
                  placeholder="例如：張居正改革前夕的朝議分歧"
                />
              </label>

              {/* 用 div 而非 label：label 會把點擊轉發給內部第一個格式按鈕，插入 `****`。 */}
              <div className="modal-label">
                史料文本
                <div className="format-toolbar">
                  <button
                    type="button"
                    className="icon-btn format-btn"
                    aria-label="加粗"
                    aria-pressed={sourceFormatState.bold}
                    title="粗體（⌘B）"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applySourceMarker("bold")}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    className="icon-btn format-btn"
                    aria-label="斜體"
                    aria-pressed={sourceFormatState.italic}
                    title="斜體（⌘I）"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applySourceMarker("italic")}
                  >
                    I
                  </button>
                  <button
                    type="button"
                    className="icon-btn format-btn"
                    aria-label="下劃線"
                    aria-pressed={sourceFormatState.underline}
                    title="下劃線（⌘U）"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applySourceMarker("underline")}
                  >
                    U
                  </button>
                  <span className="format-tip">語法：`**粗體**` `*斜體*` `__下劃線__`</span>
                </div>
                <textarea
                  ref={entrySourceTextareaRef}
                  rows={8}
                  value={entryModal.draft.sourceText}
                  onChange={(event) => updateEntryModalDraft({ sourceText: event.target.value })}
                  onClick={syncSourceFormatState}
                  onKeyDown={handleSourceShortcut}
                  onKeyUp={syncSourceFormatState}
                  onSelect={syncSourceFormatState}
                  placeholder="輸入原始史料文本..."
                  aria-label="史料文本"
                />
              </div>

              <label className="modal-label">
                備註（支持 #標籤；貼上「複製鏈接」得到的 [[編號]] 即可鏈接到其他條目）
                <textarea
                  rows={5}
                  value={entryModal.draft.note}
                  onChange={(event) => updateEntryModalDraft({ note: event.target.value })}
                  placeholder="例如：#政治 #人物關係 #萬曆朝 ..."
                />
              </label>

              <label className="modal-label">
                引文註釋
                <textarea
                  rows={4}
                  value={entryModal.draft.citation}
                  onChange={(event) => updateEntryModalDraft({ citation: event.target.value })}
                  placeholder="例如：某書卷X，頁Y；《明史》《資治通鑑》..."
                />
              </label>
            </div>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => requestCloseOverlayModal("entry-form")}>
                取消
              </button>
              <button className="secondary-btn" onClick={applyEntryEditor} title="保存（⌘↵）">
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {similarOverviewOpen && (
        <div className="modal-backdrop" style={modalBackdropStyle("similar-overview")}>
          <div
            className="modal-card modal-xl draggable-modal similar-overview-modal"
            style={modalCardStyle("similar-overview")}
            onMouseDown={(event) => {
              activateOverlayModal("similar-overview");
              event.stopPropagation();
            }}
          >
            {renderModalClose("similar-overview")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "similar-overview")}
            >
              <h3>相似文本總覽</h3>
              <div className="stat-chips">
                {similarOverview ? (
                  <>
                    <span className="stat-chip">
                      顯示 <strong>{similarOverview.pairs.length}</strong> 對
                    </span>
                    <span className="stat-chip">
                      全庫 <strong>{similarOverview.total}</strong> 對
                    </span>
                    <span className="stat-chip">
                      完全相同的副本 <strong>{similarOverview.copyCount}</strong> 對
                    </span>
                  </>
                ) : (
                  <span className="stat-chip">計算中…</span>
                )}
              </div>
              <div className="overview-rules">{renderSimilarRules("overview")}</div>
            </div>
            <div className="overview-toolbar">
              <div className="compare-toolbar-group">
                <span className="control-label">最低相似度</span>
                <div className="segmented" role="group" aria-label="最低相似度">
                  {[
                    { value: 0, label: "全部" },
                    { value: 0.2, label: "20%+" },
                    { value: 0.5, label: "50%+" },
                    { value: 0.8, label: "80%+" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      aria-pressed={similarOverviewFilter.minScore === option.value}
                      onClick={() => setSimilarOverviewFilter((filter) => ({ ...filter, minScore: option.value }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="compare-toolbar-group">
                <span className="control-label">排序</span>
                <div className="segmented" role="group" aria-label="排序">
                  {[
                    { value: "score" as const, label: "相似度" },
                    { value: "shared" as const, label: "相同字數" },
                    { value: "order" as const, label: "語序一致" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      aria-pressed={similarOverviewFilter.sortBy === option.value}
                      onClick={() => setSimilarOverviewFilter((filter) => ({ ...filter, sortBy: option.value }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="compare-toggle">
                <input
                  type="checkbox"
                  checked={similarOverviewFilter.hideCopies}
                  onChange={(event) => {
                    const hideCopies = event.target.checked;
                    setSimilarOverviewFilter((filter) => ({ ...filter, hideCopies }));
                  }}
                />
                隱藏完全相同的副本
              </label>
              <label className="compare-toggle">
                <input
                  type="checkbox"
                  checked={similarOverviewFilter.crossChapterOnly}
                  onChange={(event) => {
                    const crossChapterOnly = event.target.checked;
                    setSimilarOverviewFilter((filter) => ({ ...filter, crossChapterOnly }));
                  }}
                />
                只看不同章節之間
              </label>
            </div>
            <div className="overview-list">
              {similarOverview && similarOverview.pairs.length === 0 && (
                <p className="empty-inline">沒有符合條件的相似文本對。</p>
              )}
              {similarOverview?.pairs.slice(0, 300).map((pair) => {
                const entries = [workspace.entries[pair.aId], workspace.entries[pair.bId]];
                if (!entries[0] || !entries[1]) {
                  return null;
                }
                const { match } = pair;
                return (
                  <div key={`${pair.aId}-${pair.bId}`} className="overview-row">
                    <div className="overview-score" title={describeSimilarMatch(match, "左條", "右條")}>
                      <strong>{formatPercent(match.score)}</strong>
                      <span className="score-meter" aria-hidden="true">
                        <span style={{ width: `${Math.round(match.score * 100)}%` }} />
                      </span>
                      <span>
                        重合 {formatPercent(match.anchorCoverage)} / {formatPercent(match.candidateCoverage)}
                      </span>
                      <span>
                        相同 {match.sharedChars} 字 · 一致 {formatPercent(match.identity)}
                      </span>
                      {match.blocks.length > 1 && (
                        <span>
                          {match.blocks.length} 段
                          {match.orderConsistency !== null ? ` · 語序 ${formatPercent(match.orderConsistency)}` : ""}
                        </span>
                      )}
                    </div>
                    {entries.map((entry, index) => (
                      <Fragment key={entry.id}>
                        {index === 1 && (
                          <span className="overview-link" aria-hidden="true">
                            ⇄
                          </span>
                        )}
                        <div className="overview-entry">
                          <p className="search-path">
                            {workspace.projects[entry.projectId]?.title ?? "未命名專案"} /{" "}
                            {workspace.chapters[entry.chapterId]?.title ?? "未命名章節"}
                          </p>
                          <p className="overview-title">{formatEntryHeadline(entry.timeText, entry.summary ?? "")}</p>
                          <p className="overview-source">
                            <span className="citation-label">出處</span>
                            {shortSourceLabel(entry)}
                          </p>
                          <button
                            className="text-link"
                            onClick={() => {
                              setSimilarOverviewOpen(false);
                              setSimilarAnchorEntryId(entry.id);
                              setRightPaneTab("similar");
                              jumpToSimilarEntry(entry.id);
                            }}
                          >
                            定位 ↗
                          </button>
                        </div>
                      </Fragment>
                    ))}
                    <div className="overview-actions">
                      <button className="mini-btn mini-btn-accent" onClick={() => openCompare(pair.aId, pair.bId)}>
                        比勘
                      </button>
                    </div>
                  </div>
                );
              })}
              {similarOverview && similarOverview.pairs.length > 300 && (
                <p className="meta-text">只顯示前 300 對，可提高最低相似度縮小範圍。</p>
              )}
            </div>
          </div>
        </div>
      )}

      {compareState && compareView && (
        <div className="modal-backdrop" style={modalBackdropStyle("compare")}>
          <div
            className="modal-card modal-xl draggable-modal compare-modal"
            style={modalCardStyle("compare")}
            onMouseDown={(event) => {
              activateOverlayModal("compare");
              event.stopPropagation();
            }}
          >
            {renderModalClose("compare")}
            <div className="modal-head modal-drag-handle" onMouseDown={(event) => startModalDrag(event, "compare")}>
              <h3>比勘</h3>
              {compareView.result.aligned ? (
                <div className="stat-chips">
                  {compareView.blocks && (
                    <span className="stat-chip">
                      對齊 <strong>{compareView.blocks.length}</strong> 段
                    </span>
                  )}
                  <span className="stat-chip">
                    相同 <strong>{compareView.result.equalChars}</strong> 字
                  </span>
                  <span className="stat-chip">
                    左 <strong>{formatPercent(compareView.result.leftCoverage)}</strong> 見於右
                  </span>
                  <span className="stat-chip">
                    右 <strong>{formatPercent(compareView.result.rightCoverage)}</strong> 見於左
                  </span>
                  <span className="stat-chip">
                    異文 <strong>{compareView.variantCount}</strong>
                  </span>
                  <span className="stat-chip">
                    左有右無 <strong>{compareView.leftOnlyCount}</strong>
                  </span>
                  <span className="stat-chip">
                    右有左無 <strong>{compareView.rightOnlyCount}</strong>
                  </span>
                </div>
              ) : null}
              {compareView.noBlocks ? (
                <p className="compare-warning">
                  沒有找到對齊段落（每段至少 {similarMinBlock} 字相同），以下改爲整條對照，僅供參考。
                </p>
              ) : (
                (!compareView.blocks || compareScope === "full") &&
                (!compareView.result.aligned ||
                  Math.max(compareView.result.leftCoverage, compareView.result.rightCoverage) < 0.3) && (
                <p className="compare-warning">
                  {!compareView.result.aligned
                    ? "兩段差異太大，未能逐字對齊；下方標出的是不在共有片段中的文字。"
                    : compareView.blocks
                      ? "兩段文字重合很少：加底線的對齊段落可靠，段落以外零散的相同字多屬巧合，僅供參考。"
                      : "兩段文字重合很少，以下對照僅供參考。"}
                </p>
                )
              )}
            </div>
            <div className="compare-toolbar">
              <div className="compare-toolbar-group">
                <span className="control-label">範圍</span>
                <div className="segmented" role="group" aria-label="比勘範圍">
                  <button
                    aria-pressed={compareScope === "aligned"}
                    onClick={() => setCompareScope("aligned")}
                    title="只逐字比較兩條中對得上的段落，段落以外的文字淡化顯示。"
                  >
                    對齊段落
                  </button>
                  <button
                    aria-pressed={compareScope === "full"}
                    onClick={() => setCompareScope("full")}
                    title="整條對整條逐字比較：對齊段落照樣對上（加底線，次序顛倒也不受影響），其餘文字按先後比較，零散的相同字也會被標出。"
                  >
                    全文
                  </button>
                </div>
              </div>
              <div className="compare-toolbar-group">
                <span className="control-label">標出</span>
                <div className="segmented" role="group" aria-label="著色方式">
                  <button aria-pressed={compareMarkMode === "same"} onClick={() => setCompareMarkMode("same")}>
                    相同文字
                  </button>
                  <button aria-pressed={compareMarkMode === "diff"} onClick={() => setCompareMarkMode("diff")}>
                    不同文字
                  </button>
                </div>
                <span className="color-legend">
                  {compareMarkMode === "same" ? (
                    <>
                      <i className="legend-swatch legend-same" />
                      兩段共有
                    </>
                  ) : (
                    <>
                      <i className="legend-swatch legend-left" />
                      左欄獨有
                      <i className="legend-swatch legend-right" />
                      右欄獨有
                    </>
                  )}
                </span>
              </div>
              <div className="compare-toolbar-group">
                <label className="compare-toggle">
                  <input
                    type="checkbox"
                    checked={compareState.strict}
                    onChange={(event) => {
                      const strict = event.target.checked;
                      setCompareState((state) => (state ? { ...state, strict } : state));
                    }}
                  />
                  區分繁簡、異體字
                </label>
                <button
                  className="mini-btn"
                  title="交換左右兩欄"
                  onClick={() =>
                    setCompareState((state) =>
                      state ? { ...state, leftEntryId: state.rightEntryId, rightEntryId: state.leftEntryId } : state,
                    )
                  }
                >
                  ⇄ 左右互換
                </button>
              </div>
            </div>
            {compareView.blocks && compareView.blocks.length > 1 && (
              <div className="block-nav" role="group" aria-label="跳到對齊段落">
                <span className="control-label">段落</span>
                {compareView.blocks.map((block, index) => (
                  <button
                    key={`${block.aStart}-${block.bStart}`}
                    className="mini-btn"
                    onClick={() => scrollCompareToBlock(index)}
                    title={`相同 ${block.matches} 字，段內一致 ${formatPercent(block.identity)}`}
                  >
                    {index + 1}
                    <small>
                      {block.matches} 字 · {formatPercent(block.identity)}
                    </small>
                  </button>
                ))}
              </div>
            )}
            <div className="compare-grid">
              {compareView.sides.map((side, index) => (
                <section
                  key={side.key}
                  className="compare-pane"
                  title="雙擊檢視此條"
                  onDoubleClick={() => viewEntryFromCompare(side.entryId)}
                  onMouseDown={(event) => {
                    // 雙擊時不要順帶選中一段文字。
                    if (event.detail > 1) {
                      event.preventDefault();
                    }
                  }}
                >
                  <div className="compare-pane-head">
                    <span className={index === 0 ? "side-badge side-badge-left" : "side-badge side-badge-right"}>
                      {index === 0 ? "左" : "右"}
                    </span>
                    <span className="search-path">{side.path}</span>
                    <span className="pane-hint">雙擊檢視此條</span>
                  </div>
                  <p className="compare-title">{side.title}</p>
                  <p className="compare-citation">
                    <span className="citation-label">出處</span>
                    {side.citation || "（無引文註釋）"}
                  </p>
                  <div className="compare-text rich-markup" dangerouslySetInnerHTML={{ __html: side.html }} />
                </section>
              ))}
            </div>
            {compareView.rows.length > 0 && (
              <section className="compare-hunks">
                <p className="section-label">
                  異文表 <span className="section-count">{compareView.rows.length}</span>
                  {compareView.rows.length > 300 ? "（顯示前 300 處）" : ""}
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>類型</th>
                      <th title={compareView.sides[0].citation || compareView.sides[0].title}>
                        左 · {compareView.sides[0].sourceLabel}
                      </th>
                      <th title={compareView.sides[1].citation || compareView.sides[1].title}>
                        右 · {compareView.sides[1].sourceLabel}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareView.rows.slice(0, 300).map((row, index) => (
                      <tr key={index}>
                        <td>
                          <span
                            className={
                              row.kind === "異文"
                                ? "kind-badge kind-variant"
                                : row.kind === "左有右無"
                                  ? "kind-badge kind-left"
                                  : "kind-badge kind-right"
                            }
                          >
                            {row.kind}
                          </span>
                        </td>
                        <td>
                          <div className="compare-cell">
                            <span className="compare-context">{row.leftContext}</span>
                            {row.leftSegment ? (
                              <mark className="diff-left">{row.leftSegment}</mark>
                            ) : (
                              <span className="compare-missing">（無）</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="compare-cell">
                            <span className="compare-context">{row.rightContext}</span>
                            {row.rightSegment ? (
                              <mark className="diff-right">{row.rightSegment}</mark>
                            ) : (
                              <span className="compare-missing">（無）</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </div>
        </div>
      )}

      {advancedModal.open && (
        <div className="modal-backdrop" style={modalBackdropStyle("advanced")}>
          <div
            className="modal-card modal-xl draggable-modal"
            style={modalCardStyle("advanced")}
            onMouseDown={(event) => {
              activateOverlayModal("advanced");
              event.stopPropagation();
            }}
          >
            {renderModalClose("advanced")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "advanced")}
            >
              <h3>高級檢索</h3>
              <p className="meta-text">以關鍵字檢索，並將結果匯入至專案或章節。</p>
            </div>

            <div className="modal-grid advanced-modal-body advanced-layout">
              <section className="advanced-left-column">
                <div className="advanced-filter-grid">
                  <label className="modal-label">
                    關鍵字
                    <input
                      value={advancedModal.query}
                      onFocus={() => setNavigationScope("advanced")}
                      onChange={(event) =>
                        setAdvancedModal((state) => ({ ...state, query: event.target.value }))
                      }
                      placeholder="檢索時間、摘要、史料文本、備註、引文註釋..."
                    />
                  </label>
                  <label className="modal-label">
                    標籤
                    <select
                      value={advancedModal.tag}
                      onFocus={() => setNavigationScope("advanced")}
                      onChange={(event) =>
                        setAdvancedModal((state) => ({ ...state, tag: event.target.value }))
                      }
                    >
                      <option value="">全部標籤（{allTags.length}）</option>
                      {allTags.map((tag) => (
                        <option key={`advanced-tag-${tag}`} value={tag}>
                          {tag}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <section className="advanced-scope-panel">
                  <div className="advanced-scope-head">
                    <p className="eyebrow">關鍵字檢索範圍</p>
                    <p className="meta-text">可勾選一個或多個欄位</p>
                  </div>
                  <div className="advanced-scope-grid">
                    {ADVANCED_QUERY_SCOPE_OPTIONS.map((option) => {
                      const checked = advancedModal.queryScopes.includes(option.value);
                      return (
                        <label
                          key={`advanced-scope-${option.value}`}
                          className={`advanced-scope-item ${checked ? "checked" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              setAdvancedModal((state) => {
                                const next = event.target.checked
                                  ? Array.from(new Set([...state.queryScopes, option.value]))
                                  : state.queryScopes.filter((scope) => scope !== option.value);
                                return { ...state, queryScopes: next };
                              });
                            }}
                          />
                          <span>{option.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </section>

                <section className="advanced-destination">
                <p className="eyebrow">結果匯入</p>
                <div className="advanced-mode-grid">
                  <button
                    className={advancedModal.targetMode === "new-project" ? "scope active" : "scope"}
                    onClick={() => setAdvancedModal((state) => ({ ...state, targetMode: "new-project" }))}
                  >
                    新專案
                  </button>
                  <button
                    className={advancedModal.targetMode === "new-chapter" ? "scope active" : "scope"}
                    onClick={() => setAdvancedModal((state) => ({ ...state, targetMode: "new-chapter" }))}
                  >
                    新章節
                  </button>
                  <button
                    className={advancedModal.targetMode === "existing-chapter" ? "scope active" : "scope"}
                    onClick={() =>
                      setAdvancedModal((state) => ({
                        ...state,
                        targetMode: "existing-chapter",
                        existingChapterId:
                          state.existingChapterId &&
                          workspace.chapters[state.existingChapterId]?.projectId === state.existingProjectId
                            ? state.existingChapterId
                            : workspace.projects[state.existingProjectId]?.chapterIds[0] ?? "",
                        }))
                    }
                  >
                    現有章節
                  </button>
                </div>

                {advancedModal.targetMode === "new-project" && (
                  <label className="modal-label">
                    新專案名稱
                    <input
                      value={advancedModal.newProjectTitle}
                      onChange={(event) =>
                        setAdvancedModal((state) => ({ ...state, newProjectTitle: event.target.value }))
                      }
                    />
                  </label>
                )}

                {advancedModal.targetMode !== "new-project" && (
                  <label className="modal-label">
                    目標專案
                    <select
                      value={advancedModal.existingProjectId}
                      onChange={(event) => {
                        const projectId = event.target.value;
                        setAdvancedModal((state) => ({
                          ...state,
                          existingProjectId: projectId,
                          existingChapterId: workspace.projects[projectId]?.chapterIds[0] ?? "",
                        }));
                      }}
                    >
                      <option value="">請選擇專案</option>
                      {workspace.projectOrder.map((projectId) => {
                        const project = workspace.projects[projectId];
                        if (!project) {
                          return null;
                        }
                        return (
                          <option key={`advanced-project-${projectId}`} value={projectId}>
                            {project.title}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                )}

                {advancedModal.targetMode === "new-chapter" && (
                  <label className="modal-label">
                    新章節名稱
                    <input
                      value={advancedModal.newChapterTitle}
                      onChange={(event) =>
                        setAdvancedModal((state) => ({ ...state, newChapterTitle: event.target.value }))
                      }
                    />
                  </label>
                )}

                {advancedModal.targetMode === "existing-chapter" && (
                  <label className="modal-label">
                    目標章節
                    <select
                      value={advancedModal.existingChapterId}
                      onChange={(event) =>
                        setAdvancedModal((state) => ({ ...state, existingChapterId: event.target.value }))
                      }
                    >
                      <option value="">請選擇章節</option>
                      {(workspace.projects[advancedModal.existingProjectId]?.chapterIds ?? []).map((chapterId) => {
                        const chapter = workspace.chapters[chapterId];
                        if (!chapter) {
                          return null;
                        }
                        return (
                          <option key={`advanced-chapter-${chapterId}`} value={chapterId}>
                            {chapter.title}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                )}
                </section>
              </section>

              <section className="advanced-right-column">
                <div className="advanced-results-head">
                  <p className="eyebrow">檢索預覽</p>
                  <p className="result-meta">
                    {hasAdvancedSearch
                      ? `共 ${advancedResults.length} 條結果`
                      : "請至少輸入一個檢索條件。"}
                  </p>
                </div>

                <div
                  ref={advancedResultsRef}
                  className="advanced-results"
                  onMouseDown={() => setNavigationScope("advanced")}
                  onScroll={(event) => setAdvancedResultsScrollTop(event.currentTarget.scrollTop)}
                >
                  {hasAdvancedSearch ? (
                    deferredAdvancedQuery.trim() && !hasAdvancedQueryScope ? (
                      <p className="empty-inline">請至少勾選一個關鍵字檢索欄位。</p>
                    ) : advancedResults.length === 0 ? (
                      <p className="empty-inline">未檢索到符合內容。</p>
                    ) : (
                      <>
                        {shouldVirtualizeAdvancedResults && (
                          <div style={{ height: `${advancedVirtualRange.topSpacer}px` }} />
                        )}
                        {visibleAdvancedResults.map((result) => {
                        const entry = workspace.entries[result.entryId];
                        return (
                          <button
                            key={`advanced-${result.entryId}`}
                            data-advanced-entry-id={result.entryId}
                            className={`advanced-result virtualized-row ${selectedAdvancedResultEntryId === result.entryId ? "selected" : ""}`}
                            onClick={() => {
                              setSelectedAdvancedResultEntryId(result.entryId);
                              jumpToSearchResult(result, advancedHighlightQuery, "advanced");
                            }}
                            onDoubleClick={() => {
                              setSelectedAdvancedResultEntryId(result.entryId);
                              jumpToSearchResult(result, advancedHighlightQuery, "advanced");
                              beginViewEntry(result.entryId, advancedHighlightQuery);
                            }}
                          >
                            <div
                              className="search-path"
                              dangerouslySetInnerHTML={{
                                __html: renderHighlightedPlainText(
                                  `${result.projectTitle} / ${result.chapterTitle}`,
                                  advancedHighlightQuery,
                                ),
                              }}
                            />
                            <div
                              className="search-time"
                              dangerouslySetInnerHTML={{
                                __html: renderHighlightedPlainText(
                                  formatEntryHeadline(result.timeText, result.summaryText),
                                  advancedHighlightQuery,
                                ),
                              }}
                            />
                            {entry?.sourceText.trim() ? (
                              <div
                                className="advanced-source rich-markup"
                                dangerouslySetInnerHTML={{
                                  __html: renderHighlightedLightMarkup(
                                    summarizeAroundMatch(entry.sourceText, advancedHighlightQuery, 220),
                                    advancedHighlightQuery,
                                  ),
                                }}
                              />
                            ) : (
                              <div className="advanced-source">（尚未輸入史料文本）</div>
                            )}
                            <div
                              className="search-citation"
                              dangerouslySetInnerHTML={{
                                __html: renderHighlightedPlainText(
                                  summarizeAroundMatch(
                                    entry?.citation.trim() || "",
                                    advancedHighlightQuery,
                                    120,
                                  ) || "（尚未輸入引文註釋）",
                                  advancedHighlightQuery,
                                ),
                              }}
                            />
                            {entry?.note &&
                              hasHighlightMatch(noteTextWithoutTags(entry.note), advancedHighlightQuery) && (
                              <div
                                className="search-citation"
                                dangerouslySetInnerHTML={{
                                  __html: `備註：${renderHighlightedPlainText(
                                    summarizeAroundMatch(noteTextWithoutTags(entry.note), advancedHighlightQuery, 120),
                                    advancedHighlightQuery,
                                  )}`,
                                }}
                              />
                            )}
                            {result.tags.length > 0 && (
                              <div className="tag-row">
                                {result.tags.map((tag) => (
                                  <span
                                    key={`${result.entryId}-advanced-${tag}`}
                                    className="tag-chip"
                                    dangerouslySetInnerHTML={{
                                      __html: renderHighlightedPlainText(tag, advancedHighlightQuery),
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                          </button>
                        );
                        })}
                        {shouldVirtualizeAdvancedResults && (
                          <div style={{ height: `${advancedVirtualRange.bottomSpacer}px` }} />
                        )}
                      </>
                    )
                  ) : (
                    <p className="empty-inline">輸入檢索條件後，結果會顯示在這裡。</p>
                  )}
                </div>
              </section>
            </div>

            <div className="modal-actions">
              <button
                className="secondary-btn"
                onClick={importAdvancedResults}
                disabled={!hasAdvancedSearch || advancedResults.length === 0}
              >
                匯出檢索結果
              </button>
            </div>
          </div>
        </div>
      )}

      {mergeModal.open && (
        <div className="modal-backdrop" style={modalBackdropStyle("merge-project")}>
          <div
            className="modal-card modal-large draggable-modal"
            style={modalCardStyle("merge-project")}
            onMouseDown={(event) => {
              activateOverlayModal("merge-project");
              event.stopPropagation();
            }}
          >
            {renderModalClose("merge-project")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "merge-project")}
            >
              <h3>合併專案</h3>
              <p className="meta-text">可合併到當前專案，或合併並生成新的專案。</p>
            </div>

            <div className="merge-mode-row">
              <button
                className={mergeModal.mode === "as-new" ? "scope active" : "scope"}
                onClick={() => setMergeModal((state) => ({ ...state, mode: "as-new" }))}
              >
                合併為新專案
              </button>
              <button
                className={mergeModal.mode === "into-active" ? "scope active" : "scope"}
                onClick={() => setMergeModal((state) => ({ ...state, mode: "into-active" }))}
              >
                合併到當前專案
              </button>
            </div>

            {mergeModal.mode === "as-new" && (
              <label className="modal-label">
                新專案名稱
                <input
                  value={mergeModal.newProjectTitle}
                  onChange={(event) =>
                    setMergeModal((state) => ({ ...state, newProjectTitle: event.target.value }))
                  }
                />
              </label>
            )}

            <div className="merge-list">
              {workspace.projectOrder.map((projectId) => {
                const project = workspace.projects[projectId];
                if (!project) {
                  return null;
                }

                const checked = mergeModal.selectedProjectIds.includes(projectId);
                const disabled = mergeModal.mode === "into-active" && projectId === activeProject?.id;

                return (
                  <label key={projectId} className={`merge-item ${disabled ? "disabled" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => {
                        const next = new Set(mergeModal.selectedProjectIds);
                        if (event.target.checked) {
                          next.add(projectId);
                        } else {
                          next.delete(projectId);
                        }
                        setMergeModal((state) => ({ ...state, selectedProjectIds: [...next] }));
                      }}
                    />
                    <span>{project.title}</span>
                  </label>
                );
              })}
            </div>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => requestCloseOverlayModal("merge-project")}>
                取消
              </button>
              <button className="secondary-btn" onClick={executeMerge}>
                執行合併
              </button>
            </div>
          </div>
        </div>
      )}

      {chapterMergeModal.open && (
        <div className="modal-backdrop" style={modalBackdropStyle("merge-chapter")}>
          <div
            className="modal-card modal-large draggable-modal"
            style={modalCardStyle("merge-chapter")}
            onMouseDown={(event) => {
              activateOverlayModal("merge-chapter");
              event.stopPropagation();
            }}
          >
            {renderModalClose("merge-chapter")}
            <div
              className="modal-head modal-drag-handle"
              onMouseDown={(event) => startModalDrag(event, "merge-chapter")}
            >
              <h3>合併章節</h3>
              <p className="meta-text">選擇多個章節，合併為目標專案中的新章節（不刪除來源章節）。</p>
            </div>

            <label className="modal-label">
              目標專案
              <select
                value={chapterMergeModal.targetProjectId}
                onChange={(event) =>
                  setChapterMergeModal((state) => ({ ...state, targetProjectId: event.target.value }))
                }
              >
                <option value="">請選擇專案</option>
                {workspace.projectOrder.map((projectId) => {
                  const project = workspace.projects[projectId];
                  if (!project) {
                    return null;
                  }
                  return (
                    <option key={`chapter-merge-${projectId}`} value={projectId}>
                      {project.title}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="modal-label">
              新章節名稱
              <input
                value={chapterMergeModal.newChapterTitle}
                onChange={(event) =>
                  setChapterMergeModal((state) => ({ ...state, newChapterTitle: event.target.value }))
                }
              />
            </label>

            <div className="merge-list">
              {workspace.projectOrder.map((projectId) => {
                const project = workspace.projects[projectId];
                if (!project || project.chapterIds.length === 0) {
                  return null;
                }

                return (
                  <div key={`chapter-group-${projectId}`} className="merge-group">
                    <p className="merge-group-title">{project.title}</p>
                    {project.chapterIds.map((chapterId) => {
                      const chapter = workspace.chapters[chapterId];
                      if (!chapter) {
                        return null;
                      }
                      const checked = chapterMergeModal.selectedChapterIds.includes(chapterId);
                      return (
                        <label key={`chapter-select-${chapterId}`} className="merge-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const next = new Set(chapterMergeModal.selectedChapterIds);
                              if (event.target.checked) {
                                next.add(chapterId);
                              } else {
                                next.delete(chapterId);
                              }
                              setChapterMergeModal((state) => ({ ...state, selectedChapterIds: [...next] }));
                            }}
                          />
                          <span>
                            {chapter.title}（{chapter.entryIds.length}）
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => requestCloseOverlayModal("merge-chapter")}>
                取消
              </button>
              <button className="secondary-btn" onClick={executeChapterMerge}>
                執行合併
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
