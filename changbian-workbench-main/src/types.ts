export interface Entry {
  id: string;
  // 供備註互相引用的編號：建立時間的年月日時分秒（14 位），見 entry-refs.ts。
  refId: string;
  projectId: string;
  chapterId: string;
  timeText: string;
  summary: string;
  sourceText: string;
  note: string;
  citation: string;
  createdAt: number;
  updatedAt: number;
}

export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  entryIds: string[];
  createdAt: number;
}

export interface Project {
  id: string;
  title: string;
  chapterIds: string[];
  createdAt: number;
}

export interface TrashedProject {
  kind: "project";
  projectIndex: number;
  project: Project;
  chapters: Chapter[];
  entries: Entry[];
}

export interface TrashedChapter {
  chapter: Chapter;
  chapterIndex: number;
}

export interface TrashedChapters {
  kind: "chapter";
  chapters: TrashedChapter[];
  entries: Entry[];
}

export interface TrashedEntry {
  entry: Entry;
  entryIndex: number;
}

export interface TrashedEntries {
  kind: "entry";
  entries: TrashedEntry[];
}

export type TrashPayload = TrashedProject | TrashedChapters | TrashedEntries;

export interface TrashItem {
  id: string;
  deletedAt: number;
  label: string;
  payload: TrashPayload;
}

export interface WorkspaceData {
  schemaVersion: number;
  revision: number;
  projectOrder: string[];
  projects: Record<string, Project>;
  chapters: Record<string, Chapter>;
  entries: Record<string, Entry>;
  trash: TrashItem[];
  activeProjectId: string | null;
  activeChapterId: string | null;
  selectedEntryId: string | null;
}

export interface OrderedEntryRef {
  entry: Entry;
  project: Project;
  chapter: Chapter | null;
  order: number;
}
