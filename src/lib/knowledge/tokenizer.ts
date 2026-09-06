/**
 * 应用层中文分词(@node-rs/jieba,Rust/N-API)—— 自 codeweaver 移植,逻辑不变。
 *
 * 取代 pgjieba:同一套分词逻辑在写入侧(构建 tsvector)与查询侧(构建 tsquery)
 * 都跑在 Node.js,词元经 PostgreSQL 的 'simple' 文本搜索配置原样落库(不做词干化)。
 *
 * 停用词过滤放在应用层:
 *   - tsvector 索引保持精简(滤掉无处不在的虚词)
 *   - tsquery 精度保持高位(对"的"做 OR 查询会命中所有块)
 *   - 索引侧与查询侧使用完全一致的词元集合
 */

import { Jieba } from "@node-rs/jieba";

let jieba: Jieba | null = null;

function getInstance(): Jieba {
  if (!jieba) {
    jieba = new Jieba();
  }
  return jieba;
}

/**
 * 常用中文停用词(无检索价值)。覆盖:
 *  - 结构助词:的地得了着过
 *  - 人称代词:我你他她它及复数
 *  - 指示代词:这那此其
 *  - 常用辅助词:是有没不都会能可被让
 *  - 连词/介词:和与或但而及在从到向于对为以
 *  - 常用副词:也 很 更 最 太 再 已 又 还 却 则 仍
 *  - 疑问词:什么 怎么 为什么 哪 谁 何
 *  - 无语义重量的高频语气词:吧 呢 啊 哦 嗯
 */
const STOP_WORDS = new Set<string>([
  // 助词
  "的", "地", "得", "了", "着", "过",
  // 代词
  "我", "你", "他", "她", "它",
  "我们", "你们", "他们", "她们", "它们",
  "自己", "彼此",
  // 指示代词
  "这", "那", "此", "其", "这个", "那个", "这些", "那些",
  // 系词/存现
  "是", "有", "没", "没有", "无",
  // 助动词/情态
  "不", "都", "就", "会", "能", "可", "要", "该", "应", "被", "让", "使",
  "可以", "应该", "可能", "必须",
  // 连词
  "和", "与", "或", "但", "而", "及", "以及", "还是",
  "虽然", "但是", "因为", "所以", "如果", "虽", "然而", "因此",
  // 介词
  "在", "从", "到", "向", "于", "对", "为", "以", "按", "把",
  // 副词
  "也", "很", "更", "最", "太", "再", "已", "又", "还", "却", "则", "仍",
  "非常", "十分", "极", "挺",
  // 疑问词
  "什么", "怎么", "怎样", "为什么", "哪", "谁", "何", "哪里", "哪个",
  // 语气词
  "吧", "呢", "啊", "哦", "嗯", "嘛", "呀",
  // 高频单字
  "一", "二", "三", "四", "五",
  "中", "上", "下", "内", "外",
  "个", "们", "么",
]);

/**
 * 切词(Jieba HMM 模式),含停用词。多数调用方应使用 `tokenizeContent()`。
 */
export function tokenize(text: string): string[] {
  return getInstance()
    .cut(text, /* hmm= */ true)
    .filter((t: string) => t.trim().length > 0);
}

/**
 * 切词并滤除停用词 —— 索引构建与查询构建的统一入口,
 * 两端一致才能保证 tsvector 与 tsquery 命中同一词元集合。
 */
export function tokenizeContent(text: string): string[] {
  return tokenize(text).filter((t) => !STOP_WORDS.has(t));
}

/**
 * 切词 + 滤停用词 + 空格拼接。结果交给 SQL 的 `to_tsvector('simple', $input)`
 * —— 'simple' 配置把空格分隔的词元原样存储,不做词干化。
 */
export function toTsvectorInput(text: string): string {
  return tokenizeContent(text).join(" ");
}

/**
 * 构建 tsquery AND 串(全部内容词元都要命中),每个词元带 `:*` 前缀匹配。
 * 无内容词元时返回 ""(调用方应跳过该子句)。
 *
 * 例:"宗杭的父亲" → "宗杭:* & 父亲:*";配合 `to_tsquery('simple', $andQuery)`。
 */
export function buildAndTsquery(text: string): string {
  const tokens = tokenizeContent(text);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}:*`).join(" & ");
}

/**
 * 构建 tsquery OR 串(任一内容词元命中即可),词元带 `:*` 前缀匹配。
 * 无内容词元时返回 ""。
 *
 * 例:"宗杭的父亲" → "宗杭:* | 父亲:*";配合 `to_tsquery('simple', $orQuery)`。
 */
export function buildOrTsquery(text: string): string {
  const tokens = tokenizeContent(text);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}:*`).join(" | ");
}
