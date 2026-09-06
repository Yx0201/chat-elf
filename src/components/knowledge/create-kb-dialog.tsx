"use client";

/**
 * 新建知识库对话框 —— shadcn Dialog(Base UI 底座)承载,表单样式对齐
 * 项目登录页/人格页的既有视觉(非 shadcn 表单控件皮肤)。
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createKnowledgeBaseAction } from "@/lib/knowledge/actions";

export function CreateKnowledgeBaseDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const result = await createKnowledgeBaseAction({ name, description });
    if (result.ok) {
      setOpen(false);
      setName("");
      setDescription("");
      router.push(`/knowledge/${result.kbId}`);
    } else {
      setError(result.error);
    }
    setSubmitting(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button className="h-11 bg-[#5645D4] px-4 font-medium text-white hover:bg-[#4536A8]" />
        }
      >
        新建知识库
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建知识库</DialogTitle>
          <DialogDescription>
            一个知识库放一组相关资料(如同一部小说)。上传后精灵能引用其中的内容回答问题。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-left">
            <span className="text-xs font-medium text-[#5D5B54]">名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如:三线轮回"
              required
              maxLength={60}
              className="h-11 rounded-lg border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none focus:border-[#5645D4]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-left">
            <span className="text-xs font-medium text-[#5D5B54]">描述(可选)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这批资料是关于什么的"
              maxLength={200}
              className="h-11 rounded-lg border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none focus:border-[#5645D4]"
            />
          </label>

          {error !== null ? <p className="text-xs text-[#C0392B]">{error}</p> : null}

          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-10 bg-[#5645D4] px-4 text-white hover:bg-[#4536A8]">
              {submitting ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
