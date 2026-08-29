import { RealtimeConfigError, resolveRealtimeEndpoint, type RealtimeEndpoint } from "@/lib/realtime/provider";

/**
 * WebRTC 信令转发 —— ARCHITECTURE.md「实时链路架构」核心一环。
 *
 * 浏览器将 Offer SDP POST 到本路由;此处按当前 provider(tokenplan / dashscope)
 * 解析信令端点,附加 Bearer 鉴权头后转发,并把 Answer SDP 原样返回给浏览器。
 * API Key 只存在于服务端,绝不进入前端 bundle。
 *
 * 两条通道的信令形态一致(POST {endpoint}/api/v1/webrtc/realtime?model=xxx,
 * Content-Type: application/sdp),已按官方文档核实(2026-08):
 *   - https://help.aliyun.com/zh/model-studio/realtime-token-authentication
 *   - https://help.aliyun.com/zh/model-studio/realtime
 */

// 编码约定:Route Handler 默认 Node.js runtime,显式声明以防默认值变化。
export const runtime = "nodejs";
// SDP 交换不可缓存;每次都执行。
export const dynamic = "force-dynamic";

/** 正常 SDP 为数 KB 量级,超限视为非法请求。 */
const MAX_SDP_LENGTH = 128 * 1024;

function loadConfig(): { config: RealtimeEndpoint } | { errorResponse: Response } {
  try {
    return { config: resolveRealtimeEndpoint() };
  } catch (error) {
    if (error instanceof RealtimeConfigError) {
      return {
        errorResponse: Response.json({ error: error.message }, { status: 500 }),
      };
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  const loaded = loadConfig();
  if ("errorResponse" in loaded) {
    return loaded.errorResponse;
  }
  const { config } = loaded;

  const offerSdp = await request.text();
  if (offerSdp.length === 0 || offerSdp.length > MAX_SDP_LENGTH) {
    return Response.json(
      { error: "请求体应为非空的 Offer SDP(application/sdp)文本" },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(config.signalingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: offerSdp,
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: `连接 ${config.provider} 信令端点失败` },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500);
    return Response.json(
      {
        error: `${config.provider} 信令交换失败`,
        upstream_status: upstream.status,
        detail,
      },
      { status: 502 },
    );
  }

  const answerSdp = await upstream.text();
  return new Response(answerSdp, {
    status: 200,
    headers: { "Content-Type": "application/sdp" },
  });
}
