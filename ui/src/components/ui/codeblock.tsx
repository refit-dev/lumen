"use client";

import { useState, useEffect } from "react";
import { ClipboardIcon, CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { codeToHtml } from "shiki";

export const CodeBlock = ({
  code,
  copyValue,
  language,
  className,
}: {
  code: string;
  copyValue?: string;
  language: string;
  className?: string;
}) => {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    const highlightCode = async () => {
      try {
        const result = await codeToHtml(code, {
          lang: language || "tsx",
          theme: "min-light",
          transformers: [
            {
              pre(node) {
                this.addClassToHast(node, "overflow-x-auto");
                this.addClassToHast(node, "text-sm");
                this.addClassToHast(node, "leading-relaxed");
                this.addClassToHast(node, "w-full");
                this.addClassToHast(node, "max-w-full");
              },
            },
          ],
        });
        setHtml(result);
      } catch (error) {
        // Fallback to plain text if language is not supported
        console.warn(
          `Failed to highlight code for language "${language}":`,
          error
        );
        setHtml(
          `<pre class="overflow-x-auto w-full max-w-full text-sm leading-relaxed"><code>${code}</code></pre>`
        );
      }
    };

    highlightCode();
  }, [code, language]);

  const handleCopy = () => {
    const textToCopy = copyValue || code;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "relative w-full max-w-full min-w-0 rounded-2xl bg-gray-50/30 border border-gray-200/50 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden",
        className
      )}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-slate-100/90 to-gray-200/60 border-b border-slate-300/40 backdrop-blur-sm">
        <div className="flex items-center space-x-1.5">
          <div className="w-2.5 h-2.5 bg-red-400/70 rounded-full shadow-sm"></div>
          <div className="w-2.5 h-2.5 bg-amber-400/70 rounded-full shadow-sm"></div>
          <div className="w-2.5 h-2.5 bg-emerald-400/70 rounded-full shadow-sm"></div>
        </div>
        <div className="flex items-center space-x-2.5">
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
            {language}
          </span>
          <button
            onClick={handleCopy}
            className="group flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/90 hover:bg-white border border-slate-300/50 hover:border-slate-400/60 transition-all duration-200 shadow-sm hover:shadow-md backdrop-blur-sm"
            aria-label="Copy code"
          >
            {copied ? (
              <>
                <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                <span className="text-xs font-semibold text-emerald-700">
                  Copied!
                </span>
              </>
            ) : (
              <>
                <ClipboardIcon className="h-3.5 w-3.5 text-slate-600 group-hover:text-slate-800" />
                <span className="text-xs font-semibold text-slate-600 group-hover:text-slate-800">
                  Copy
                </span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code content */}
      <div className="p-6">
        <div
          className="w-full max-w-full overflow-x-auto"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {html ? (
            <div
              dangerouslySetInnerHTML={{ __html: html }}
              className="[&>pre]:!bg-transparent [&>pre]:!m-0 [&>pre]:!p-0 [&>pre]:!border-0 [&>pre]:!rounded-0 [&>pre]:!w-full [&>pre]:!max-w-full [&>pre]:!overflow-x-auto"
            />
          ) : (
            <pre className="overflow-x-auto w-full max-w-full text-sm leading-relaxed text-gray-800">
              <code>{code}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
