/**
 * OCRProvider：本地/API/MCP 模式统一的文档解析接口（设计 §4.2、§7.1）。
 * 首个实现复用队友 TEACHER 管线（分页 Markdown、题目切割、图片关联）。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface OcrDocumentRef {
  /** 对象存储键或本地路径；禁止签名 URL */
  readonly storageRef: string;
  readonly mimeType: string;
  readonly contentHash: string;
}

export type OcrMode = "text_only" | "layout" | "full_with_images";

export interface OcrBlock {
  readonly pageNo: number;
  readonly blockType: "paragraph" | "question_box" | "image_region" | "table" | "heading";
  /** [x, y, w, h] 归一化坐标 */
  readonly bbox: readonly [number, number, number, number];
  readonly markdown?: string;
}

export interface OcrPageResult {
  readonly pageNo: number;
  readonly markdown: string;
  readonly blocks: readonly OcrBlock[];
  /** 切出的题图等；字节以引用形式返回，由调用方入库（同事务写 question_asset） */
  readonly images: readonly {
    readonly bbox: readonly [number, number, number, number];
    readonly mimeType: string;
    readonly bytesRef: string;
    readonly contentHash: string;
  }[];
}

export interface OcrParseRequest extends ProviderRequestBase {
  readonly document: OcrDocumentRef;
  readonly mode: OcrMode;
  /** 输出结构约束（如 SourceFragment 列表 schema） */
  readonly outputSchema?: Record<string, unknown>;
}

export interface OcrParseResponse {
  readonly pages: readonly OcrPageResult[];
  readonly parserVersion: string;
}

export interface OCRProvider {
  parse(req: OcrParseRequest): Promise<ProviderResult<OcrParseResponse>>;
}
