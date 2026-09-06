/**
 * 文件处理流水线推进 —— Route Handler(例外清单:长任务分批推进)。
 *
 * GET  :查进度(轮询用,只读 metadata.process)。
 * POST :推进**一个有界批次**(阶段内批量有上限,hobby 函数时长约束下安全),
 *       客户端 250ms 轮询直到 status=completed/failed。
 * 失败:阶段异常 → markPipelineFailed 落库 → 500;用户可 retry(重置状态)。
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth/session";
import { getFile, isValidFileId, isValidKbId } from "@/lib/knowledge/repository";
import {
  advancePipeline,
  markPipelineFailed,
  parseUploadPipelineState,
  updateFileProcess,
} from "@/lib/knowledge/ingestion/process-pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteParams {
  params: Promise<{ kbId: string; fileId: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const userId = await getSessionUserId();
  if (userId === null) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { kbId, fileId } = await params;
  if (!isValidKbId(kbId) || !isValidFileId(fileId)) {
    return NextResponse.json({ error: "无效的ID" }, { status: 400 });
  }

  const file = await getFile(userId, fileId);
  if (file === null || file.kbId !== kbId) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  return NextResponse.json({
    fileId: file.id,
    filename: file.fileName,
    status: file.status,
    process: parseUploadPipelineState(file.metadata),
  });
}

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const userId = await getSessionUserId();
  if (userId === null) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { kbId, fileId } = await params;
  if (!isValidKbId(kbId) || !isValidFileId(fileId)) {
    return NextResponse.json({ error: "无效的ID" }, { status: 400 });
  }

  const file = await getFile(userId, fileId);
  if (file === null || file.kbId !== kbId) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const currentState = parseUploadPipelineState(file.metadata);
  if (currentState === null) {
    return NextResponse.json({ error: "文件处理状态缺失" }, { status: 409 });
  }

  if (file.status === "completed" || (currentState.stage === "finalize" && currentState.completedAt)) {
    return NextResponse.json({
      fileId: file.id,
      filename: file.fileName,
      status: "completed",
      process: currentState,
    });
  }

  try {
    const nextState = await advancePipeline({
      kbId,
      fileId,
      fileName: file.fileName,
      content: file.content ?? "",
      fileMetadata: file.metadata,
      state: currentState,
    });
    const completed = nextState.completedAt !== undefined;
    await updateFileProcess(fileId, nextState, completed ? "completed" : "processing");

    return NextResponse.json({
      fileId: file.id,
      filename: file.fileName,
      status: completed ? "completed" : "processing",
      process: nextState,
    });
  } catch (error) {
    console.error("[knowledge] 文件处理失败:", error);
    const failedState = markPipelineFailed(
      currentState,
      error instanceof Error ? error.message : "文件处理失败",
    );
    await updateFileProcess(fileId, failedState, "failed");

    return NextResponse.json(
      {
        error: "文件处理失败,请重试",
        fileId: file.id,
        filename: file.fileName,
        status: "failed",
        process: failedState,
      },
      { status: 500 },
    );
  }
}
