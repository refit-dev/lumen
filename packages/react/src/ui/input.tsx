import React from "react";
import styled from "styled-components";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  // Add any custom props specific to this input if needed in the future
  "aria-invalid"?: boolean;
}

const StyledInput = styled.input<InputProps>`
  display: flex;
  height: 36px; // h-9
  width: 100%;
  min-width: 0;
  border-radius: 6px; // rounded-md
  border: 1px solid #e5e7eb; // border-input (border color from a typical theme)
  background-color: transparent; // bg-transparent
  padding: 8px 12px; // px-3 py-1 (approx)
  font-size: 14px; // text-sm
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); // shadow-xs

  color: #09090b; // text-foreground (typical dark text)

  &::placeholder {
    color: #a1a1aa; // placeholder:text-muted-foreground
  }

  &:focus-visible {
    outline: none;
    border-color: #3b82f6; // focus-visible:border-ring (example ring color)
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5); // focus-visible:ring-ring/50
  }

  &[aria-invalid="true"] {
    border-color: #ef4444; // aria-invalid:border-destructive
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2); // aria-invalid:ring-destructive/20
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  // File input specific styles (base from shadcn)
  &[type="file"] {
    // The following are harder to replicate perfectly without JS or more complex CSS
    // For simplicity, we'll rely on browser default for file input appearance mostly
    // but apply some base styling.
    // file:text-foreground
    // file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium
  }
`;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <StyledInput
        type={type}
        className={className} // Allow consumers to pass additional classes
        ref={ref}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input };
