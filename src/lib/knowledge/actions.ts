"use server";

/**
 * 知识库管理 Server Actions —— 建/删库、删文件、重试 failed 文件。
 *
 * 分工原则(ARCHITECTURE.md):写操作走 Server Action;上传与流水线推进
 * 是 Route Handler 例外(大文件 + 长任务分批)。全部 action 首行鉴权,
 * 客户端传入的 id 一律 UUID 校验 + 归属过滤(他人的 id 视为不存在)。
 */

import { revalidatePath } from "next/cache";
import { requireActionUserId } from "@/lib/auth/session";
import {
  createKnowledgeBase,
  deleteFile,
  deleteKnowledgeBase,
  isValidFileId,
  isValidKbId,
  resetFileForRetry,
} from "./repository";

export async function createKnowledgeBaseAction(input: {
  name: string;
  description: string;
}): Promise<{ ok: true; kbId: string } | { ok: false; error: string }> {
  const userId = await requireActionUserId();
  if (userId === null) return { ok: false, error: "未登录" };

  const name = input.name.trim();
  if (name.length === 0 || name.length > 60) {
    return { ok: false, error: "知识库名称需为 1-60 个字符" };
  }
  const description = input.description.trim().slice(0, 200);

  const kb = await createKnowledgeBase(userId, { name, description });
  revalidatePath("/knowledge");
  return { ok: true, kbId: kb.id };
}

export async function deleteKnowledgeBaseAction(kbId: string): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidKbId(kbId)) return false;
  const ok = await deleteKnowledgeBase(userId, kbId);
  if (ok) revalidatePath("/knowledge");
  return ok;
}

export async function deleteFileAction(fileId: string): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidFileId(fileId)) return false;
  const ok = await deleteFile(userId, fileId);
  if (ok) revalidatePath("/knowledge");
  return ok;
}

/** failed 文件重置为 uploaded 并清进度(从 retrieval 阶段重来)。 */
export async function retryFileAction(fileId: string): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidFileId(fileId)) return false;
  const ok = await resetFileForRetry(userId, fileId);
  if (ok) revalidatePath("/knowledge");
  return ok;
}

/**
 * 语音线的知识检索工具执行体(step2 T2):realtime 模型发起 function call 后
 * 由客户端 hook 调用本 action,结果经 DataChannel 回传给模型。
 *
 * 失败语义:**永不抛错** —— 模型在静默等回执,抛错只会造成无限沉默;
 * 一律返回可朗读的降级文案让模型自然继续。
 * 调用频控在客户端 hook(单会话 8 次),这里只做合法性收窄。
 */
export async function searchKnowledgeAction(input: {
  query: string;
  kbId?: string;
  mode?: string;
}): Promise<{ context: string }> {
  const userId = await requireActionUserId();
  if (userId === null) {
    return { context: "知识库检索暂不可用,请基于已有知识自然回应。" };
  }

  const query = input.query.trim().slice(0, 200);
  const mode = input.mode === "fast" || input.mode === "graph" ? input.mode : "hybrid";
  if (query === "") {
    return { context: "检索词为空,请直接基于已有知识回答。" };
  }
  const kbId = input.kbId !== undefined && isValidKbId(input.kbId) ? input.kbId : undefined;

  const [{ searchKnowledge }, { buildSearchContext, VOICE_BUDGET }] = await Promise.all([
    import("./search/search-service"),
    import("./search/context-builder"),
  ]);

  try {
    const items = await searchKnowledge(query, { userId, kbId }, mode);
    if (items.length === 0) {
      return {
        context:
          "知识库中没有检索到相关内容。请如实告知用户资料里似乎没有这部分,基于已有知识简短回应即可。",
      };
    }
    const { context } = buildSearchContext(items, VOICE_BUDGET);
    return {
      context:
        `以下是知识库检索结果(方括号编号对应来源文件,回答时可口头提及文件名):\n\n${context}`,
    };
  } catch (error) {
    console.error("[knowledge] 语音检索失败(降级):", error instanceof Error ? error.message : error);
    return {
      context: "知识库检索暂时不可用,请告知用户稍后再试,先基于已有知识回应。",
    };
  }
}

/**
 * 检索测试(KB 详情页面板)。检索失败返回可读错误而非抛出 ——
 * 面板是调试工具,把错误亮出来比静默更有用。
 */
export async function searchKnowledgeTestAction(
  kbId: string,
  query: string,
  mode: "hybrid" | "graph" | "fast",
): Promise<
  | {
      ok: true;
      items: Array<{ fileName: string; text: string; score: number; rerankScore: number | null; source: string }>;
    }
  | { ok: false; error: string }
> {
  const userId = await requireActionUserId();
  if (userId === null) return { ok: false, error: "未登录" };
  if (!isValidKbId(kbId) || query.trim() === "") {
    return { ok: false, error: "参数无效" };
  }

  const { searchKnowledge } = await import("./search/search-service");
  try {
    const items = await searchKnowledge(query.trim(), { userId, kbId }, mode);
    return {
      ok: true,
      items: items.map((item) => ({
        fileName: item.fileName,
        text: item.text,
        score: item.score,
        rerankScore: item.rerankScore ?? null,
        source: item.source,
      })),
    };
  } catch (error) {
    console.error("[knowledge] 检索测试失败:", error);
    return { ok: false, error: error instanceof Error ? error.message : "检索失败" };
  }
}
