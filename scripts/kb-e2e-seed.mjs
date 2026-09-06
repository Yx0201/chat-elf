/**
 * 知识库 E2E 种子脚本(开发用,不入业务链路)。
 *
 * 用途:在不开 Vercel Blob 的本地环境验证摄取/检索全链路 ——
 * 直接落 knowledge_bases + uploaded_files(status=processing + 六阶段初始状态,
 * blob_url 留空),之后由客户端面板/脚本 POST /process 走**真实管线**推进
 * (分块/分词/嵌入/图谱/摘要全部真跑,只有 Blob 上传被跳过)。
 *
 * 运行:node scripts/kb-e2e-seed.mjs [userEmail]
 * 幂等:先删同名测试库再建(级联清文件/分块/图谱)。
 */

import { readFileSync } from "node:fs";
import { Pool } from "pg";

const EMAIL = process.argv[2] ?? "yang@qq.com";

function loadEnv(key) {
  const match = readFileSync(".env.local", "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!match) throw new Error(`.env.local 缺少 ${key}`);
  return match[1].trim();
}

const SAMPLE_NOVEL = `第一章 雨夜归人
宗杭冒雨赶回了城南的老宅。这栋宅子是曾祖父留下的,青砖灰瓦,在雨里像一头蛰伏的兽。
他推开门,屋里一片漆黑,只有天井漏下来的雨声哗哗作响。"有人吗?"他喊了一声,没人应。
手电筒的光柱扫过堂屋,照见八仙桌上多了一样东西——一面青铜镜,镜面斑驳,背面刻着三圈交错的纹路。
宗杭伸手去拿,指尖触到镜面的瞬间,一道白光炸开,他失去了知觉。

第二章 镜中的字
醒来时天已经亮了。宗杭发现自己躺在堂屋的地板上,青铜镜端端正正压在他胸口。
镜面上凝着一层水汽,他用袖子去擦,水汽下竟浮现出一行小字:三线轮回,始于足下。
他猛地坐起来。这行字不是刻上去的,更像是有人隔着镜面从另一侧写给他看的。
手机在这时响了,是大学同学雨欣。她的声音很急:"宗杭,你爷爷留下的那批考古笔记,我整理出问题了——三份不同年代的记录,画的是同一座墓。"
宗杭盯着镜面上的字,一字一字地念给她听。电话那头沉默了很久,雨欣说:"笔记的最后一页,也写着这八个字。"

第三章 地下的入口
三天后,两人站在老宅地窖的暗门前。门上的锁是曾祖父亲手打的,钥匙藏在那面青铜镜的夹层里。
雨欣举着灯,手在抖:"三份笔记说,这座墓的入口会随轮回移动,每次开启的位置都不一样。上一次打开,是一百年前。"
宗杭把钥匙插进锁孔,转了三圈。暗门下沉,露出一道向下的石阶,阶壁上刻满了三圈交错的纹路,和镜背的一模一样。
石阶尽头是一间圆形石室,中央摆着一具空的石棺。棺盖上放着一本崭新的笔记本,墨迹未干。
雨欣翻开第一页,倒吸一口冷气——那是宗杭的笔迹,写着今天的日期,和一句话:"如果你读到这里,说明我们已经进了第三次轮回。"`;

const INITIAL_PROCESS_STATE = {
  version: 2,
  stage: "retrieval",
  totalPercent: 0,
  totalStages: 6,
  currentStageIndex: 2,
  startedAt: new Date().toISOString(),
  counts: {
    retrievalParentChunks: 0,
    retrievalChildChunks: 0,
    embeddedChunks: 0,
    graphChunks: 0,
    graphBuiltChunks: 0,
  },
  steps: [
    { key: "upload", label: "上传保存", description: "保存原始文件和基础记录", status: "completed", progress: 100 },
    { key: "retrieval", label: "检索分块", description: "按混合检索策略切出父子 chunk", status: "running", progress: 0 },
    { key: "embed", label: "向量构建", description: "为检索子 chunk 生成 embedding 与关键词索引", status: "pending", progress: 0 },
    { key: "graphSplit", label: "图谱分块", description: "按小说结构切出专用 graph chunk", status: "pending", progress: 0 },
    { key: "graphBuild", label: "图谱构建", description: "提取实体、关系并写入图谱表", status: "pending", progress: 0 },
    { key: "finalize", label: "完成收尾", description: "生成内容摘要并更新状态", status: "pending", progress: 0 },
  ],
};

const KB_NAME = "E2E测试·三线轮回节选";

const pool = new Pool({ connectionString: loadEnv("DATABASE_URL") });

try {
  const { rows: userRows } = await pool.query('SELECT id FROM "user" WHERE email = $1', [EMAIL]);
  if (userRows.length === 0) throw new Error(`用户 ${EMAIL} 不存在,先在登录页注册`);
  const userId = userRows[0].id;

  await pool.query("DELETE FROM knowledge_bases WHERE user_id = $1 AND name = $2", [userId, KB_NAME]);

  const { rows: kbRows } = await pool.query(
    "INSERT INTO knowledge_bases (user_id, name, description) VALUES ($1, $2, $3) RETURNING id",
    [userId, KB_NAME, "E2E 种子数据:三章短篇,免 Blob 走真实摄取管线"],
  );
  const kbId = kbRows[0].id;

  const { rows: fileRows } = await pool.query(
    `INSERT INTO uploaded_files (kb_id, file_name, size_bytes, content, status, metadata)
     VALUES ($1, $2, $3, $4, 'processing', $5::jsonb) RETURNING id`,
    [kbId, "三线轮回节选.txt", Buffer.byteLength(SAMPLE_NOVEL, "utf8"), SAMPLE_NOVEL, JSON.stringify({ process: INITIAL_PROCESS_STATE })],
  );

  console.log(`种子完成: kbId=${kbId} fileId=${fileRows[0].id} userEmail=${EMAIL}`);
  console.log("下一步:登录后在 /knowledge 详情页等面板自动推进,或 curl POST process 路由。");
} finally {
  await pool.end();
}
