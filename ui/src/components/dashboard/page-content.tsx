"use client";

import { ReactNode, useEffect } from "react";
import { usePageTitle } from "./page-title-context";

interface PageContentProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

export function PageContent({
  title,
  description,
  actions,
  children,
}: PageContentProps) {
  const { setTitle } = usePageTitle();

  useEffect(() => {
    setTitle(title);
  }, [title, setTitle]);

  return (
    <div className="space-y-6 font-sans">
      {(description || actions) && (
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          {description && (
            <p className="text-muted-foreground text-base">{description}</p>
          )}
          {actions && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center md:ml-auto">
              {actions}
            </div>
          )}
        </div>
      )}

      {children}
    </div>
  );
}
