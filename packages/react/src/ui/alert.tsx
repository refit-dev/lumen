import React from "react";
import styled, { css } from "styled-components";

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "destructive";
}

const StyledAlert = styled.div<AlertProps>`
  position: relative;
  width: 100%;
  border-radius: 8px; // rounded-lg
  border: 1px solid;
  padding: 12px 16px; // px-4 py-3
  font-size: 14px; // text-sm
  display: grid;
  /* Simplified grid layout - assuming no icon for now for self-contained version */
  /* If an icon (SVG) is passed as a child, more complex styling would be needed */
  /* grid-cols-[0_1fr] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] */
  /* has-[>svg]:gap-x-3 gap-y-0.5 items-start */
  gap: 2px; // gap-y-0.5 (simplified)
  align-items: start;

  ${(props) => {
    switch (props.variant) {
      case "destructive":
        return css`
          border-color: #fca5a5; // border-destructive (lighter for border)
          background-color: #fee2e2; // bg-card (destructive theme often has light red bg)
          color: #b91c1c; // text-destructive
          /* [&>svg]:text-current */
          /* *:data-[slot=alert-description]:text-destructive/90 - handled in AlertDescription */
        `;
      case "default":
      default:
        return css`
          border-color: #e5e7eb; // border (default theme)
          background-color: #ffffff; // bg-card (default theme)
          color: #09090b; // text-card-foreground (default theme)
        `;
    }
  }}
`;

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = "default", ...props }, ref) => {
    return (
      <StyledAlert
        ref={ref}
        className={className}
        variant={variant}
        role="alert"
        {...props}
      />
    );
  }
);
Alert.displayName = "Alert";

const StyledAlertTitle = styled.div`
  /* col-start-2 (simplified - assumes no icon column or handled by parent grid if icon added) */
  /* line-clamp-1 (difficult to replicate perfectly with pure CSS, use with caution or JS) */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-height: 16px; // min-h-4
  font-weight: 500; // font-medium
  letter-spacing: -0.025em; // tracking-tight (approx)
`;

const AlertTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledAlertTitle ref={ref} className={className} {...props} />;
});
AlertTitle.displayName = "AlertTitle";

const StyledAlertDescription = styled.div<{ $isDestructive?: boolean }>`
  /* col-start-2 (simplified) */
  display: grid;
  justify-items: start;
  gap: 4px; // gap-1
  font-size: 14px; // text-sm
  color: ${(props) =>
    props.$isDestructive
      ? "#ef4444"
      : "#71717a"}; // text-muted-foreground or text-destructive/90

  & p {
    line-height: 1.625; // leading-relaxed
  }
`;

const AlertDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "destructive" }
>(({ className, variant, ...props }, ref) => {
  return (
    <StyledAlertDescription
      ref={ref}
      className={className}
      $isDestructive={variant === "destructive"}
      {...props}
    />
  );
});
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
