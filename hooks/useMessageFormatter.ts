import { useEffect } from 'react';
import { marked } from 'marked';

interface GapAnalysisResponse {
  gap_analysis_summary?: string;
  gaps?: string[];
  recommendations?: string[] | string;
  updated_file?: string;
}

const formatGapAnalysisMessage = (content: string): string => {
  try {
    const data = JSON.parse(content) as GapAnalysisResponse;
    const parts: string[] = [];

    if (data.gap_analysis_summary) {
      parts.push(data.gap_analysis_summary);
    }

    if (data.gaps && Array.isArray(data.gaps)) {
      parts.push("**Identified Gaps:**");
      parts.push(data.gaps.map(gap => `• ${gap}`).join("\n"));
    }

    if (data.recommendations) {
      parts.push("**Recommendations:**");
      if (Array.isArray(data.recommendations)) {
        parts.push(data.recommendations.map(rec => `• ${rec}`).join("\n"));
      } else {
        parts.push(data.recommendations);
      }
    }

    if (data.updated_file) {
      parts.push(`[📄 Download Updated File](${data.updated_file})`);
    }

    return parts.join("\n").trim();
  } catch {
    return content;
  }
};

export function useMessageFormatter() {
  useEffect(() => {
    // Deep-query helpers to traverse Shadow DOMs
    const collectRoots = (): Array<Document | ShadowRoot> => {
      const roots: Array<Document | ShadowRoot> = [];
      const hosts = Array.from(document.querySelectorAll('openai-chatkit')) as Array<HTMLElement & { shadowRoot?: ShadowRoot | null }>;
      const seen = new Set<ShadowRoot>();
      const pushRoot = (root: Document | ShadowRoot | null | undefined) => {
        if (!root) return;
        if ((root as Document).nodeType === Node.DOCUMENT_NODE) {
          roots.push(root as Document);
          return;
        }
        const sr = root as ShadowRoot;
        if (!seen.has(sr)) {
          seen.add(sr);
          roots.push(sr);
        }
      };
      const traverse = (root: Document | ShadowRoot) => {
        const walker = document.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode as Element | null;
        while (node) {
          const el = node as Element & { shadowRoot?: ShadowRoot | null };
          if (el.shadowRoot && !seen.has(el.shadowRoot)) {
            pushRoot(el.shadowRoot);
            traverse(el.shadowRoot);
          }
          node = walker.nextNode() as Element | null;
        }
      };
      if (hosts.length === 0) {
        // Fallback to whole document if no custom element detected
        roots.push(document);
        traverse(document);
      } else {
        for (const host of hosts) {
          pushRoot(host.shadowRoot);
          if (host.shadowRoot) traverse(host.shadowRoot);
        }
      }
      return roots;
    };

    const isLikelyJson = (text: string): boolean => {
      const t = text.trim();
      return t.startsWith('{') && t.endsWith('}') && /\"(gap_analysis_summary|gaps|recommendations|updated_file)\"/.test(t);
    };

    const queryAssistantMessagesDeep = (): Element[] => {
      const roots = collectRoots();
      const results: Element[] = [];
      for (const root of roots) {
        // Prefer explicit assistant message containers
        try {
          results.push(
            ...Array.from(root.querySelectorAll('[data-message-role="assistant"]'))
          );
        } catch {
          // ignore
        }
      }
      // Also scan all elements for likely JSON (covers non-leaf structures)
      for (const root of roots) {
        let nodes: Element[] = [];
        try {
          nodes = Array.from(root.querySelectorAll('*')) as Element[];
        } catch {
          nodes = [];
        }
        for (const el of nodes) {
          const htmlEl = el as HTMLElement;
          if (htmlEl.dataset?.renderedMd === '1') continue;
          const text = el.textContent?.trim();
          if (!text) continue;
          // basic bounds to avoid huge outer containers
          if (text.length < 8 || text.length > 20000) continue;
          if (!text.includes('{') || !text.includes('}')) continue;
          if (isLikelyJson(text)) {
            results.push(el);
          }
        }
      }
      // Deduplicate
      return Array.from(new Set(results));
    };

    const formatMessages = () => {
      const messages = queryAssistantMessagesDeep();
      messages.forEach((message) => {
        const content = message.textContent;
        if (!content) return;
        // If it's JSON, format to Markdown first; otherwise, treat as Markdown already
        let formatted = content;
        let wasJson = false;
        try {
          // JSON path
          JSON.parse(content);
          formatted = formatGapAnalysisMessage(content);
          wasJson = true;
        } catch {
          // Non-JSON path: keep as-is for Markdown conversion
        }
        // Convert Markdown to HTML
        let html = marked.parse(formatted);
        if (typeof html !== 'string') {
          html = String(html ?? '');
        }
        // Simple sanitization for anchors to ensure target and rel attributes
        html = html.replace(/<a\s+href=("[^"]*"|'[^']*'|[^\s>]+)([^>]*)>/gi, (_m, href, rest) => {
          const hasTarget = /target=/i.test(rest);
          const hasRel = /rel=/i.test(rest);
          const extra = `${hasTarget ? '' : ' target="_blank"'}${hasRel ? '' : ' rel="noopener noreferrer"'}`;
          return `<a href=${href}${rest}${extra}>`;
        });
        // If the formatted message contains a file link, add a download button
        const match = /\[📄 Download Updated File\]\(([^)]+)\)/.exec(formatted);
        if (match && match[1]) {
          const fileUrl = match[1];
          // Create a download button
          const buttonHtml = `<a href="${fileUrl}" download class="inline-block mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">Download Updated File</a>`;
          html += `<div>${buttonHtml}</div>`;
        }
        if (typeof html === 'string' && message.innerHTML !== html) {
          message.innerHTML = html;
          if (wasJson) (message as HTMLElement).dataset.renderedMd = '1';
        }
      });
    };

    // Create an observer instance
    const observers = new Set<MutationObserver>();
    const observedRoots = new Set<Node>();

    const attachObserver = (root: Document | ShadowRoot) => {
      if (observedRoots.has(root)) return;
      const observer = new MutationObserver(() => {
        formatMessages();
        // On any mutation, rescan for new shadow roots and attach
        scanAndAttach();
      });
      observer.observe(root, { childList: true, subtree: true });
      observers.add(observer);
      observedRoots.add(root);
    };

    const scanAndAttach = () => {
      const roots = collectRoots();
      roots.forEach((r) => attachObserver(r));
    };

    // Initial attach and format
    scanAndAttach();
    formatMessages();

    // Cleanup
    return () => {
      observers.forEach((o) => o.disconnect());
      observers.clear();
      observedRoots.clear();
    };
  }, []);
}