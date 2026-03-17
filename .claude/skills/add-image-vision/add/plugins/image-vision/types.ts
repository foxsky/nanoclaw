/**
 * TypeScript interfaces for Image Vision Plugin
 */

export interface ImageVisionConfig {
  enabled: boolean;
  maxMediaAge?: number; // days to keep media files (default: 7)
  maxFileSize?: number; // max file size in bytes (default: 10MB)
}

export interface MediaDownloadResult {
  success: boolean;
  filePath?: string;
  mimeType?: string;
  size?: number;
  error?: string;
}

export interface MediaMessage {
  messageId: string;
  timestamp: number;
  groupFolder: string;
  mediaType: 'image' | 'video' | 'document';
  caption?: string;
}
