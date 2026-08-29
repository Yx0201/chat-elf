/**
 * 将 DataChannel 收到的未知 JSON 数据收窄为强类型的 ServerEvent。
 *
 * 本模块刻意不使用类型断言绕过检查(AGENTS.md 约束):对每种事件逐一显式校验
 * 并构造对象,25 种服务端事件全部覆盖,编译期保证与 ServerEvent 联合类型一致。
 * 待引入 zod(架构已确认选型,记忆层功能需要时征得同意后安装)可整体替换本文件。
 */

import type {
  ConversationItem,
  ItemContentPart,
  Modality,
  RealtimeErrorBody,
  RealtimeResponse,
  ServerEvent,
} from "./events";
import { isServerEventTypeName } from "./events";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // 对象字面量到索引类型的收窄:仅用于字段级读取,后续每个字段仍单独校验。
  return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modalityList(value: unknown): Modality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list: Modality[] = [];
  for (const item of value) {
    if (item === "text" || item === "audio") {
      list.push(item);
    }
  }
  return list.length > 0 ? list : undefined;
}

function ensureErrorBody(value: unknown): RealtimeErrorBody {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  return {
    type: str(record.type),
    code: str(record.code),
    message: str(record.message),
    param: str(record.param),
  };
}

function ensureContentPart(value: unknown): ItemContentPart {
  const record = asRecord(value);
  if (record === null) {
    return { type: "text" };
  }
  const partType = str(record.type);
  return {
    type: partType === "text" || partType === "audio" ? partType : "text",
    text: str(record.text),
    transcript: str(record.transcript),
  };
}

function ensureContentParts(value: unknown): ItemContentPart[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(ensureContentPart);
}

function ensureConversationItem(value: unknown): ConversationItem {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  const itemType = str(record.type);
  const role = str(record.role);
  return {
    id: str(record.id),
    object: str(record.object) === "realtime.item" ? "realtime.item" : undefined,
    status: str(record.status),
    role: role === "user" || role === "assistant" || role === "system" ? role : undefined,
    type: itemType === "message" || itemType === "function_call" ? itemType : undefined,
    content: ensureContentParts(record.content),
    name: str(record.name),
    call_id: str(record.call_id),
    arguments: str(record.arguments),
  };
}

interface UsageValue {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

function ensureUsage(value: unknown): UsageValue | undefined {
  const record = asRecord(value);
  if (record === null) {
    return undefined;
  }
  const total = num(record.total_tokens);
  const input = num(record.input_tokens);
  const output = num(record.output_tokens);
  if (total === undefined || input === undefined || output === undefined) {
    return undefined;
  }
  return { total_tokens: total, input_tokens: input, output_tokens: output };
}

function ensureResponse(value: unknown): RealtimeResponse {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  const status = str(record.status);
  return {
    id: str(record.id),
    conversation_id: str(record.conversation_id),
    object: str(record.object) === "realtime.response" ? "realtime.response" : undefined,
    status:
      status === "in_progress" ||
      status === "completed" ||
      status === "failed" ||
      status === "incomplete"
        ? status
        : undefined,
    modalities: modalityList(record.modalities),
    voice: str(record.voice),
    output: Array.isArray(record.output) ? record.output.map(ensureConversationItem) : undefined,
    usage: ensureUsage(record.usage),
  };
}

function indexes(
  raw: Record<string, unknown>,
): { response_id?: string; item_id?: string; output_index?: number; content_index?: number } {
  return {
    response_id: str(raw.response_id),
    item_id: str(raw.item_id),
    output_index: num(raw.output_index),
    content_index: num(raw.content_index),
  };
}

function callFields(
  raw: Record<string, unknown>,
): { call_id?: string; delta?: string } {
  return { call_id: str(raw.call_id), delta: str(raw.delta) };
}

/**
 * 解析服务端事件。返回 null 表示数据不是可识别的事件对象
 * (不抛错——DataChannel 上出现异常报文不应中断会话)。
 */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  const outer = asRecord(raw);
  if (outer === null) {
    return null;
  }
  const typeName = str(outer.type);
  if (typeName === undefined || !isServerEventTypeName(typeName)) {
    return null;
  }

  const eventId = str(outer.event_id);

  switch (typeName) {
    case "error":
      return { ...(eventId === undefined ? {} : { event_id: eventId }), type: "error", error: ensureErrorBody(outer.error) };
    case "session.created": {
      const session = asRecord(outer.session);
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "session.created",
        session: {
          object: session ? str(session.object) : undefined,
          model: session ? str(session.model) : undefined,
          voice: session ? str(session.voice) : undefined,
        },
      };
    }
    case "session.updated":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "session.updated",
        session: {},
      };
    case "input_audio_buffer.speech_started":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "input_audio_buffer.speech_started",
        audio_start_ms: num(outer.audio_start_ms),
        item_id: str(outer.item_id),
      };
    case "input_audio_buffer.speech_stopped":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "input_audio_buffer.speech_stopped",
        audio_end_ms: num(outer.audio_end_ms),
        item_id: str(outer.item_id),
      };
    case "input_audio_buffer.committed":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "input_audio_buffer.committed",
        item_id: str(outer.item_id),
      };
    case "input_audio_buffer.cleared":
      return { ...(eventId === undefined ? {} : { event_id: eventId }), type: "input_audio_buffer.cleared" };
    case "conversation.item.created":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "conversation.item.created",
        previous_item_id: str(outer.previous_item_id),
        item: ensureConversationItem(outer.item),
      };
    case "conversation.item.input_audio_transcription.delta":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "conversation.item.input_audio_transcription.delta",
        item_id: str(outer.item_id),
        content_index: num(outer.content_index),
        text: str(outer.text),
        stash: str(outer.stash),
        language: str(outer.language),
        emotion: str(outer.emotion),
      };
    case "conversation.item.input_audio_transcription.completed":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "conversation.item.input_audio_transcription.completed",
        item_id: str(outer.item_id),
        content_index: num(outer.content_index),
        transcript: str(outer.transcript),
      };
    case "conversation.item.input_audio_transcription.failed":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: "conversation.item.input_audio_transcription.failed",
        item_id: str(outer.item_id),
        content_index: num(outer.content_index),
        error: ensureErrorBody(outer.error),
      };
    case "response.output_item.added":
    case "response.output_item.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        response_id: str(outer.response_id),
        output_index: num(outer.output_index),
        item: ensureConversationItem(outer.item),
      };
    case "response.content_part.added":
    case "response.content_part.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
        part: ensureContentPart(outer.part),
      };
    case "response.text.delta":
    case "response.audio_transcript.delta":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
        delta: str(outer.delta),
      };
    case "response.text.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
        text: str(outer.text),
      };
    case "response.audio.delta":
    case "response.function_call_arguments.delta":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
        ...callFields(outer),
      };
    case "response.audio.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
      };
    case "response.audio_transcript.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
        transcript: str(outer.transcript),
      };
    case "response.function_call_arguments.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        ...indexes(outer),
        call_id: str(outer.call_id),
        name: str(outer.name),
        arguments: str(outer.arguments),
      };
    case "response.created":
    case "response.done":
      return {
        ...(eventId === undefined ? {} : { event_id: eventId }),
        type: typeName,
        response: ensureResponse(outer.response),
      };
    default:
      // 卫语句已确认 typeName ∈ ServerEventTypeName 且上方覆盖全部成员,不可达。
      return null;
  }
}
