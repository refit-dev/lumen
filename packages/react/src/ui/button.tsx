import React from "react";
import styled, { css } from "styled-components";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  size?: "default" | "sm" | "lg" | "icon";
  // asChild is not directly supported in this simplified styled-component version
}

const StyledButton = styled.button<ButtonProps>`
  /* Base styles from cva */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px; // gap-2
  white-space: nowrap;
  border-radius: 6px; // rounded-md
  font-size: 14px; // text-sm
  font-weight: 500; // font-medium
  transition: all 0.2s ease-in-out; // transition-all (simplified duration)
  outline: none;

  &:disabled {
    pointer-events: none;
    opacity: 0.5;
  }

  &:focus-visible {
    border-color: #3b82f6; // focus-visible:border-ring (example ring color)
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5); // focus-visible:ring-ring/50
  }

  &[aria-invalid="true"] {
    border-color: #ef4444; // aria-invalid:border-destructive
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2); // aria-invalid:ring-destructive/20
  }

  /* Default Size styles */
  height: 36px; // h-9
  padding: 0 16px; // px-4
  /* Applying py-2 effectively through height and line-height/padding */

  ${(props) => {
    switch (props.variant) {
      case "destructive":
        return css`
          background-color: #ef4444; // bg-destructive
          color: white; // text-white
          box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); // shadow-xs
          &:hover {
            background-color: #dc2626; // hover:bg-destructive/90
          }
          &:focus-visible {
            box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.5); // focus-visible:ring-destructive/20
          }
        `;
      case "outline":
        return css`
          border: 1px solid #e5e7eb; // border
          background-color: white; // bg-background (assuming white for light mode)
          box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); // shadow-xs
          color: #09090b; // default text color
          &:hover {
            background-color: #f3f4f6; // hover:bg-accent
            /* hover:text-accent-foreground - depends on accent text color */
          }
        `;
      case "secondary":
        return css`
          background-color: #f3f4f6; // bg-secondary
          color: #374151; // text-secondary-foreground
          box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); // shadow-xs
          &:hover {
            background-color: #e5e7eb; // hover:bg-secondary/80
          }
        `;
      case "ghost":
        return css`
          background-color: transparent;
          color: #09090b; // default text color
          &:hover {
            background-color: #f3f4f6; // hover:bg-accent
            /* hover:text-accent-foreground */
          }
        `;
      case "link":
        return css`
          color: #3b82f6; // text-primary
          text-decoration: none;
          background-color: transparent;
          &:hover {
            text-decoration: underline;
          }
        `;
      case "default":
      default:
        return css`
          background-color: #5469d4; // bg-primary (using the color from original modal button)
          color: white; // text-primary-foreground
          box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); // shadow-xs
          &:hover {
            background-color: #4759b8; // hover:bg-primary/90 (darkened #5469d4)
          }
        `;
    }
  }}

  ${(props) => {
    switch (props.size) {
      case "sm":
        return css`
          height: 32px; // h-8
          padding: 0 12px; // px-3
          border-radius: 6px; // rounded-md
          gap: 6px; // gap-1.5
        `;
      case "lg":
        return css`
          height: 40px; // h-10
          padding: 0 24px; // px-6
          border-radius: 6px; // rounded-md
        `;
      case "icon":
        return css`
          width: 36px; // size-9
          height: 36px; // size-9
          padding: 0; // Ensure no padding for icon buttons
        `;
      case "default":
      default:
        return css`
          height: 36px; // h-9
          padding: 0 16px; // px-4 py-2 (py handled by height)
        `;
    }
  }}
`;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
      <StyledButton
        className={className}
        variant={variant}
        size={size}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
