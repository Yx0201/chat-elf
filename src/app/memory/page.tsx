/**
 * 04 记忆列表 · 服务端壳(2026-08-31 起为唯一记忆页,接真实 memories 表 +
 * user_profile 画像;step3 T5「TA 记得你」,同时是合规基础:用户可看见并删除)。
 *
 * 桌面:左 440px 深色舞台(notify 球 200px 浅体深眼 + 蓝点),
 * 右列表区(页头 + 画像卡 + 分组 + 记忆条目)。H5:舞台压缩在顶部、列表全宽。
 *
 * 交互(spec §3.4,在客户端组件 MimicMemoryList):
 * - 点某条记忆 → 球 wink 一下再转回 notify(「我想起这个了」);
 * - 删除一条(deleteMemoryAction 物理删除)→ 球 sleep 一下再弹回 + refresh。
 */

import { MimicMemoryList } from "@/components/mimic/mimic-memory-list";
import { requirePageUserId } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listConversations } from "@/lib/memory/conversations";
import { getProfile } from "@/lib/memory/profile";
import { listMemories, type MemoryListItem } from "@/lib/memory/store";

// 记忆会被删除、画像会被重写,不能静态化
export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const userId = await requirePageUserId();
  const persistence = isDatabaseConfigured();
  const [memories, profile, latest] = persistence
    ? await Promise.all([
        listMemories(userId),
        getProfile(userId),
        listConversations(userId, 1),
      ])
    : [[], null, []];

  return (
    <MimicMemoryList
      memories={memories satisfies MemoryListItem[]}
      profileSummary={profile?.summary ?? ""}
      persistence={persistence}
      latestConversationId={latest[0]?.id ?? null}
    />
  );
}