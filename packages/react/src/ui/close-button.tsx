import React from "react";
import styled from "styled-components";

export interface CloseButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

const StyledButton = styled.button`
  position: absolute;
  top: 1rem;
  right: 1rem;
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
  padding: 0.5rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s ease;
  width: 2rem;
  height: 2rem;
  z-index: 10; // Ensure it's above other card content if necessary

  &:hover {
    background-color: #f5f5f5;
    color: #333;
  }
`;

const CloseButton = React.forwardRef<HTMLButtonElement, CloseButtonProps>(
  ({ className, children = "×", ...props }, ref) => {
    return (
      <StyledButton
        ref={ref}
        className={className}
        aria-label="Close"
        {...props}
      >
        {children}
      </StyledButton>
    );
  }
);

CloseButton.displayName = "CloseButton";

export { CloseButton };
