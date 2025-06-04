export type NotificationEntity = {
  id: string;
  subject: string;
  notificationTypeCode: string;
  body: string;
  workspaceId?: string;
  workspaceName?: string;
  userId?: string;
  createAt: Date;
  isRead?: boolean;
};

export type NotificationListParams = {
  offset: number;
  limit: number;
  userId: string;
};

export type NotificationListData = {
  results: NotificationEntity[];
  maxCount: number;
  unReadCount: number;
};

// type FileDesignParams = {
//   designId: string;
//   version: number[];
// };
//
// export type FileListResults = {
//   results: FileEntity[];
//   count: number;
// };
