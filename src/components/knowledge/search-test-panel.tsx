"use client";

/**
 * 检索测试面板 —— KB 详情页的调参/验收工具(spec 决策 3 保留)。
 * 输入问题 + 模式(hybrid / graph / fast)→ searchKnowledgeTestAction →
 * 展示命中块(来源徽标 + 得分 + 摘录)。这也是 step1 检索质量的验收入口。
 */

import { useState } from "react";
import { searchKnowledgeTestAction } from "@/lib/knowledge/actions";

type Mode = "hybrid" | "graph" | "fast";

const MODES: Array<{ key: Mode; label: string; hint: string }> = [
  { key: "hybrid", label: "混合", hint: "向量+关键词+图谱,重排后出结果(默认,质量最好)" },
  { key: "fast", label: "快速", hint: "向量+关键词,跳过图谱与重排(语音线低延迟可选)" },
  { key: "graph", label: "图谱", hint: "纯知识图谱遍历" },
];

const SOURCE_LABEL: Record<string, string> = {
  vector: "向量",
  keyword: "关键词",
  graph: "图谱",
  both: "多路",
};

interface TestItem {
  fileName: string;
  text: string;
  score: number;
  rerankScore: number | null;
  source: string;
}

export function SearchTestPanel({ kbId }: { kbId: string }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("hybrid");
  const [items, setItems] = useState<TestItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (query.trim() === "" || running) return;
    setRunning(true);
    setError(null);
    const startedAt = Date.now();
    const result = await searchKnowledgeTestAction(kbId, query.trim(), mode);
    setElapsedMs(Date.now() - startedAt);
    if (result.ok) {
      setItems(result.items);
    } else {
      setItems(null);
      setError(result.error);
    }
    setRunning(false);
  }

  return (
    <section className="mt-10 pb-8">
      <h2 className="text-sm font-semibold text-[#1A1A1A]">检索测试</h2>
      <p className="mt-1 text-xs text-[#A4A097]">{MODES.find((m) => m.key === mode)?.hint}</p>

      <div className="mt-3 flex gap-1.5 rounded-lg bg-[#EDECE9] p-1">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMode(m.key)}
            className={`h-9 flex-1 rounded-md text-xs font-medium transition-colors ${
              mode === m.key ? "bg-white text-[#1A1A1A] shadow-sm" : "text-[#787671]"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSearch();
          }}
          placeholder="问一个知识库里有的问题,例如:主角在古墓里发现了什么?"
          className="h-11 min-w-0 flex-1 rounded-lg border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none focus:border-[#5645D4]"
        />
        <button
          type="button"
          onClick={() => void handleSearch()}
          disabled={running || query.trim() === ""}
          className="h-11 shrink-0 rounded-lg bg-[#5645D4] px-4 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] disabled:opacity-50"
        >
          {running ? "检索中…" : "检索"}
        </button>
      </div>

      {error !== null ? <p className="mt-3 text-xs text-[#C0392B]">{error}</p> : null}

      {items !== null ? (
        <div className="mt-4">
          <p className="text-[11px] text-[#A4A097]">
            {items.length} 条结果{elapsedMs !== null ? ` · ${elapsedMs}ms` : ""}
          </p>
          {items.length === 0 ? (
            <p className="mt-2 rounded-lg bg-white px-3 py-4 text-center text-xs text-[#A4A097]">
              没有命中 —— 检查分块是否完成,或换个问法
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {items.map((item, i) => (
                <li key={i} className="rounded-lg bg-white p-3 shadow-sm">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-medium text-[#1A1A1A]">《{item.fileName}》</span>
                    <span className="shrink-0 text-[#A4A097]">
                      {SOURCE_LABEL[item.source] ?? item.source}
                      {item.rerankScore !== null ? ` · 重排 ${item.rerankScore.toFixed(3)}` : ` · ${item.score.toFixed(4)}`}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-[#5D5B54]">{item.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
