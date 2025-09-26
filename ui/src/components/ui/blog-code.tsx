import { ReactNode } from "react";

interface BlogCodeProps {
  children: ReactNode;
}

export const BlogCode = ({ children }: BlogCodeProps) => {
  return (
    <code className="px-1.5 py-0.5 bg-gray-100 text-gray-800 rounded text-sm font-mono">
      {children}
    </code>
  );
};
