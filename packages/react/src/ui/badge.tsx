import React from "react";
import styled, { css } from "styled-components";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "destructive" | "outline";
  // asChild is not directly supported in this simplified styled-component version
}

const StyledBadge = styled.span<BadgeProps>`
  /* Base styles */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px; // rounded-md
  border: 1px solid;
  padding: 1px 8px; // px-2 py-0.5
  font-size: 12px; // text-xs
  font-weight: 500; // font-medium
  width: fit-content;
  white-space: nowrap;
  flex-shrink: 0;
  gap: 4px; // gap-1
  transition:
    color 0.1s ease-in-out,
    box-shadow 0.1s ease-in-out,
    background-color 0.1s ease-in-out;
  overflow: hidden;

  /* Focus visible and invalid states (can be themed per variant if needed) */
  &:focus-visible {
    border-color: #3b82f6; // focus-visible:border-ring (example ring color)
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5); // focus-visible:ring-ring/50
  }

  &[aria-invalid="true"] {
    border-color: #ef4444; // aria-invalid:border-destructive
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2); // aria-invalid:ring-destructive/20
  }

  ${(props) => {
    switch (props.variant) {
      case "secondary":
        return css`
          border-color: transparent;
          background-color: #f3f4f6; // bg-secondary
          color: #374151; // text-secondary-foreground
          a&:hover {
            background-color: #e5e7eb; // [a&]:hover:bg-secondary/90
          }
        `;
      case "destructive":
        return css`
          border-color: transparent;
          background-color: #ef4444; // bg-destructive
          color: white; // text-white
          a&:hover {
            background-color: #dc2626; // [a&]:hover:bg-destructive/90
          }
          &:focus-visible {
            box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.5); // focus-visible:ring-destructive/20
          }
        `;
      case "outline":
        return css`
          border-color: #d1d5db; // Default border for outline, can be themed
          color: #09090b; // text-foreground
          background-color: transparent;
          a&:hover {
            background-color: #f3f4f6; // [a&]:hover:bg-accent
            /* [a&]:hover:text-accent-foreground - depends on accent text color */
          }
        `;
      case "default":
      default:
        return css`
          border-color: transparent;
          background-color: #5469d4; // bg-primary (using a common primary color)
          color: white; // text-primary-foreground
          a&:hover {
            background-color: #4759b8; // [a&]:hover:bg-primary/90 (darkened)
          }
        `;
    }
  }}
`;

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", ...props }, ref) => {
    return (
      <StyledBadge
        ref={ref}
        className={className}
        variant={variant}
        {...props}
      />
    );
  }
);
Badge.displayName = "Badge";

export { Badge };
