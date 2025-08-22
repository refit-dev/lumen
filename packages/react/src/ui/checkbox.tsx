import React from "react";
import styled from "styled-components";

interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  // For onCheckedChange, shadcn/Radix typically provides (checked: boolean | 'indeterminate')
  // For a native input, onChange will give React.ChangeEvent<HTMLInputElement>
  // We'll stick to standard HTML input props here for simplicity.
  // If onCheckedChange behavior is crucial, it needs more complex handling.
  "aria-invalid"?: boolean;
}

const StyledCheckboxInput = styled.input.attrs({
  type: "checkbox",
})<CheckboxProps>`
  /* Base styles */
  appearance: none;
  width: 16px; // size-4
  height: 16px; // size-4
  border-radius: 4px; // rounded-[4px]
  border: 1px solid #e5e7eb; // border-input (example)
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); // shadow-xs
  transition:
    box-shadow 0.1s ease-in-out,
    background-color 0.1s ease-in-out,
    border-color 0.1s ease-in-out;
  outline: none;
  cursor: pointer;

  /* Checked state styles */
  &:checked {
    background-color: #3b82f6; // data-[state=checked]:bg-primary (example primary)
    border-color: #3b82f6; // data-[state=checked]:border-primary
    position: relative; // For custom checkmark positioning if added later
  }

  /* Custom checkmark (simple version) - uncomment and style if needed */
  &:checked::before {
    content: "\2713"; // Unicode check character
    display: block;
    color: white; // data-[state=checked]:text-primary-foreground
    font-size: 12px; // size-3.5 approx
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  /* Focus visible styles */
  &:focus-visible {
    border-color: #3b82f6; // focus-visible:border-ring (example ring color)
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5); // focus-visible:ring-ring/50
  }

  /* Invalid state styles */
  &[aria-invalid="true"] {
    border-color: #ef4444; // aria-invalid:border-destructive
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2); // aria-invalid:ring-destructive/20
  }

  /* Disabled state styles */
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => {
    return <StyledCheckboxInput ref={ref} className={className} {...props} />;
  }
);

Checkbox.displayName = "Checkbox";

export { Checkbox };
