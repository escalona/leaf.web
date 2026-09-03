/** UI-only file metadata, independent of any persistence engine. */
export type FileNavigationEntry = {
  url: string;
  /** Stable file id, independent of the branch baked into `url`. */
  fileId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Resolved shared-asset URL for the dashboard thumbnail, when one exists. */
  thumbnailUrl?: string | null;
};
